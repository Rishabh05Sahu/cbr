// Notifications module (Phase 2 M3): in-app notification centre (FR-118) fed by outbox events
// (FR-075 assignment, returning enquiries), with digests for bulk operations (FR-120).
//
// Rows are written only by the worker under a system actor (RLS: no app.user_id), one per
// (outbox event, recipient), so a redelivered event changes nothing. Members read and mark only
// their own notifications (RLS restricts SELECT/UPDATE to the recipient as well).
import { z } from 'zod';
import type { RequestContext } from '@/platform/authz';
import { tenantRunner, type Tx } from '@/platform/db';
import { notFound } from '@/platform/errors';

export interface NotificationView {
  id: string;
  type: string;
  title: string;
  body: string;
  link: string | null;
  readAt: Date | null;
  createdAt: Date;
}

const PAGE = 30;

export async function listNotifications(
  ctx: RequestContext,
  opts: { cursor?: string | undefined } = {},
): Promise<{ rows: NotificationView[]; nextCursor: string | null }> {
  if (ctx.kind !== 'member') return { rows: [], nextCursor: null };
  const cursor = z.uuid().safeParse(opts.cursor);
  return tenantRunner().withTenant(ctx.tenant, async (tx) => {
    const rows = await tx.notification.findMany({
      where: {
        recipientUserId: ctx.userId,
        ...(cursor.success ? { id: { lt: cursor.data } } : {}),
      },
      // UUIDv7 ids are time-ordered and unique: a stable keyset.
      orderBy: { id: 'desc' },
      take: PAGE + 1,
      select: {
        id: true,
        type: true,
        title: true,
        body: true,
        link: true,
        readAt: true,
        createdAt: true,
      },
    });
    const page = rows.slice(0, PAGE);
    return { rows: page, nextCursor: rows.length > PAGE ? page[page.length - 1]!.id : null };
  });
}

export async function unreadCount(ctx: RequestContext): Promise<number> {
  if (ctx.kind !== 'member') return 0;
  return tenantRunner().withTenant(ctx.tenant, (tx) =>
    tx.notification.count({ where: { recipientUserId: ctx.userId, readAt: null } }),
  );
}

/** Another member's notification is "not found", like a missing one. */
export async function markRead(ctx: RequestContext, notificationId: string): Promise<void> {
  if (ctx.kind !== 'member') throw notFound('Notification not found');
  const id = z.uuid().safeParse(notificationId);
  if (!id.success) throw notFound('Notification not found');
  await tenantRunner().withTenant(ctx.tenant, async (tx) => {
    const n = await tx.notification.findFirst({
      where: { id: id.data, recipientUserId: ctx.userId },
      select: { readAt: true },
    });
    if (!n) throw notFound('Notification not found');
    if (n.readAt) return;
    await tx.notification.updateMany({
      where: { id: id.data, recipientUserId: ctx.userId, readAt: null },
      data: { readAt: new Date() },
    });
  });
}

export async function markAllRead(ctx: RequestContext): Promise<number> {
  if (ctx.kind !== 'member') return 0;
  return tenantRunner().withTenant(ctx.tenant, async (tx) => {
    const r = await tx.notification.updateMany({
      where: { recipientUserId: ctx.userId, readAt: null },
      data: { readAt: new Date() },
    });
    return r.count;
  });
}

// ---------------------------------------------------------------------------------------------
// Worker side: outbox event → notifications

const assignedPayload = z.object({
  leadIds: z.array(z.uuid()).min(1).max(1000),
  toUserId: z.uuid().nullable(),
  teamId: z.uuid().nullable(),
  previousOwners: z.array(z.object({ userId: z.uuid(), count: z.number().int().min(1) })),
  actorUserId: z.uuid().nullable(),
  source: z.string(),
});

const returningPayload = z.object({
  leadId: z.uuid(),
  enquiryId: z.uuid(),
  actorUserId: z.uuid().nullable(),
});

interface NewNotification {
  recipientUserId: string;
  type:
    | 'LEAD_ASSIGNED'
    | 'LEADS_ASSIGNED_DIGEST'
    | 'LEADS_REASSIGNED_AWAY'
    | 'LEAD_RETURNING_ENQUIRY'
    | 'IMPORT_FINISHED'
    | 'TASK_ASSIGNED'
    | 'MEETING_INVITED'
    | 'TASK_REMINDER'
    | 'VISIT_REMINDER';
  title: string;
  body: string;
  link: string | null;
  data: Record<string, string | number>;
}

const clip = (s: string, n: number) => (s.length > n ? `${s.slice(0, n - 1)}…` : s);
const plural = (n: number, one: string, many: string) => (n === 1 ? one : many);

async function activeMembers(tx: Tx, userIds: string[]): Promise<Set<string>> {
  if (!userIds.length) return new Set();
  const rows = await tx.member.findMany({
    where: { userId: { in: userIds }, status: 'ACTIVE' },
    select: { userId: true },
  });
  return new Set(rows.map((r) => r.userId));
}

/**
 * Builds the notifications for one outbox event from the state at handling time: a lead
 * reassigned again (or closed) before the worker ran is not announced to someone who no longer
 * owns it; inactive members and the actor themself are never notified.
 */
async function build(tx: Tx, type: string, payload: unknown): Promise<NewNotification[]> {
  if (type === 'lead.assigned') {
    const p = assignedPayload.parse(payload);
    const out: NewNotification[] = [];
    const active = await activeMembers(tx, [
      ...(p.toUserId ? [p.toUserId] : []),
      ...p.previousOwners.map((o) => o.userId),
    ]);
    if (p.toUserId && p.toUserId !== p.actorUserId && active.has(p.toUserId)) {
      const still = await tx.lead.findMany({
        where: { id: { in: p.leadIds }, ownerUserId: p.toUserId, deletedAt: null },
        orderBy: { id: 'asc' },
        select: { id: true, fullName: true },
      });
      if (still.length === 1)
        out.push({
          recipientUserId: p.toUserId,
          type: 'LEAD_ASSIGNED',
          title: 'Lead assigned to you',
          body: clip(still[0]!.fullName, 200),
          link: `/app/leads/${still[0]!.id}`,
          data: { leadId: still[0]!.id },
        });
      else if (still.length > 1)
        out.push({
          recipientUserId: p.toUserId,
          type: 'LEADS_ASSIGNED_DIGEST',
          title: `${still.length} leads assigned to you`,
          body: 'Open your leads to see them.',
          link: '/app/leads',
          data: { count: still.length },
        });
    }
    // Previous owners may have lost access: a count only, no names or links (Workflow G §4).
    for (const o of p.previousOwners)
      if (o.userId !== p.actorUserId && o.userId !== p.toUserId && active.has(o.userId))
        out.push({
          recipientUserId: o.userId,
          type: 'LEADS_REASSIGNED_AWAY',
          title: plural(o.count, 'A lead was reassigned', `${o.count} leads were reassigned`),
          body: plural(
            o.count,
            'A lead you owned now has a different owner.',
            `${o.count} leads you owned now have a different owner.`,
          ),
          link: null,
          data: { count: o.count },
        });
    return out;
  }
  if (type === 'lead.enquiry_returned') {
    const p = returningPayload.parse(payload);
    const lead = await tx.lead.findFirst({
      where: { id: p.leadId, deletedAt: null, stage: { notIn: ['WON', 'LOST'] } },
      select: { id: true, fullName: true, ownerUserId: true },
    });
    // Unassigned (queue) leads have no single owner to tell; the queue shows them.
    if (!lead?.ownerUserId || lead.ownerUserId === p.actorUserId) return [];
    if (!(await activeMembers(tx, [lead.ownerUserId])).has(lead.ownerUserId)) return [];
    return [
      {
        recipientUserId: lead.ownerUserId,
        type: 'LEAD_RETURNING_ENQUIRY',
        title: 'Returning enquiry',
        body: `${clip(lead.fullName, 200)} enquired again.`,
        link: `/app/leads/${lead.id}`,
        data: { leadId: lead.id },
      },
    ];
  }
  if (type === 'import.finished') {
    const p = importFinishedPayload.parse(payload);
    const job = await tx.importJob.findFirst({
      where: { id: p.importJobId },
      select: {
        id: true,
        createdBy: true,
        status: true,
        dryRun: true,
        rowsValid: true,
        rowsInvalid: true,
        rowsDuplicateInFile: true,
        rowsCreated: true,
        rowsAttached: true,
        rowsSkipped: true,
        rowsFailed: true,
      },
    });
    // Only a genuinely finished job, and only its creator while still an active member.
    if (!job || !importFinishedText(job)) return [];
    if (!(await activeMembers(tx, [job.createdBy])).has(job.createdBy)) return [];
    const text = importFinishedText(job)!;
    return [
      {
        recipientUserId: job.createdBy,
        type: 'IMPORT_FINISHED',
        ...text,
        link: `/app/leads/import/${job.id}`,
        data: { importJobId: job.id, status: job.status },
      },
    ];
  }
  if (type === 'task.assigned') {
    const p = taskAssignedPayload.parse(payload);
    // Only a task still open and still the assignee's, an active member who is not the actor.
    const task = await tx.task.findFirst({
      where: { id: p.taskId, status: 'OPEN', assigneeUserId: p.assigneeUserId },
      select: { id: true, type: true, title: true, leadId: true },
    });
    if (!task || p.assigneeUserId === p.actorUserId) return [];
    if (!(await activeMembers(tx, [p.assigneeUserId])).has(p.assigneeUserId)) return [];
    const kind = TASK_TYPE_NAMES[task.type] ?? 'Task';
    return [
      {
        recipientUserId: p.assigneeUserId,
        type: 'TASK_ASSIGNED',
        title: task.type === 'FOLLOW_UP' ? 'Follow-up assigned to you' : 'Task assigned to you',
        // The task's own title (written by a colleague for the assignee); no lead details.
        body: clip(task.title ? `${kind}: ${task.title}` : kind, 200),
        link: task.leadId ? `/app/leads/${task.leadId}` : '/app/my-day',
        data: { taskId: task.id },
      },
    ];
  }
  if (type === 'meeting.invited') {
    const p = meetingInvitedPayload.parse(payload);
    // Only people still invited to a still-open meeting, active, and not the actor. The link is My
    // Day (where attendees see it), never the lead: an invitation gives no lead access.
    const task = await tx.task.findFirst({
      where: { id: p.taskId, type: 'MEETING', status: 'OPEN' },
      select: {
        id: true,
        title: true,
        attendees: {
          where: { userId: { in: p.userIds }, removedAt: null },
          select: { userId: true },
        },
      },
    });
    if (!task) return [];
    const invited = task.attendees.map((x) => x.userId).filter((u) => u !== p.actorUserId);
    const active = await activeMembers(tx, invited);
    return invited
      .filter((u) => active.has(u))
      .map((recipientUserId) => ({
        recipientUserId,
        type: 'MEETING_INVITED' as const,
        title: 'You are invited to a meeting',
        body: clip(`Meeting: ${task.title ?? 'Meeting'}`, 200),
        link: '/app/my-day',
        data: { taskId: task.id },
      }));
  }
  if (type === 'task.reminder_due') {
    const p = reminderPayload.parse(payload);
    // FR-106: only a task still open, still due at the time this reminder was for (a reschedule
    // makes it stale: the new due time gets its own reminder), and not yet due. The recipient is
    // the task's CURRENT assignee (after a handover, the new one), if active. Attendees are not
    // reminded (not specified; ADR-0019).
    const task = await tx.task.findFirst({
      where: { id: p.taskId, status: 'OPEN', dueAt: new Date(p.dueAt) },
      select: {
        id: true,
        type: true,
        title: true,
        leadId: true,
        dueAt: true,
        assigneeUserId: true,
      },
    });
    if (!task || task.dueAt.getTime() <= Date.now()) return [];
    if (!(await activeMembers(tx, [task.assigneeUserId])).has(task.assigneeUserId)) return [];
    const { timeZone } = await tx.organization.findFirstOrThrow({ select: { timeZone: true } });
    const at = task.dueAt.toLocaleTimeString('en-IN', {
      hour: 'numeric',
      minute: '2-digit',
      timeZone,
    });
    const kind = TASK_TYPE_NAMES[task.type] ?? 'Task';
    return [
      {
        recipientUserId: task.assigneeUserId,
        type: 'TASK_REMINDER',
        title: `Reminder: ${kind.toLowerCase()} at ${at}`,
        body: clip(task.title ? `${kind}: ${task.title}` : kind, 200),
        link: task.leadId ? `/app/leads/${task.leadId}` : '/app/my-day',
        data: { taskId: task.id, dueAt: task.dueAt.toISOString() },
      },
    ];
  }
  if (type === 'site_visit.reminder_due') {
    const p = visitReminderPayload.parse(payload);
    // FR-150: only an open visit still at the time this reminder was for (a reschedule makes it
    // stale), not yet due, for a recipient who is still its assignee or scheduler and active. The
    // text names the time and meeting point only; the link is the visits page (an assigned agent
    // may not have access to the lead).
    const v = await tx.siteVisit.findFirst({
      where: {
        id: p.siteVisitId,
        status: { in: ['SCHEDULED', 'CONFIRMED', 'RESCHEDULED'] },
        scheduledFor: new Date(p.scheduledFor),
      },
      select: {
        id: true,
        scheduledFor: true,
        locationText: true,
        assignedUserId: true,
        scheduledBy: true,
      },
    });
    if (!v || v.scheduledFor.getTime() <= Date.now()) return [];
    if (p.recipientUserId !== v.assignedUserId && p.recipientUserId !== v.scheduledBy) return [];
    if (!(await activeMembers(tx, [p.recipientUserId])).has(p.recipientUserId)) return [];
    const { timeZone } = await tx.organization.findFirstOrThrow({ select: { timeZone: true } });
    const at = v.scheduledFor.toLocaleTimeString('en-IN', {
      hour: 'numeric',
      minute: '2-digit',
      timeZone,
    });
    return [
      {
        recipientUserId: p.recipientUserId,
        type: 'VISIT_REMINDER',
        title: `Site visit at ${at}`,
        body: clip(`Meeting point: ${v.locationText}`, 200),
        link: '/app/visits',
        data: { siteVisitId: v.id, scheduledFor: v.scheduledFor.toISOString() },
      },
    ];
  }
  throw new Error(`not a notification event: ${type}`);
}

const importFinishedPayload = z.object({ importJobId: z.uuid() });

const taskAssignedPayload = z.object({
  taskId: z.uuid(),
  assigneeUserId: z.uuid(),
  actorUserId: z.uuid(),
});

const meetingInvitedPayload = z.object({
  taskId: z.uuid(),
  userIds: z.array(z.uuid()).min(1).max(100),
  actorUserId: z.uuid(),
});

const reminderPayload = z.object({
  taskId: z.uuid(),
  offsetMinutes: z.number().int().positive(),
  dueAt: z.iso.datetime({ offset: true }),
  fireAt: z.iso.datetime({ offset: true }),
});

const visitReminderPayload = z.object({
  siteVisitId: z.uuid(),
  recipientUserId: z.uuid(),
  scheduledFor: z.iso.datetime({ offset: true }),
});

const TASK_TYPE_NAMES: Record<string, string> = {
  FOLLOW_UP: 'Follow-up',
  CALL: 'Call',
  MEETING: 'Meeting',
  DOCUMENT: 'Document',
  OTHER: 'Other',
};

/**
 * Title and body for a finished import: outcome and counts only (no file name, row contents,
 * contact details or error details; the import page explains). Null for an unfinished job.
 */
export function importFinishedText(j: {
  status: string;
  dryRun: boolean;
  rowsValid: number;
  rowsInvalid: number;
  rowsDuplicateInFile: number;
  rowsCreated: number;
  rowsAttached: number;
  rowsSkipped: number;
  rowsFailed: number;
}): { title: string; body: string } | null {
  const n = (x: number) => x.toLocaleString('en-IN');
  if (j.status === 'FAILED')
    return {
      title: 'Your import failed',
      body: 'No further rows will be imported. Open the import for the reason and next steps.',
    };
  if (j.status !== 'COMPLETED' && j.status !== 'COMPLETED_WITH_ERRORS') return null;
  if (j.dryRun)
    return {
      title: 'Your dry run finished',
      body: `${n(j.rowsValid)} ${plural(j.rowsValid, 'row', 'rows')} would be imported; ${n(j.rowsInvalid)} ${plural(j.rowsInvalid, 'needs', 'need')} attention. Nothing was changed.`,
    };
  const done = `${n(j.rowsCreated)} new, ${n(j.rowsAttached)} added to existing leads${j.rowsSkipped ? `, ${n(j.rowsSkipped)} skipped` : ''}.`;
  if (j.status === 'COMPLETED') return { title: 'Your import finished', body: done };
  const attention = j.rowsInvalid + j.rowsFailed;
  return {
    title: 'Your import finished with problems',
    body: `${done} ${n(attention)} ${plural(attention, 'row needs', 'rows need')} attention.`,
  };
}

/** Worker entry point. Idempotent: (event_id, recipient) is unique and duplicates are skipped. */
export async function notifyForEvent(job: {
  eventId: string;
  orgId: string;
  type: string;
  payload: unknown;
}): Promise<'notified' | 'skipped'> {
  const eventId = z.uuid().parse(job.eventId);
  return tenantRunner().withTenant({ orgId: job.orgId, userId: null }, async (tx) => {
    const items = await build(tx, job.type, job.payload);
    if (!items.length) return 'skipped';
    await tx.notification.createMany({
      data: items.map((n) => ({ ...n, orgId: job.orgId, eventId })),
      skipDuplicates: true,
    });
    return 'notified';
  });
}
