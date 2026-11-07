// Meeting details (FR-104, ADR-0017; migration 0022): end time, "location or link" and internal
// attendees of a MEETING task, and the overlap warning ("Overlap warning for same user"). Used by
// the tasks module inside its transactions; nothing here authorises on its own.
//
// Owner decisions 2026-10-30: the end is required for new meetings and when details are edited;
// any active member of the org may be invited (an invitation gives no lead access); attendees see
// the meeting read-only on their My Day and get one in-app notification per meeting.
import { z } from 'zod';
import { parseOrgLocal } from '@/modules/leads';
import type { RequestContext } from '@/platform/authz';
import type { Tx } from '@/platform/db';
import { DomainError } from '@/platform/errors';
import { emitEvent } from '@/platform/outbox';
import { MAX_ATTENDEES, meetingEndProblem, meetingsOverlap } from './follow-up-rules';

const invalid = (fieldErrors: Record<string, string[]>) =>
  new DomainError('VALIDATION_FAILED', 'Please check the highlighted fields', fieldErrors);

const oneLine = (max: number) =>
  z
    .string()
    .transform((s) =>
      s
        .replace(/[\u0000-\u001F\u007F]/g, ' ')
        .replace(/\s+/g, ' ')
        .trim(),
    )
    .pipe(z.string().max(max, `At most ${max} characters`));

/** The meeting fields of a create or edit form (all optional at parse time). */
export const meetingFields = {
  endAt: z.string().max(40).optional(),
  location: oneLine(300).optional(),
  attendeeUserIds: z
    .array(z.string().max(40))
    .max(MAX_ATTENDEES, `At most ${MAX_ATTENDEES} attendees`)
    .optional(),
};
export type MeetingFieldsInput = {
  endAt?: string | undefined;
  location?: string | undefined;
  attendeeUserIds?: string[] | undefined;
};

/** Other task types take no meeting fields: refused rather than silently dropped. */
export function refuseMeetingFields(input: MeetingFieldsInput): void {
  const errors: Record<string, string[]> = {};
  if (input.endAt) errors.endAt = ['Only a meeting has an end time'];
  if (input.location) errors.location = ['Only a meeting has a location'];
  if (input.attendeeUserIds?.length) errors.attendeeUserIds = ['Only a meeting has attendees'];
  if (Object.keys(errors).length) throw invalid(errors);
}

/** The validated end (required) and location of a meeting starting at `start`. */
export async function meetingDetails(
  tx: Tx,
  start: Date,
  input: MeetingFieldsInput,
): Promise<{ endAt: Date; location: string | null }> {
  const { timeZone } = await tx.organization.findFirstOrThrow({ select: { timeZone: true } });
  const endAt = input.endAt ? parseOrgLocal(input.endAt, timeZone) : null;
  const problem =
    input.endAt && !endAt ? 'Enter a valid date and time' : meetingEndProblem(start, endAt);
  if (problem) throw invalid({ endAt: [problem] });
  return { endAt: endAt!, location: input.location || null };
}

/**
 * The invited members, distinct: each must be an ACTIVE member of the caller's org (RLS limits the
 * lookup to it) and not the meeting's assignee. Any role may be invited (owner decision).
 */
export async function checkAttendees(
  tx: Tx,
  raw: string[] | undefined,
  assigneeUserId: string,
): Promise<string[]> {
  const ids = [...new Set((raw ?? []).filter((s) => s !== ''))];
  if (!ids.length) return [];
  const bad = (why: string) => invalid({ attendeeUserIds: [why] });
  if (ids.some((id) => !z.uuid().safeParse(id).success)) throw bad('Choose people from the list');
  if (ids.includes(assigneeUserId))
    throw bad('The person the meeting is for is already in it; do not add them as an attendee');
  const found = await tx.member.count({ where: { userId: { in: ids }, status: 'ACTIVE' } });
  if (found !== ids.length) throw bad('Choose active members of your organisation');
  return ids;
}

/** Current (not removed) attendees of a meeting, by user id. */
export async function currentAttendees(tx: Tx, taskId: string): Promise<string[]> {
  const rows = await tx.taskAttendee.findMany({
    where: { taskId, removedAt: null },
    select: { userId: true },
  });
  return rows.map((r) => r.userId);
}

/**
 * Invites and removes attendees (removal is recorded, never deleted) and announces the new ones
 * (outbox event, worker writes MEETING_INVITED). Returns what changed.
 */
export async function setAttendees(
  tx: Tx,
  ctx: RequestContext & { kind: 'member' },
  taskId: string,
  wanted: string[],
): Promise<{ added: string[]; removed: string[] }> {
  const current = await currentAttendees(tx, taskId);
  const added = wanted.filter((u) => !current.includes(u));
  const removed = current.filter((u) => !wanted.includes(u));
  if (removed.length)
    // now() in SQL: the RESTRICTIVE update policy requires the transaction time exactly.
    await tx.$executeRaw`
      UPDATE task_attendee SET removed_at = now(), removed_by = ${ctx.userId}::uuid
       WHERE task_id = ${taskId}::uuid AND removed_at IS NULL AND user_id = ANY(${removed}::uuid[])`;
  if (added.length)
    await tx.taskAttendee.createMany({
      data: added.map((userId) => ({ orgId: ctx.orgId, taskId, userId, addedBy: ctx.userId })),
    });
  const notify = added.filter((u) => u !== ctx.userId);
  if (notify.length)
    await emitEvent(tx, ctx.orgId, {
      type: 'meeting.invited',
      payload: { taskId, userIds: notify, actorUserId: ctx.userId },
    });
  return { added, removed };
}

/**
 * FR-104 "Overlap warning for same user": the assignee's other open meetings (as assignee or
 * current attendee) that overlap this one. A warning only; the save goes ahead. Titles are named
 * only to the assignee themself; for someone else only a count is given, so no-lead meetings stay
 * private (ADR-0016 D2).
 */
export async function overlapWarning(
  tx: Tx,
  ctx: RequestContext & { kind: 'member' },
  meeting: { id: string; assigneeUserId: string; dueAt: Date; endAt: Date | null },
): Promise<string | null> {
  const end = meeting.endAt ?? new Date(meeting.dueAt.getTime() + 60_000);
  const others = await tx.task.findMany({
    where: {
      id: { not: meeting.id },
      type: 'MEETING',
      status: 'OPEN',
      // Candidates start before this one ends; the end check is done below (start-only meetings).
      dueAt: { lt: end, gte: new Date(meeting.dueAt.getTime() - 24 * 3_600_000) },
      OR: [
        { assigneeUserId: meeting.assigneeUserId },
        { attendees: { some: { userId: meeting.assigneeUserId, removedAt: null } } },
      ],
    },
    orderBy: [{ dueAt: 'asc' }, { id: 'asc' }],
    select: { id: true, title: true, dueAt: true, endAt: true },
  });
  const hits = others.filter((o) => meetingsOverlap(o, meeting));
  if (!hits.length) return null;
  if (meeting.assigneeUserId !== ctx.userId)
    return hits.length === 1
      ? 'They already have another meeting at that time.'
      : `They already have ${hits.length} other meetings at that time.`;
  const names = hits.slice(0, 3).map((h) => `“${h.title ?? 'Meeting'}”`);
  return `This overlaps with your meeting${hits.length === 1 ? '' : 's'} ${names.join(', ')}${
    hits.length > 3 ? ` and ${hits.length - 3} more` : ''
  }.`;
}
