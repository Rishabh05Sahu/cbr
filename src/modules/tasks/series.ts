// FR-107 recurring tasks (ADR-0020; migration 0024). A series is the template of a daily or weekly
// no-lead task (Call, Meeting, Document or Other) of its creator, who must be an Owner, Admin or
// Sales Manager (task.recur). Exactly one occurrence is open at a time: the first is created with
// the series, and each next one when the open one is completed or cancelled (advanceSeries, in that
// transaction), strictly after that moment, so missed dates are skipped. Occurrences are ordinary
// tasks: their own id, lifecycle and FR-106 reminder. Editing a series changes future occurrences
// only; stopping it prevents further ones and leaves the open task alone.
import { z } from 'zod';
import { writeAudit } from '@/modules/audit';
import { parseOrgLocal } from '@/modules/leads';
import { authorize, can, type RequestContext } from '@/platform/authz';
import { tenantRunner, type Tx } from '@/platform/db';
import { conflict, DomainError, notFound, ruleViolation } from '@/platform/errors';
import { dayKeyIn, validDayKey } from './calendar-rules';
import { NEW_TASK_TYPES, TASK_PRIORITIES } from './follow-up-rules';
import { checkAttendees, overlapWarning, setAttendees } from './meetings';
import {
  describeSeries,
  nextOccurrence,
  SERIES_FREQUENCIES,
  validLocalTime,
  type SeriesRule,
} from './series-rules';

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

/** The editable template (type is fixed once created). */
const templateFields = {
  title: oneLine(200).refine((t) => t.length > 0, { message: 'Say what the task is' }),
  priority: z.enum(TASK_PRIORITIES).optional(),
  frequency: z.enum(SERIES_FREQUENCIES, 'Choose daily or weekly'),
  weekday: z.string().max(2).optional(),
  localTime: z.string().max(5),
  endDate: z.string().max(10).optional(),
  durationMinutes: z.string().max(5).optional(),
  location: oneLine(300).optional(),
  attendeeUserIds: z.array(z.string().max(40)).max(30, 'At most 30 attendees').optional(),
};
const createInput = z.object({
  type: z.enum(NEW_TASK_TYPES, 'Choose a task type'),
  ...templateFields,
});
const updateInput = z.object({ ...templateFields, version: z.coerce.number().int().positive() });
const stopInput = z.object({ version: z.coerce.number().int().positive() });

type Template = Omit<z.infer<typeof updateInput>, 'version'>;

interface CheckedTemplate {
  title: string;
  priority: string;
  rule: SeriesRule;
  durationMinutes: number | null;
  location: string | null;
  attendeeUserIds: string[];
}

/** Validates a template for the caller's series; meeting fields only for meetings. */
async function checkTemplate(
  tx: Tx,
  ownerUserId: string,
  type: string,
  input: Template,
  today: string,
): Promise<CheckedTemplate> {
  const errors: Record<string, string[]> = {};
  const weekly = input.frequency === 'WEEKLY';
  const weekday = weekly ? Number(input.weekday) : null;
  if (weekly && !(Number.isInteger(weekday) && weekday! >= 0 && weekday! <= 6))
    errors.weekday = ['Choose a weekday'];
  if (!validLocalTime(input.localTime)) errors.localTime = ['Enter a time (HH:MM)'];
  const endDate = input.endDate ? validDayKey(input.endDate) : null;
  if (input.endDate && !endDate) errors.endDate = ['Enter a valid date'];
  else if (endDate && endDate < today) errors.endDate = ['The end date has passed'];
  const meeting = type === 'MEETING';
  let durationMinutes: number | null = null;
  if (meeting) {
    durationMinutes = Number(input.durationMinutes);
    if (!Number.isInteger(durationMinutes) || durationMinutes < 1 || durationMinutes > 1440)
      errors.durationMinutes = ['Enter the meeting length in minutes (1 to 1440)'];
  } else {
    if (input.durationMinutes) errors.durationMinutes = ['Only a meeting has a length'];
    if (input.location) errors.location = ['Only a meeting has a location'];
    if (input.attendeeUserIds?.length) errors.attendeeUserIds = ['Only a meeting has attendees'];
  }
  if (Object.keys(errors).length) throw invalid(errors);
  return {
    title: input.title,
    priority: input.priority ?? 'NORMAL',
    rule: { frequency: input.frequency, weekday, localTime: input.localTime, endDate },
    durationMinutes,
    location: meeting ? input.location || null : null,
    attendeeUserIds: meeting ? await checkAttendees(tx, input.attendeeUserIds, ownerUserId) : [],
  };
}

const orgZone = async (tx: Tx) =>
  (await tx.organization.findFirstOrThrow({ select: { timeZone: true } })).timeZone;
const nextAfter = (rule: SeriesRule, after: Date, timeZone: string) =>
  nextOccurrence(rule, after, timeZone, (v) => parseOrgLocal(v, timeZone));
const dateKey = (d: Date | null) => (d ? d.toISOString().slice(0, 10) : null);

const SERIES_SELECT = {
  id: true,
  ownerUserId: true,
  type: true,
  title: true,
  priority: true,
  frequency: true,
  weekday: true,
  localTime: true,
  endDate: true,
  durationMinutes: true,
  location: true,
  attendeeUserIds: true,
  stoppedAt: true,
  version: true,
} as const;
type SeriesRow = {
  id: string;
  ownerUserId: string;
  type: string;
  title: string;
  priority: string;
  frequency: string;
  weekday: number | null;
  localTime: string;
  endDate: Date | null;
  durationMinutes: number | null;
  location: string | null;
  attendeeUserIds: string[];
  stoppedAt: Date | null;
  version: number;
};
const ruleOf = (s: SeriesRow): SeriesRule => ({
  frequency: s.frequency as SeriesRule['frequency'],
  weekday: s.weekday,
  localTime: s.localTime,
  endDate: dateKey(s.endDate),
});

/**
 * Creates the occurrence due at `dueAt` for the series' owner: an ordinary open task linked to the
 * series. A meeting gets its length, location and the attendees who are still active members
 * (invited and notified as for any meeting, ADR-0017). Audited; returns the overlap warning.
 */
async function insertOccurrence(
  tx: Tx,
  ctx: RequestContext & { kind: 'member' },
  s: SeriesRow,
  dueAt: Date,
): Promise<{ id: string; warning: string | null }> {
  const meeting = s.type === 'MEETING';
  const endAt = meeting ? new Date(dueAt.getTime() + s.durationMinutes! * 60_000) : null;
  const task = await tx.task.create({
    data: {
      orgId: ctx.orgId,
      type: s.type,
      title: s.title,
      assigneeUserId: s.ownerUserId,
      createdBy: ctx.userId,
      dueAt,
      priority: s.priority,
      seriesId: s.id,
      ...(meeting ? { endAt, location: s.location } : {}),
    },
    select: { id: true },
  });
  let invited = 0;
  if (meeting && s.attendeeUserIds.length) {
    const active = await tx.member.findMany({
      where: { userId: { in: s.attendeeUserIds, not: s.ownerUserId }, status: 'ACTIVE' },
      select: { userId: true },
    });
    const ids = s.attendeeUserIds.filter((u) => active.some((m) => m.userId === u));
    if (ids.length) invited = (await setAttendees(tx, ctx, task.id, ids)).added.length;
  }
  await writeAudit(tx, ctx.orgId, {
    action: 'task.scheduled',
    entityType: 'task',
    entityId: task.id,
    actorUserId: ctx.userId,
    metadata: {
      taskType: s.type,
      dueAt: dueAt.toISOString(),
      priority: s.priority,
      seriesId: s.id,
      ...(meeting ? { endAt: endAt!.toISOString(), attendees: invited } : {}),
    },
  });
  const warning = meeting
    ? await overlapWarning(tx, ctx, { id: task.id, assigneeUserId: s.ownerUserId, dueAt, endAt })
    : null;
  return { id: task.id, warning };
}

/** FR-107: creates a series and its first occurrence (the first date strictly after now). */
export async function createSeries(
  ctx: RequestContext,
  raw: unknown,
  now: Date = new Date(),
): Promise<{ id: string; taskId: string; warning?: string }> {
  authorize(ctx, 'task.recur');
  authorize(ctx, 'task.create');
  if (ctx.kind !== 'member') throw notFound('Series not found');
  const input = createInput.parse(raw);
  return tenantRunner().withTenant(ctx.tenant, async (tx) => {
    const timeZone = await orgZone(tx);
    const t = await checkTemplate(tx, ctx.userId, input.type, input, dayKeyIn(now, timeZone));
    const first = nextAfter(t.rule, now, timeZone);
    if (!first)
      throw invalid({ endDate: ['No date of this series falls on or before the end date'] });
    const s = await tx.taskSeries.create({
      data: {
        orgId: ctx.orgId,
        ownerUserId: ctx.userId,
        createdBy: ctx.userId,
        type: input.type,
        title: t.title,
        priority: t.priority,
        frequency: t.rule.frequency,
        weekday: t.rule.weekday,
        localTime: t.rule.localTime,
        endDate: t.rule.endDate ? new Date(`${t.rule.endDate}T00:00:00Z`) : null,
        durationMinutes: t.durationMinutes,
        location: t.location,
        attendeeUserIds: t.attendeeUserIds,
      },
      select: SERIES_SELECT,
    });
    await writeAudit(tx, ctx.orgId, {
      action: 'task_series.created',
      entityType: 'task_series',
      entityId: s.id,
      actorUserId: ctx.userId,
      metadata: { taskType: s.type, frequency: s.frequency, attendees: t.attendeeUserIds.length },
    });
    const occ = await insertOccurrence(tx, ctx, s, first);
    return { id: s.id, taskId: occ.id, ...(occ.warning ? { warning: occ.warning } : {}) };
  });
}

/** Loads a series the caller may manage (its owner, or ORG task scope), locked. */
async function loadSeries(tx: Tx, ctx: RequestContext & { kind: 'member' }, id: string) {
  const parsed = z.uuid().safeParse(id);
  if (!parsed.success) throw notFound('Series not found');
  await tx.$queryRaw`SELECT id FROM task_series WHERE id = ${parsed.data}::uuid FOR UPDATE`;
  const s = await tx.taskSeries.findFirst({
    where: {
      id: parsed.data,
      ...(authorize(ctx, 'task.update') === 'ORG' ? {} : { ownerUserId: ctx.userId }),
    },
    select: SERIES_SELECT,
  });
  if (!s) throw notFound('Series not found');
  return s;
}

/** FR-107: edits a series; future occurrences only (the open task is unchanged). */
export async function updateSeries(
  ctx: RequestContext,
  id: string,
  raw: unknown,
  now: Date = new Date(),
): Promise<void> {
  authorize(ctx, 'task.recur');
  if (ctx.kind !== 'member') throw notFound('Series not found');
  const input = updateInput.parse(raw);
  await tenantRunner().withTenant(ctx.tenant, async (tx) => {
    const s = await loadSeries(tx, ctx, id);
    if (s.stoppedAt) throw ruleViolation('This series is stopped');
    if (s.version !== input.version)
      throw conflict('This series was changed by someone else. Reload the page and try again.');
    const timeZone = await orgZone(tx);
    const t = await checkTemplate(tx, s.ownerUserId, s.type, input, dayKeyIn(now, timeZone));
    await tx.taskSeries.update({
      where: { id: s.id },
      data: {
        title: t.title,
        priority: t.priority,
        frequency: t.rule.frequency,
        weekday: t.rule.weekday,
        localTime: t.rule.localTime,
        endDate: t.rule.endDate ? new Date(`${t.rule.endDate}T00:00:00Z`) : null,
        durationMinutes: t.durationMinutes,
        location: t.location,
        attendeeUserIds: t.attendeeUserIds,
        version: { increment: 1 },
        updatedAt: new Date(),
      },
    });
    await writeAudit(tx, ctx.orgId, {
      action: 'task_series.updated',
      entityType: 'task_series',
      entityId: s.id,
      actorUserId: ctx.userId,
      metadata: { frequency: t.rule.frequency, attendees: t.attendeeUserIds.length },
    });
  });
}

/** FR-107: stops a series. No further occurrences; the open one (if any) is left as it is. */
export async function stopSeries(ctx: RequestContext, id: string, raw: unknown): Promise<void> {
  authorize(ctx, 'task.recur');
  if (ctx.kind !== 'member') throw notFound('Series not found');
  const input = stopInput.parse(raw);
  await tenantRunner().withTenant(ctx.tenant, async (tx) => {
    const s = await loadSeries(tx, ctx, id);
    if (s.stoppedAt) throw ruleViolation('This series is already stopped');
    if (s.version !== input.version)
      throw conflict('This series was changed by someone else. Reload the page and try again.');
    // now() in SQL: task_series_guard requires the transaction time exactly.
    await tx.$executeRaw`
      UPDATE task_series SET stopped_at = now(), stopped_by = ${ctx.userId}::uuid,
             version = version + 1, updated_at = now()
       WHERE id = ${s.id}::uuid`;
    await writeAudit(tx, ctx.orgId, {
      action: 'task_series.stopped',
      entityType: 'task_series',
      entityId: s.id,
      actorUserId: ctx.userId,
    });
  });
}

/**
 * FR-107: after an occurrence was completed or cancelled (inside that transaction), creates the
 * next one: the first date strictly after both `now` and the closed occurrence's own due time (an
 * occurrence closed early must not come back on the same date; one closed late skips the missed
 * dates). Nothing when the series is stopped, ended, its owner is no longer active, or an open
 * occurrence already exists. The series row is locked and task_series_open_uq allows one open
 * occurrence, so concurrent or repeated calls create one.
 */
export async function advanceSeries(
  tx: Tx,
  ctx: RequestContext,
  seriesId: string | null,
  closedDueAt: Date,
  now: Date = new Date(),
): Promise<string | null> {
  if (!seriesId || ctx.kind !== 'member') return null;
  await tx.$queryRaw`SELECT id FROM task_series WHERE id = ${seriesId}::uuid FOR UPDATE`;
  const s = await tx.taskSeries.findFirst({ where: { id: seriesId }, select: SERIES_SELECT });
  if (!s || s.stoppedAt) return null;
  const open = await tx.task.count({ where: { seriesId, status: 'OPEN' } });
  if (open) return null;
  const owner = await tx.member.count({ where: { userId: s.ownerUserId, status: 'ACTIVE' } });
  if (!owner) return null;
  const after = closedDueAt.getTime() > now.getTime() ? closedDueAt : now;
  const next = nextAfter(ruleOf(s), after, await orgZone(tx));
  if (!next) return null;
  return (await insertOccurrence(tx, ctx, s, next)).warning;
}

export interface SeriesView {
  id: string;
  type: string;
  title: string;
  priority: string;
  summary: string;
  rule: SeriesRule;
  durationMinutes: number | null;
  location: string | null;
  attendeeUserIds: string[];
  version: number;
  /** The open occurrence's due time, if any. */
  nextDueAt: Date | null;
}

/** The caller's own active series (FR-107), newest first. */
export async function listMySeries(ctx: RequestContext): Promise<SeriesView[]> {
  if (ctx.kind !== 'member' || !can(ctx, 'task.recur')) return [];
  return tenantRunner().withTenant(ctx.tenant, async (tx) => {
    const rows = await tx.taskSeries.findMany({
      where: { ownerUserId: ctx.userId, stoppedAt: null },
      orderBy: [{ createdAt: 'desc' }, { id: 'desc' }],
      take: 100,
      select: {
        ...SERIES_SELECT,
        tasks: { where: { status: 'OPEN' }, select: { dueAt: true }, take: 1 },
      },
    });
    return rows.map((s) => ({
      id: s.id,
      type: s.type,
      title: s.title,
      priority: s.priority,
      summary: describeSeries(ruleOf(s)),
      rule: ruleOf(s),
      durationMinutes: s.durationMinutes,
      location: s.location,
      attendeeUserIds: s.attendeeUserIds,
      version: s.version,
      nextDueAt: s.tasks[0]?.dueAt ?? null,
    }));
  });
}
