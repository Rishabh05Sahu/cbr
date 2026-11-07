// Tasks module (Phase 3): lead follow-ups (FR-100 task base, FR-102 complete / cancel /
// reschedule, FR-108 next follow-up; migration 0012) and the other FR-100 task types (Call,
// Meeting, Document, Other; on a lead or with no lead; ADR-0015, migration 0020), tasks for
// other people (FR-103, ADR-0016, migration 0021) and meeting details (FR-104: end, location,
// attendees, overlap warning; ADR-0017, migration 0022, logic in ./meetings).
//
// Every function authorises first, then reads and writes inside withTenant(), so RLS limits
// rows to the caller's org. Scopes (user-personas-and-roles §4.3):
//   task.read / task.update  ORG: any task · TEAM: tasks on leads in the caller's team scope, or
//                            assigned to them · OWN: tasks assigned to them.
//   task.create              for oneself only in Phase 3 (creating for others is FR-103).
// Creating or changing a task on a lead also needs lead.update on that lead, and the lead must
// be writable (not archived or merged): it is lead work. A task with no lead needs only the task
// grants (HR has them for their own tasks, §4.3). A task outside the caller's scope is reported as
// not found, exactly like one in another org. Actor, org and timestamps come from the server.
//
// FR-108: at most one open follow-up per lead and assignee (task_open_follow_up_uq);
// lead.next_follow_up_at (the earliest open follow-up) is maintained by the database trigger in
// the same transaction. Rescheduling, completing and cancelling are optimistic-locked on the
// task version; a closed task never changes again (task_guard).
import { z } from 'zod';
import { writeAudit } from '@/modules/audit';
import {
  followUpDueRange,
  leadForTask,
  leadScopeFilter,
  parseOrgLocal,
  type TaskLead,
} from '@/modules/leads';
import { ledTeamIds } from '@/modules/teams';
import { memberContextFrom } from '@/platform/auth/member-context';
import { authorize, can, type RequestContext, type Scope } from '@/platform/authz';
import { emitEvent } from '@/platform/outbox';
import { tenantRunner, type Prisma, type Tx } from '@/platform/db';
import { conflict, DomainError, notFound, ruleViolation } from '@/platform/errors';
import {
  compareMyDay,
  dueAtProblem,
  isOverdue,
  meetingsOverlap,
  myDayBucket,
  orgLocalInput,
  rescheduleNeedsReason,
  TASK_PRIORITIES,
  TASK_TYPES,
  type TaskPriority,
  type TaskStatus,
  type TaskType,
} from './follow-up-rules';
import { advanceSeries } from './series';
import {
  calendarPeriod,
  dayKeyIn,
  parseCalendarQuery,
  type CalendarPeriod,
} from './calendar-rules';
import {
  checkAttendees,
  meetingDetails,
  meetingFields,
  overlapWarning,
  refuseMeetingFields,
  setAttendees,
} from './meetings';

export {
  compareMyDay,
  isOverdue,
  MAX_DAYS_AHEAD,
  myDayBucket,
  type MyDayBucket,
  nextFollowUpAt,
  NEW_TASK_TYPES,
  orgLocalInput,
  type NewTaskType,
  MAX_ATTENDEES,
  MEETING_MAX_HOURS,
  meetingEndProblem,
  meetingsOverlap,
  rescheduleNeedsReason,
  TASK_PRIORITIES,
  TASK_TYPE_LABELS,
  TASK_TYPES,
  type TaskPriority,
  type TaskStatus,
  type TaskType,
} from './follow-up-rules';
export {
  addDays,
  CALENDAR_VIEWS,
  calendarPeriod,
  type CalendarPeriod,
  type CalendarView,
  dayKeyIn,
  parseCalendarQuery,
  validDayKey,
  weekday,
} from './calendar-rules';
export { createSeries, listMySeries, stopSeries, updateSeries, type SeriesView } from './series';
export {
  describeSeries,
  nextOccurrence,
  SERIES_FREQUENCIES,
  type SeriesFrequency,
  type SeriesRule,
  WEEKDAY_NAMES,
} from './series-rules';

/** Recent closed tasks of each kind shown on the lead page next to the open ones. */
const CLOSED_SHOWN = 10;

/** One task as the lead page and My Day show it (any type; the name predates FR-100's types). */
export interface FollowUpView {
  id: string;
  type: TaskType;
  title: string | null;
  dueAt: Date;
  priority: TaskPriority;
  status: TaskStatus;
  assigneeUserId: string;
  assigneeName: string | null;
  /** Who created it, when that is not the assignee (FR-103); null otherwise. */
  assignedByName: string | null;
  rescheduleCount: number;
  completedAt: Date | null;
  cancelledAt: Date | null;
  cancelReason: string | null;
  version: number;
  overdue: boolean;
  /** The caller may reschedule, complete or cancel it (and the lead is writable). */
  canUpdate: boolean;
  /** A reschedule now must give a reason (FR-102). */
  rescheduleNeedsReason: boolean;
  /** FR-104, meetings only: end (null for a meeting saved before end times), location. */
  endAt: Date | null;
  location: string | null;
  /** FR-104: current attendees of a meeting (empty for other types). */
  attendees: { userId: string; name: string }[];
  /** The end as a datetime-local value in the org's time zone (the edit form), or null. */
  endAtLocal: string | null;
  /** FR-107: the recurring series this task is an occurrence of, or null. */
  seriesId: string | null;
}

export interface LeadFollowUps {
  /** The lead's next follow-up (FR-108), whoever it is assigned to. */
  nextFollowUpAt: Date | null;
  open: FollowUpView[];
  recentClosed: FollowUpView[];
  /** The caller may schedule a follow-up for themselves on this lead now. */
  canSchedule: boolean;
  /** The caller already has an open follow-up here (reschedule it instead of adding one). */
  hasOwnOpen: boolean;
  /** Why scheduling is not possible, when the caller could otherwise schedule. */
  scheduleBlockedReason: string | null;
  /** The lead's other tasks (Call, Meeting, Document, Other): open first, then recent closed. */
  tasks: FollowUpView[];
  /** The caller may add one of those tasks for themselves on this lead now. */
  canAddTask: boolean;
  /** Why a Call task cannot be added here (Do-Not-Contact lead), or null. */
  callBlockedReason: string | null;
}

function invalid(fieldErrors: Record<string, string[]>): DomainError {
  return new DomainError('VALIDATION_FAILED', 'Please check the highlighted fields', fieldErrors);
}

const text = (max: number, msg: string) =>
  z
    .string()
    .transform((s) =>
      s
        .replace(/[\u0000-\u001F\u007F]/g, ' ')
        .replace(/\s+/g, ' ')
        .trim(),
    )
    .pipe(z.string().max(max, msg));

/** FR-103: another member as the assignee (empty or absent: the caller). */
const assignee = z.string().max(40).optional();
const scheduleInput = z.object({
  dueAt: z.string().max(40),
  title: text(200, 'At most 200 characters').optional(),
  priority: z.enum(TASK_PRIORITIES).optional(),
  assigneeUserId: assignee,
});
const rescheduleInput = z.object({
  dueAt: z.string().max(40),
  reason: text(500, 'At most 500 characters').optional(),
  version: z.coerce.number().int().positive(),
});
// A follow-up is created here too when assigning on a lead page (FR-103); its title stays
// optional, every other type needs one.
const createInput = z
  .object({
    type: z.enum(TASK_TYPES, 'Choose a task type'),
    title: text(200, 'At most 200 characters'),
    dueAt: z.string().max(40),
    priority: z.enum(TASK_PRIORITIES).optional(),
    assigneeUserId: assignee,
    ...meetingFields,
  })
  .refine((v) => v.type === 'FOLLOW_UP' || v.title.length > 0, {
    message: 'Say what the task is',
    path: ['title'],
  });
/** FR-104: a meeting's end, location and attendees (start: reschedule). The end is required. */
const meetingInput = z.object({ ...meetingFields, version: z.coerce.number().int().positive() });
const completeInput = z.object({ version: z.coerce.number().int().positive() });
const cancelInput = z.object({
  reason: text(500, 'At most 500 characters').refine((r) => r.length > 0, {
    message: 'Give a reason for cancelling',
  }),
  version: z.coerce.number().int().positive(),
});

function parseTaskId(id: unknown): string {
  const r = z.uuid().safeParse(id);
  if (!r.success) throw notFound('Task not found');
  return r.data;
}

async function orgDueAt(tx: Tx, raw: string, now: Date): Promise<Date> {
  const { timeZone } = await tx.organization.findFirstOrThrow({ select: { timeZone: true } });
  const dueAt = parseOrgLocal(raw, timeZone);
  const problem = dueAtProblem(dueAt, now);
  if (problem) throw invalid({ dueAt: [problem] });
  return dueAt!;
}

/** Task scope as a filter (§4.3); TEAM includes tasks on leads in the manager's team scope. */
async function taskScopeFilter(
  tx: Tx,
  ctx: RequestContext,
  scope: Scope,
): Promise<Prisma.TaskWhereInput> {
  if (scope === 'ORG') return {};
  if (ctx.kind !== 'member') return { id: { in: [] } };
  if (scope === 'OWN') return { assigneeUserId: ctx.userId };
  return {
    OR: [{ assigneeUserId: ctx.userId }, { lead: await leadScopeFilter(tx, ctx, 'TEAM') }],
  };
}

const VIEW_SELECT = {
  id: true,
  type: true,
  title: true,
  dueAt: true,
  priority: true,
  status: true,
  assigneeUserId: true,
  rescheduleCount: true,
  completedAt: true,
  cancelledAt: true,
  cancelReason: true,
  version: true,
  assignee: { select: { user: { select: { name: true } } } },
  createdBy: true,
  creator: { select: { user: { select: { name: true } } } },
  endAt: true,
  location: true,
  attendees: {
    where: { removedAt: null },
    orderBy: { createdAt: 'asc' },
    select: { userId: true, member: { select: { user: { select: { name: true } } } } },
  },
  seriesId: true,
} satisfies Prisma.TaskSelect;

type TaskRow = Prisma.TaskGetPayload<{ select: typeof VIEW_SELECT }>;

function toView(t: TaskRow, now: Date, canUpdate: boolean, timeZone: string): FollowUpView {
  return {
    id: t.id,
    type: t.type as TaskType,
    title: t.title,
    dueAt: t.dueAt,
    priority: t.priority as TaskPriority,
    status: t.status as TaskStatus,
    assigneeUserId: t.assigneeUserId,
    assigneeName: t.assignee.user.name,
    assignedByName: t.createdBy !== t.assigneeUserId ? t.creator.user.name : null,
    rescheduleCount: t.rescheduleCount,
    completedAt: t.completedAt,
    cancelledAt: t.cancelledAt,
    cancelReason: t.cancelReason,
    version: t.version,
    overdue: isOverdue({ status: t.status as TaskStatus, dueAt: t.dueAt }, now),
    canUpdate: canUpdate && t.status === 'OPEN',
    rescheduleNeedsReason: rescheduleNeedsReason(t, now),
    endAt: t.endAt,
    location: t.location,
    attendees: t.attendees.map((a) => ({ userId: a.userId, name: a.member.user.name })),
    endAtLocal: t.endAt ? orgLocalInput(t.endAt, timeZone) : null,
    seriesId: t.seriesId,
  };
}

const CLOSED_STAGE = 'This lead is closed (Won or Lost). Reopen it before scheduling a follow-up';
const CLOSED_STAGE_TASK = 'This lead is closed (Won or Lost). Reopen it before adding a task';
const CALL_ON_DNC =
  'This lead is marked Do not contact. A call task cannot be added; other task types can.';

/**
 * The tasks of one lead that the caller may see (follow-ups and, separately, the other types),
 * its next follow-up date, and what the caller may do. Needs lead.read on the lead and task.read.
 */
export async function followUpsForLead(
  ctx: RequestContext,
  leadId: string,
): Promise<LeadFollowUps> {
  const leadScope = authorize(ctx, 'lead.read');
  const readScope = authorize(ctx, 'task.read');
  const now = new Date();
  return tenantRunner().withTenant(ctx.tenant, async (tx) => {
    const lead = await leadForTask(tx, ctx, leadScope, leadId, { write: false });
    const { timeZone } = await tx.organization.findFirstOrThrow({ select: { timeZone: true } });
    const { nextFollowUpAt } = await tx.lead.findFirstOrThrow({
      where: { id: lead.id },
      select: { nextFollowUpAt: true },
    });
    const visible = { AND: [{ leadId: lead.id }, await taskScopeFilter(tx, ctx, readScope)] };
    const followUp = { type: 'FOLLOW_UP' };
    const other = { type: { not: 'FOLLOW_UP' } };
    const openOf = (kind: Prisma.TaskWhereInput) =>
      tx.task.findMany({
        where: { ...visible, ...kind, status: 'OPEN' },
        orderBy: [{ dueAt: 'asc' }, { id: 'asc' }],
        select: VIEW_SELECT,
      });
    const closedOf = (kind: Prisma.TaskWhereInput) =>
      tx.task.findMany({
        where: { ...visible, ...kind, status: { in: ['DONE', 'CANCELLED'] } },
        orderBy: [{ updatedAt: 'desc' }, { id: 'desc' }],
        take: CLOSED_SHOWN,
        select: VIEW_SELECT,
      });
    const [open, closed, otherOpen, otherClosed] = await Promise.all([
      openOf(followUp),
      closedOf(followUp),
      openOf(other),
      closedOf(other),
    ]);
    const writable = !lead.archivedAt && !lead.mergedIntoLeadId;
    // Updating needs task.update over the task and lead.update over the lead.
    const updateScope = can(ctx, 'task.update') ? authorize(ctx, 'task.update') : null;
    let leadWritableForCaller = false;
    if (writable && can(ctx, 'lead.update')) {
      leadWritableForCaller = await leadForTask(tx, ctx, authorize(ctx, 'lead.update'), lead.id, {
        write: false,
      }).then(
        () => true,
        () => false,
      );
    }
    const mayUpdate = (t: TaskRow) =>
      leadWritableForCaller &&
      updateScope !== null &&
      (updateScope !== 'OWN' || t.assigneeUserId === ctx.userId);
    const hasOwnOpen = open.some((t) => t.assigneeUserId === ctx.userId);
    const closedStage = lead.stage === 'WON' || lead.stage === 'LOST';
    const couldSchedule = can(ctx, 'task.create') && leadWritableForCaller;
    return {
      nextFollowUpAt,
      open: open.map((t) => toView(t, now, mayUpdate(t), timeZone)),
      recentClosed: closed.map((t) => toView(t, now, false, timeZone)),
      canSchedule: couldSchedule && !closedStage && !hasOwnOpen,
      hasOwnOpen,
      scheduleBlockedReason: couldSchedule && closedStage ? CLOSED_STAGE : null,
      tasks: [
        ...otherOpen.map((t) => toView(t, now, mayUpdate(t), timeZone)),
        ...otherClosed.map((t) => toView(t, now, false, timeZone)),
      ],
      canAddTask: couldSchedule && !closedStage,
      callBlockedReason:
        couldSchedule && !closedStage && lead.contactStatus === 'DO_NOT_CONTACT'
          ? CALL_ON_DNC
          : null,
    };
  });
}

/**
 * Schedules a follow-up on a lead for the caller (FR-100; assignee = creator in Phase 3). One
 * open follow-up per lead and assignee (FR-108): a second one is refused; reschedule instead.
 */
export async function scheduleFollowUp(
  ctx: RequestContext,
  leadId: string,
  raw: unknown,
): Promise<{ id: string }> {
  // Permission before input validation (review L3): a caller without it learns nothing about
  // the input rules. scheduleFollowUpIn checks again, with the lead scope, in the transaction.
  authorize(ctx, 'task.create');
  authorize(ctx, 'lead.update');
  const input = scheduleInput.parse(raw);
  try {
    return await tenantRunner().withTenant(ctx.tenant, (tx) =>
      scheduleFollowUpIn(tx, ctx, leadId, input, new Date()),
    );
  } catch (e) {
    throw followUpError(e);
  }
}

/** The task_open_follow_up_uq race (FR-108) as the same conflict the check reports. */
export function followUpError(e: unknown): unknown {
  if (e instanceof Error && /task_open_follow_up_uq/.test(e.message)) return alreadyOpen();
  return e;
}

export type ScheduleInput = z.infer<typeof scheduleInput>;
export type RescheduleInput = z.infer<typeof rescheduleInput>;
export { completeInput, rescheduleInput, scheduleInput };

/**
 * scheduleFollowUp inside the caller's transaction (FR-084: the interaction sheet). Checks
 * task.create and lead.update on a writable, open lead. The caller maps a unique violation with
 * followUpError after its transaction rolls back.
 */
export async function scheduleFollowUpIn(
  tx: Tx,
  ctx: RequestContext,
  leadId: string,
  input: ScheduleInput,
  now: Date,
): Promise<{ id: string }> {
  authorize(ctx, 'task.create');
  const leadScope = authorize(ctx, 'lead.update');
  const lead = await leadForTask(tx, ctx, leadScope, leadId, { write: true });
  if (lead.stage === 'WON' || lead.stage === 'LOST') throw ruleViolation(CLOSED_STAGE);
  const assigneeUserId = await assigneeFor(tx, ctx, input.assigneeUserId, lead.id);
  const dueAt = await orgDueAt(tx, input.dueAt, now);
  const existing = await tx.task.findFirst({
    where: { leadId: lead.id, assigneeUserId, status: 'OPEN', type: 'FOLLOW_UP' },
    select: { id: true },
  });
  if (existing) throw alreadyOpen(assigneeUserId !== ctx.userId);
  const title = input.title || null;
  const priority = input.priority ?? 'NORMAL';
  const task = await tx.task.create({
    data: {
      orgId: ctx.orgId,
      type: 'FOLLOW_UP',
      title,
      leadId: lead.id,
      assigneeUserId,
      createdBy: ctx.userId,
      dueAt,
      priority,
    },
    select: { id: true },
  });
  await record(tx, ctx, lead.id, task.id, 'scheduled', {
    dueAt: dueAt.toISOString(),
    priority,
    ...assignedDetail(ctx, assigneeUserId),
  });
  await announce(tx, ctx, task.id, assigneeUserId);
  return task;
}

const alreadyOpen = (forSomeoneElse = false) =>
  conflict(
    forSomeoneElse
      ? 'This person already has an open follow-up on this lead. Reschedule it instead.'
      : 'You already have an open follow-up on this lead. Reschedule it instead.',
  );

const NOT_ASSIGNABLE_TEAM = 'You can assign tasks only to members of the teams you lead';

/**
 * FR-103 (role matrix §4.3 "task.create for others": O / O / T): the assignee of a new task.
 * Absent, empty or the caller: the caller. Anyone else needs task.assign; with ORG scope they must
 * be an active member of the org, with TEAM scope an active member currently in a team the
 * caller leads. They must also be able to work on the task with their own grants: task.update,
 * and lead.update over a writable lead for a lead task (the checks they would meet when changing
 * it). The database re-checks the role rule (app.task_assignee_allowed, migration 0021).
 */
async function assigneeFor(
  tx: Tx,
  ctx: RequestContext,
  raw: string | undefined,
  leadId: string | null,
): Promise<string> {
  if (ctx.kind !== 'member') throw notFound('Task not found');
  if (!raw || raw === ctx.userId) return ctx.userId;
  const scope = authorize(ctx, 'task.assign');
  const id = z.uuid().safeParse(raw);
  const refuse = (why: string) => invalid({ assigneeUserId: [why] });
  if (!id.success) throw refuse('Choose a person from the list');
  const m = await tx.member.findFirst({
    where: { userId: id.data, status: 'ACTIVE' },
    select: { id: true, userId: true, role: true },
  });
  if (!m) throw refuse('Choose an active member of your organisation');
  if (scope === 'TEAM' && !(await teamMemberIds(tx, ctx)).has(m.id))
    throw refuse(NOT_ASSIGNABLE_TEAM);
  const why = await cannotWorkOn(tx, ctx, m, leadId);
  if (why) throw refuse(why);
  return m.userId;
}

/** Memberships currently in a (non-archived) team the caller leads (TEAM scope of task.assign). */
async function teamMemberIds(tx: Tx, ctx: RequestContext & { kind: 'member' }) {
  const led = await ledTeamIds(tx, ctx.membershipId);
  if (!led.length) return new Set<string>();
  const rows = await tx.teamMembership.findMany({
    where: { teamId: { in: led }, endedAt: null },
    select: { membershipId: true },
  });
  return new Set(rows.map((r) => r.membershipId));
}

/**
 * Why an active member could not work on a task, with their own grants (null when they could):
 * task.update, and for a lead task lead.update over the writable lead.
 */
async function cannotWorkOn(
  tx: Tx,
  ctx: RequestContext & { kind: 'member' },
  m: { id: string; userId: string; role: string },
  leadId: string | null,
): Promise<string | null> {
  const theirs = memberContextFrom(m.userId, ctx.orgId, {
    org_id: ctx.orgId,
    membership_id: m.id,
    role_code: m.role,
    status: 'ACTIVE',
    org_status: 'ACTIVE',
    org_name: ctx.orgName,
  });
  if (!theirs.ok || !can(theirs.ctx, 'task.update')) return 'This person cannot be given tasks';
  if (!leadId) return null;
  const leadScope = can(theirs.ctx, 'lead.update') ? authorize(theirs.ctx, 'lead.update') : null;
  const reachable =
    leadScope !== null &&
    (await leadForTask(tx, theirs.ctx, leadScope, leadId, { write: true }).then(
      () => true,
      () => false,
    ));
  return reachable
    ? null
    : 'This person cannot work on this lead, so they could not act on the task';
}

/**
 * FR-104: the people the caller may invite to a meeting: any active member of the org except the
 * caller (owner decision 2026-10-30), at most ASSIGNEE_OPTIONS_MAX, by name. Needs task.create.
 */
export async function attendeeOptions(
  ctx: RequestContext,
): Promise<{ userId: string; name: string }[]> {
  if (ctx.kind !== 'member' || !can(ctx, 'task.create')) return [];
  return tenantRunner().withTenant(ctx.tenant, async (tx) =>
    (
      await tx.member.findMany({
        where: { status: 'ACTIVE', userId: { not: ctx.userId } },
        orderBy: [{ user: { name: 'asc' } }, { userId: 'asc' }],
        take: ASSIGNEE_OPTIONS_MAX,
        select: { userId: true, user: { select: { name: true } } },
      })
    ).map((m) => ({ userId: m.userId, name: m.user.name })),
  );
}

/** At most this many people are offered in the "For" list. */
export const ASSIGNEE_OPTIONS_MAX = 200;

/**
 * FR-103: the people the caller may give a new task to (the caller first), for the forms: the
 * same rules as assigneeFor. Empty without task.assign (the form then offers only "Me").
 */
export async function assigneeOptions(
  ctx: RequestContext,
  leadId: string | null,
): Promise<{ userId: string; name: string }[]> {
  if (ctx.kind !== 'member' || !can(ctx, 'task.assign') || !can(ctx, 'task.create')) return [];
  const scope = authorize(ctx, 'task.assign');
  return tenantRunner().withTenant(ctx.tenant, async (tx) => {
    const team = scope === 'TEAM' ? await teamMemberIds(tx, ctx) : null;
    const members = await tx.member.findMany({
      where: {
        status: 'ACTIVE',
        userId: { not: ctx.userId },
        ...(team ? { id: { in: [...team] } } : {}),
      },
      orderBy: [{ user: { name: 'asc' } }, { userId: 'asc' }],
      take: ASSIGNEE_OPTIONS_MAX,
      select: { id: true, userId: true, role: true, user: { select: { name: true } } },
    });
    const out: { userId: string; name: string }[] = [];
    for (const m of members)
      if (!(await cannotWorkOn(tx, ctx, m, leadId)))
        out.push({ userId: m.userId, name: m.user.name });
    return out;
  });
}

/** Timeline and audit name the assignee when it is someone else (FR-103). */
const assignedDetail = (ctx: RequestContext, assigneeUserId: string) =>
  ctx.kind === 'member' && assigneeUserId !== ctx.userId ? { assigneeUserId } : {};

/** FR-103 "Assignee notified": an outbox event in the same transaction (worker, then in-app). */
async function announce(tx: Tx, ctx: RequestContext, taskId: string, assigneeUserId: string) {
  if (ctx.kind !== 'member' || assigneeUserId === ctx.userId) return;
  await emitEvent(tx, ctx.orgId, {
    type: 'task.assigned',
    payload: { taskId, assigneeUserId, actorUserId: ctx.userId },
  });
}

export type CreateTaskInput = z.infer<typeof createInput>;
export { createInput };

/**
 * FR-100: a Call, Meeting, Document or Other task for the caller (assignee = creator in Phase 3),
 * with a title, a due time and a priority. With a lead it needs lead.update on a writable, open
 * lead, and a Call task is refused on a Do-Not-Contact lead (also task_call_dnc_guard). Without a
 * lead it needs task.create only. Any number may be open: the FR-108 limit is for follow-ups.
 * A Meeting also needs an end and may have a location and attendees (FR-104); other types
 * refuse those fields. A meeting that overlaps another of its assignee's is saved with a warning.
 */
export async function createTask(
  ctx: RequestContext,
  leadId: string | null,
  raw: unknown,
): Promise<{ id: string; warning?: string }> {
  authorize(ctx, 'task.create');
  if (leadId) authorize(ctx, 'lead.update');
  if (ctx.kind !== 'member') throw notFound('Task not found');
  const input = createInput.parse(raw);
  const now = new Date();
  if (input.type !== 'MEETING') refuseMeetingFields(input);
  if (input.type === 'FOLLOW_UP') {
    if (!leadId) throw invalid({ type: ['A follow-up is always about a lead'] });
    const { dueAt, priority, assigneeUserId, title } = input;
    const rest = {
      dueAt,
      ...(priority ? { priority } : {}),
      ...(assigneeUserId ? { assigneeUserId } : {}),
    };
    try {
      return await tenantRunner().withTenant(ctx.tenant, (tx) =>
        scheduleFollowUpIn(tx, ctx, leadId, { ...rest, ...(title ? { title } : {}) }, now),
      );
    } catch (e) {
      throw followUpError(e);
    }
  }
  return tenantRunner().withTenant(ctx.tenant, async (tx) => {
    let lead: TaskLead | null = null;
    if (leadId) {
      lead = await leadForTask(tx, ctx, authorize(ctx, 'lead.update'), leadId, { write: true });
      if (lead.stage === 'WON' || lead.stage === 'LOST') throw ruleViolation(CLOSED_STAGE_TASK);
      if (input.type === 'CALL' && lead.contactStatus === 'DO_NOT_CONTACT')
        throw ruleViolation(CALL_ON_DNC);
    }
    const assigneeUserId = await assigneeFor(tx, ctx, input.assigneeUserId, lead?.id ?? null);
    const dueAt = await orgDueAt(tx, input.dueAt, now);
    const meeting = input.type === 'MEETING';
    const details = meeting ? await meetingDetails(tx, dueAt, input) : null;
    const invited = meeting ? await checkAttendees(tx, input.attendeeUserIds, assigneeUserId) : [];
    const priority = input.priority ?? 'NORMAL';
    const task = await tx.task.create({
      data: {
        orgId: ctx.orgId,
        type: input.type,
        title: input.title,
        leadId: lead?.id ?? null,
        assigneeUserId,
        createdBy: ctx.userId,
        dueAt,
        priority,
        ...(details ? { endAt: details.endAt, location: details.location } : {}),
      },
      select: { id: true },
    });
    if (invited.length) await setAttendees(tx, ctx, task.id, invited);
    await record(tx, ctx, lead?.id ?? null, task.id, 'scheduled', {
      taskType: input.type,
      dueAt: dueAt.toISOString(),
      priority,
      ...assignedDetail(ctx, assigneeUserId),
      ...(details ? { endAt: details.endAt.toISOString(), attendees: invited.length } : {}),
    });
    await announce(tx, ctx, task.id, assigneeUserId);
    if (!details) return task;
    const warning = await overlapWarning(tx, ctx, {
      id: task.id,
      assigneeUserId,
      dueAt,
      endAt: details.endAt,
    });
    return warning ? { ...task, warning } : task;
  });
}

const noun = (type: string) => (type === 'FOLLOW_UP' ? 'follow-up' : 'task');

/**
 * Loads an open task the caller may change: task.update over the task, lead.update over its
 * (writable) lead when it has one, and the expected version. Locks the row for the rest of the
 * transaction. `followUpOnly` limits it to follow-ups (the interaction sheet, FR-084).
 */
async function loadForUpdate(
  tx: Tx,
  ctx: RequestContext,
  taskId: string,
  version: number,
  followUpOnly = false,
) {
  const updateScope = authorize(ctx, 'task.update');
  const id = parseTaskId(taskId);
  await tx.$queryRaw`SELECT id FROM task WHERE id = ${id}::uuid FOR UPDATE`;
  const task = await tx.task.findFirst({
    where: {
      AND: [
        { id, ...(followUpOnly ? { type: 'FOLLOW_UP' } : {}) },
        await taskScopeFilter(tx, ctx, updateScope),
      ],
    },
    select: { ...VIEW_SELECT, leadId: true },
  });
  if (!task) throw notFound(followUpOnly ? 'Follow-up not found' : 'Task not found');
  if (task.leadId)
    await leadForTask(tx, ctx, authorize(ctx, 'lead.update'), task.leadId, { write: true });
  if (task.status !== 'OPEN')
    throw ruleViolation(
      `This ${noun(task.type)} is already ${task.status === 'DONE' ? 'completed' : 'cancelled'}`,
    );
  if (task.version !== version)
    throw conflict(
      `This ${noun(task.type)} was changed by someone else. Reload the page and try again.`,
    );
  return task;
}

/** A follow-up always has a lead (task_follow_up_lead). */
const followUpLead = (t: { leadId: string | null }) => t.leadId as string;

/**
 * FR-102 for any task type (the names predate FR-100's other types): a new due time; a reason
 * when rescheduled more than twice or when overdue.
 */
export async function rescheduleFollowUp(
  ctx: RequestContext,
  taskId: string,
  raw: unknown,
): Promise<{ warning?: string }> {
  const input = rescheduleInput.parse(raw);
  const r = await tenantRunner().withTenant(ctx.tenant, (tx) =>
    rescheduleIn(tx, ctx, taskId, input, new Date(), false),
  );
  return r.warning ? { warning: r.warning } : {};
}

/** rescheduleFollowUp of a follow-up inside the caller's transaction (FR-084). */
export async function rescheduleFollowUpIn(
  tx: Tx,
  ctx: RequestContext,
  taskId: string,
  input: RescheduleInput,
  now: Date,
): Promise<{ leadId: string }> {
  return { leadId: followUpLead(await rescheduleIn(tx, ctx, taskId, input, now, true)) };
}

async function rescheduleIn(
  tx: Tx,
  ctx: RequestContext,
  taskId: string,
  input: RescheduleInput,
  now: Date,
  followUpOnly: boolean,
): Promise<{ leadId: string | null; warning?: string }> {
  const task = await loadForUpdate(tx, ctx, taskId, input.version, followUpOnly);
  const dueAt = await orgDueAt(tx, input.dueAt, now);
  // FR-104: a meeting keeps its length when it moves.
  const endAt = task.endAt
    ? new Date(dueAt.getTime() + (task.endAt.getTime() - task.dueAt.getTime()))
    : null;
  if (dueAt.getTime() === task.dueAt.getTime())
    throw invalid({ dueAt: ['Choose a different time to reschedule'] });
  const reason = input.reason || null;
  if (!reason && rescheduleNeedsReason(task, now))
    throw invalid({
      reason: [
        isOverdue(task, now)
          ? `This ${noun(task.type)} is overdue: give a reason for rescheduling`
          : `This ${noun(task.type)} was already rescheduled twice: give a reason`,
      ],
    });
  await tx.task.update({
    where: { id: task.id },
    data: {
      dueAt,
      ...(endAt ? { endAt } : {}),
      rescheduleCount: { increment: 1 },
      version: { increment: 1 },
      updatedAt: new Date(),
    },
  });
  await record(tx, ctx, task.leadId, task.id, 'rescheduled', {
    ...typeDetail(task.type),
    dueAt: dueAt.toISOString(),
    previousDueAt: task.dueAt.toISOString(),
    rescheduleCount: task.rescheduleCount + 1,
    wasOverdue: isOverdue(task, now),
    reason,
  });
  if (task.type !== 'MEETING' || ctx.kind !== 'member') return { leadId: task.leadId };
  const warning = await overlapWarning(tx, ctx, {
    id: task.id,
    assigneeUserId: task.assigneeUserId,
    dueAt,
    endAt,
  });
  return warning ? { leadId: task.leadId, warning } : { leadId: task.leadId };
}

/**
 * FR-104: changes an open meeting's end, location and attendees (the start moves with
 * reschedule, FR-102). Same permissions as rescheduling: task.update over the meeting and
 * lead.update over its writable lead; attendees cannot change it. The end is required, also for
 * a meeting saved before end times (owner decision). Optimistic-locked on the task version;
 * removed attendees are recorded, new ones notified. Returns an overlap warning when relevant.
 */
export async function updateMeeting(
  ctx: RequestContext,
  taskId: string,
  raw: unknown,
): Promise<{ warning?: string }> {
  const input = meetingInput.parse(raw);
  if (ctx.kind !== 'member') throw notFound('Task not found');
  return tenantRunner().withTenant(ctx.tenant, async (tx) => {
    const task = await loadForUpdate(tx, ctx, taskId, input.version);
    if (task.type !== 'MEETING') throw ruleViolation('Only a meeting has meeting details');
    const details = await meetingDetails(tx, task.dueAt, input);
    const invited = await checkAttendees(tx, input.attendeeUserIds, task.assigneeUserId);
    await tx.task.update({
      where: { id: task.id },
      data: {
        endAt: details.endAt,
        location: details.location,
        version: { increment: 1 },
        updatedAt: new Date(),
      },
    });
    const { added, removed } = await setAttendees(tx, ctx, task.id, invited);
    // The location is free text and may hold an address: the history says only that it changed.
    await record(tx, ctx, task.leadId, task.id, 'details_changed', {
      taskType: 'MEETING',
      dueAt: task.dueAt.toISOString(),
      endAt: details.endAt.toISOString(),
      previousEndAt: task.endAt?.toISOString() ?? null,
      locationChanged: details.location !== task.location,
      attendeesAdded: added.length,
      attendeesRemoved: removed.length,
    });
    const warning = await overlapWarning(tx, ctx, {
      id: task.id,
      assigneeUserId: task.assigneeUserId,
      dueAt: task.dueAt,
      endAt: details.endAt,
    });
    return warning ? { warning } : {};
  });
}

/** FR-102: marks an open task done. */
export async function completeFollowUp(
  ctx: RequestContext,
  taskId: string,
  raw: unknown,
): Promise<{ warning?: string }> {
  const input = completeInput.parse(raw);
  const r = await tenantRunner().withTenant(ctx.tenant, (tx) =>
    completeIn(tx, ctx, taskId, input.version, false),
  );
  return r.warning ? { warning: r.warning } : {};
}

/** completeFollowUp of a follow-up inside the caller's transaction (FR-084). */
export async function completeFollowUpIn(
  tx: Tx,
  ctx: RequestContext,
  taskId: string,
  version: number,
): Promise<{ leadId: string }> {
  return { leadId: followUpLead(await completeIn(tx, ctx, taskId, version, true)) };
}

async function completeIn(
  tx: Tx,
  ctx: RequestContext,
  taskId: string,
  version: number,
  followUpOnly: boolean,
): Promise<{ leadId: string | null; warning?: string }> {
  const task = await loadForUpdate(tx, ctx, taskId, version, followUpOnly);
  // now() in SQL: task_guard requires the transaction time exactly (microseconds).
  await tx.$executeRaw`
    UPDATE task SET status = 'DONE', completed_at = now(), version = version + 1, updated_at = now()
     WHERE id = ${task.id}::uuid`;
  await record(tx, ctx, task.leadId, task.id, 'completed', {
    ...typeDetail(task.type),
    dueAt: task.dueAt.toISOString(),
  });
  // FR-107: the next occurrence of a recurring task, in this transaction.
  const warning = await advanceSeries(tx, ctx, task.seriesId, task.dueAt);
  return warning ? { leadId: task.leadId, warning } : { leadId: task.leadId };
}

/** FR-102: cancels an open task with a reason. */
export async function cancelFollowUp(
  ctx: RequestContext,
  taskId: string,
  raw: unknown,
): Promise<{ warning?: string }> {
  const input = cancelInput.parse(raw);
  return tenantRunner().withTenant(ctx.tenant, async (tx) => {
    const task = await loadForUpdate(tx, ctx, taskId, input.version);
    await tx.$executeRaw`
      UPDATE task SET status = 'CANCELLED', cancelled_at = now(), cancel_reason = ${input.reason},
             version = version + 1, updated_at = now()
       WHERE id = ${task.id}::uuid`;
    await record(tx, ctx, task.leadId, task.id, 'cancelled', {
      ...typeDetail(task.type),
      dueAt: task.dueAt.toISOString(),
      reason: input.reason,
    });
    // FR-107: cancelling one occurrence skips it; the series goes on (stopping is separate).
    const warning = await advanceSeries(tx, ctx, task.seriesId, task.dueAt);
    return warning ? { warning } : {};
  });
}

/** Timeline and audit entries name the type of a task other than a follow-up. */
const typeDetail = (type: string) => (type === 'FOLLOW_UP' ? {} : { taskType: type });

type FollowUpAction = 'scheduled' | 'rescheduled' | 'completed' | 'cancelled' | 'details_changed';

/** Timeline entry on the lead (when the task has one) and one audit entry. No contact details. */
async function record(
  tx: Tx,
  ctx: RequestContext,
  leadId: string | null,
  taskId: string,
  action: FollowUpAction,
  details: Record<string, string | number | boolean | null>,
): Promise<void> {
  if (leadId)
    await tx.leadActivity.create({
      data: {
        orgId: ctx.orgId,
        leadId,
        type: 'TASK',
        actorId: ctx.userId,
        summary: { action, ...details },
        refType: 'task',
        refId: taskId,
      },
    });
  await writeAudit(tx, ctx.orgId, {
    action: `task.${action}`,
    entityType: 'task',
    entityId: taskId,
    actorUserId: ctx.userId,
    metadata: { leadId, ...details },
  });
}

// ---------------------------------------------------------------------------------------------
// My Day (FR-101)

/** Upper bound on the tasks read for one My Day (earliest due first). */
export const MY_DAY_MAX = 500;
/** Open tasks due after the 7-day window listed under "Later" (earliest due first). */
export const MY_DAY_LATER_MAX = 50;

export interface MyDayItem {
  id: string;
  type: TaskType;
  title: string | null;
  dueAt: Date;
  priority: TaskPriority;
  rescheduleCount: number;
  version: number;
  /** Who created it, when someone else did (FR-103); null for one's own. */
  assignedByName: string | null;
  /** A reschedule now must give a reason (FR-102). */
  rescheduleNeedsReason: boolean;
  /** The task has a lead (shown in `lead` when the caller may still open it). */
  onLead: boolean;
  /**
   * The lead, when the caller may still open it. Null when the task has no lead, or when the
   * lead left their scope (e.g. it was reassigned outside their team): their own task stays
   * visible ("users' own tasks are always visible", user-personas-and-roles §2.2) but nothing
   * about the lead is shown.
   */
  lead: {
    id: string;
    fullName: string;
    stage: string;
    intent: string | null;
    archived: boolean;
  } | null;
  /**
   * Completed, rescheduled or cancelled from My Day: tasks with no lead (task.update). A lead's
   * tasks are changed on the lead page, which checks the lead as well.
   */
  canUpdate: boolean;
  /** FR-104, meetings only: end and location (null otherwise or when not set). */
  endAt: Date | null;
  location: string | null;
  /** FR-104: current attendees of a meeting (empty for other types). */
  attendees: { userId: string; name: string }[];
  /**
   * FR-104 (owner decision): a meeting the caller is invited to but not assigned. Read-only; the
   * person it is for is named in `organiserName`.
   */
  attending: boolean;
  organiserName: string | null;
  /** The end as a datetime-local value in the org's time zone (the edit form), or null. */
  endAtLocal: string | null;
  /** FR-107: the recurring series of this occurrence, or null. */
  seriesId: string | null;
}

export interface MyDay {
  overdue: MyDayItem[];
  today: MyDayItem[];
  upcoming: MyDayItem[];
  /** Open tasks due after the 7-day window, earliest first (at most MY_DAY_LATER_MAX). */
  later: MyDayItem[];
  /** More than MY_DAY_MAX open tasks fell in the window; the earliest-due were used. */
  truncated: boolean;
}

const MY_DAY_SELECT = {
  id: true,
  type: true,
  title: true,
  dueAt: true,
  priority: true,
  rescheduleCount: true,
  version: true,
  createdBy: true,
  creator: { select: { user: { select: { name: true } } } },
  assigneeUserId: true,
  assignee: { select: { user: { select: { name: true } } } },
  seriesId: true,
  endAt: true,
  location: true,
  attendees: {
    where: { removedAt: null },
    orderBy: { createdAt: 'asc' },
    select: { userId: true, member: { select: { user: { select: { name: true } } } } },
  },
  lead: { select: { id: true, fullName: true, stage: true, intent: true, archivedAt: true } },
} satisfies Prisma.TaskSelect;

/**
 * FR-101 My Day for the signed-in member: their own OPEN tasks of every type (assigned to them;
 * never anyone else's) that are overdue, due today, or due in the 7 days after today, in the
 * org's time zone (the same windows as FR-056, followUpDueRange). Each section is ordered by
 * priority, then lead intent (Hot first), then due time, then id. Completed and cancelled tasks
 * never appear. Open tasks due later are listed separately, earliest first, so a task scheduled
 * further ahead is still visible (ADR-0015). Open meetings the caller is invited to (FR-104) are
 * included read-only until they end; their lead is shown only when the caller can open it. One
 * indexed query per list and one for the caller's lead scope.
 */
export async function myDay(ctx: RequestContext, now: Date = new Date()): Promise<MyDay> {
  authorize(ctx, 'task.read');
  const empty: MyDay = { overdue: [], today: [], upcoming: [], later: [], truncated: false };
  if (ctx.kind !== 'member') return empty;
  return tenantRunner().withTenant(ctx.tenant, async (tx) => {
    const { timeZone } = await tx.organization.findFirstOrThrow({ select: { timeZone: true } });
    const tomorrow = (followUpDueRange('today', timeZone, now) as { lt: Date }).lt;
    const end = (followUpDueRange('next7', timeZone, now) as { lt: Date }).lt;
    // Own tasks, and open meetings the caller is invited to that have not ended yet.
    const mine: Prisma.TaskWhereInput = {
      status: 'OPEN',
      OR: [
        { assigneeUserId: ctx.userId },
        {
          type: 'MEETING',
          attendees: { some: { userId: ctx.userId, removedAt: null } },
          OR: [{ endAt: { gte: now } }, { endAt: null, dueAt: { gte: now } }],
        },
      ],
    };
    const [rows, laterRows] = await Promise.all([
      tx.task.findMany({
        where: { ...mine, dueAt: { lt: end } },
        orderBy: [{ dueAt: 'asc' }, { id: 'asc' }],
        take: MY_DAY_MAX + 1,
        select: MY_DAY_SELECT,
      }),
      tx.task.findMany({
        where: { ...mine, dueAt: { gte: end } },
        orderBy: [{ dueAt: 'asc' }, { id: 'asc' }],
        take: MY_DAY_LATER_MAX,
        select: MY_DAY_SELECT,
      }),
    ]);
    const truncated = rows.length > MY_DAY_MAX;
    const kept = rows.slice(0, MY_DAY_MAX);
    const item = await itemBuilder(tx, ctx, [...kept, ...laterRows], now, timeZone);
    const day: MyDay = { ...empty, overdue: [], today: [], upcoming: [], truncated };
    for (const t of kept) {
      const bucket = myDayBucket(t.dueAt, now, tomorrow, end);
      if (bucket) day[bucket].push(item(t));
    }
    day.later = laterRows.map(item);
    const order = (a: MyDayItem, b: MyDayItem) =>
      compareMyDay(
        { ...a, intent: a.lead?.intent ?? null },
        { ...b, intent: b.lead?.intent ?? null },
      );
    for (const k of ['overdue', 'today', 'upcoming'] as const) day[k].sort(order);
    return day;
  });
}

type DayRow = Prisma.TaskGetPayload<{ select: typeof MY_DAY_SELECT }>;

/**
 * Turns task rows into My Day / calendar items for the caller: the lead only when the caller may
 * open it (one scope query for all rows), changes only for their own no-lead tasks, and meetings
 * they are invited to marked read-only with the organiser's name.
 */
async function itemBuilder(
  tx: Tx,
  ctx: RequestContext & { kind: 'member' },
  rows: DayRow[],
  now: Date,
  timeZone: string,
): Promise<(t: DayRow) => MyDayItem> {
  const mayUpdate = can(ctx, 'task.update');
  const leadIds = [...new Set(rows.flatMap((t) => (t.lead ? [t.lead.id] : [])))];
  const visible = new Set(
    can(ctx, 'lead.read') && leadIds.length
      ? (
          await tx.lead.findMany({
            where: {
              AND: [
                { id: { in: leadIds } },
                await leadScopeFilter(tx, ctx, authorize(ctx, 'lead.read')),
              ],
            },
            select: { id: true },
          })
        ).map((l) => l.id)
      : [],
  );
  return (t) => {
    const attending = t.assigneeUserId !== ctx.userId;
    return {
      id: t.id,
      type: t.type as TaskType,
      title: t.title,
      dueAt: t.dueAt,
      priority: t.priority as TaskPriority,
      rescheduleCount: t.rescheduleCount,
      version: t.version,
      assignedByName: t.createdBy !== ctx.userId && !t.seriesId ? t.creator.user.name : null,
      rescheduleNeedsReason: rescheduleNeedsReason(t, now),
      onLead: t.lead !== null,
      lead:
        t.lead && visible.has(t.lead.id)
          ? {
              id: t.lead.id,
              fullName: t.lead.fullName,
              stage: t.lead.stage,
              intent: t.lead.intent,
              archived: t.lead.archivedAt !== null,
            }
          : null,
      canUpdate: mayUpdate && t.lead === null && !attending,
      endAt: t.endAt,
      location: t.location,
      attendees: t.attendees.map((x) => ({ userId: x.userId, name: x.member.user.name })),
      attending,
      organiserName: attending ? t.assignee.user.name : null,
      endAtLocal: t.endAt ? orgLocalInput(t.endAt, timeZone) : null,
      seriesId: t.seriesId,
    };
  };
}

// ---------------------------------------------------------------------------------------------
// Calendar (FR-105, ADR-0018)

/** Upper bound on the items read for one calendar period (earliest first). */
export const CALENDAR_MAX = 1000;

export interface CalendarItem extends MyDayItem {
  /** A meeting that overlaps another of the caller's meetings shown (FR-104 rule). */
  overlaps: boolean;
}

export interface Calendar {
  period: CalendarPeriod;
  /** The org-local day today. */
  today: string;
  /** Items per day key (only days of the period that have items), in time order. */
  byDay: Record<string, CalendarItem[]>;
  /** More than CALENDAR_MAX items fell in the period; the earliest were used. */
  truncated: boolean;
}

/**
 * FR-105 day / week / month calendar for the signed-in member: the same items as My Day, by
 * org-local day: their own OPEN tasks of every type (assigned to them), and OPEN meetings they are
 * currently invited to (read-only; the lead only when they may open it). A meeting that began the
 * day before and is still running at the first day's start is listed on that first day. Completed
 * and cancelled tasks never appear, nor anyone else's tasks: a manager's or Owner's calendar is
 * their own, and no-lead tasks stay private (ADR-0016 D2). Needs task.read.
 */
export async function calendar(
  ctx: RequestContext,
  query: { view?: string | undefined; date?: string | undefined },
  now: Date = new Date(),
): Promise<Calendar> {
  authorize(ctx, 'task.read');
  return tenantRunner().withTenant(ctx.tenant, async (tx) => {
    const { timeZone } = await tx.organization.findFirstOrThrow({ select: { timeZone: true } });
    const today = dayKeyIn(now, timeZone);
    const { view, date } = parseCalendarQuery(query.view, query.date, today);
    const period = calendarPeriod(view, date);
    const empty: Calendar = { period, today, byDay: {}, truncated: false };
    if (ctx.kind !== 'member') return empty;
    const from = parseOrgLocal(period.first, timeZone)!;
    const to = parseOrgLocal(period.end, timeZone)!;
    const rows = await tx.task.findMany({
      where: {
        status: 'OPEN',
        AND: [
          {
            OR: [
              { assigneeUserId: ctx.userId },
              { type: 'MEETING', attendees: { some: { userId: ctx.userId, removedAt: null } } },
            ],
          },
          {
            OR: [
              { dueAt: { gte: from, lt: to } },
              { type: 'MEETING', dueAt: { lt: from }, endAt: { gt: from } },
            ],
          },
        ],
      },
      orderBy: [{ dueAt: 'asc' }, { id: 'asc' }],
      take: CALENDAR_MAX + 1,
      select: MY_DAY_SELECT,
    });
    const kept = rows.slice(0, CALENDAR_MAX);
    const item = await itemBuilder(tx, ctx, kept, now, timeZone);
    const meetings = kept.filter((t) => t.type === 'MEETING');
    const byDay: Record<string, CalendarItem[]> = {};
    for (const t of kept) {
      const key = t.dueAt < from ? period.first : dayKeyIn(t.dueAt, timeZone);
      const overlaps =
        t.type === 'MEETING' && meetings.some((o) => o.id !== t.id && meetingsOverlap(o, t));
      (byDay[key] ??= []).push({ ...item(t), overlaps });
    }
    return { period, today, byDay, truncated: rows.length > CALENDAR_MAX };
  });
}
