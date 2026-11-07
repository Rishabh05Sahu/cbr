// Task rules (FR-100, FR-102, FR-108), free of the database so they can be unit tested.

/** FR-100 task types. Follow-ups are lead work (FR-108); the others may have no lead. */
export const TASK_TYPES = ['FOLLOW_UP', 'CALL', 'MEETING', 'DOCUMENT', 'OTHER'] as const;
export type TaskType = (typeof TASK_TYPES)[number];
/** The types created through createTask (follow-ups have their own command). */
export const NEW_TASK_TYPES = ['CALL', 'MEETING', 'DOCUMENT', 'OTHER'] as const;
export type NewTaskType = (typeof NEW_TASK_TYPES)[number];
export const TASK_TYPE_LABELS: Record<TaskType, string> = {
  FOLLOW_UP: 'Follow-up',
  CALL: 'Call',
  MEETING: 'Meeting',
  DOCUMENT: 'Document',
  OTHER: 'Other',
};

export const TASK_PRIORITIES = ['LOW', 'NORMAL', 'HIGH', 'URGENT'] as const;
export type TaskPriority = (typeof TASK_PRIORITIES)[number];
export type TaskStatus = 'OPEN' | 'DONE' | 'CANCELLED';

/** How far ahead a follow-up may be scheduled (a typo guard, not a business rule). */
export const MAX_DAYS_AHEAD = 730;
/** Slack for a form submitted a moment after the chosen minute has passed. */
const PAST_SLACK_MS = 60_000;

/** Why a due time is refused, or null when it is acceptable. */
export function dueAtProblem(dueAt: Date | null, now: Date): string | null {
  if (!dueAt) return 'Enter a valid date and time';
  if (dueAt.getTime() < now.getTime() - PAST_SLACK_MS) return 'Choose a time in the future';
  if (dueAt.getTime() > now.getTime() + MAX_DAYS_AHEAD * 86_400_000)
    return 'Choose a time within the next two years';
  return null;
}

/**
 * FR-102: a reason is required when the follow-up has already been rescheduled twice (this is
 * the third or later reschedule) or when it is overdue.
 */
export function rescheduleNeedsReason(
  task: { rescheduleCount: number; dueAt: Date },
  now: Date,
): boolean {
  return task.rescheduleCount >= 2 || task.dueAt.getTime() < now.getTime();
}

/**
 * FR-108: the lead's next follow-up is the earliest open one. The database keeps
 * lead.next_follow_up_at equal to this (task_sync_next_follow_up); the function documents and
 * tests the rule.
 */
export function nextFollowUpAt(tasks: { status: TaskStatus; dueAt: Date }[]): Date | null {
  let next: Date | null = null;
  for (const t of tasks)
    if (t.status === 'OPEN' && (next === null || t.dueAt.getTime() < next.getTime()))
      next = t.dueAt;
  return next;
}

export const isOverdue = (t: { status: string; dueAt: Date }, now: Date) =>
  t.status === 'OPEN' && t.dueAt.getTime() < now.getTime();

// ---------------------------------------------------------------------------------------------
// My Day (FR-101): overdue, due today, upcoming (7 days), "sorted by priority then lead intent
// (Hot first) then due time". The day windows are FR-056's (followUpDueRange); a final id
// tie-break makes the order deterministic.

export type MyDayBucket = 'overdue' | 'today' | 'upcoming';

const PRIORITY_RANK: Record<string, number> = { URGENT: 0, HIGH: 1, NORMAL: 2, LOW: 3 };
const INTENT_RANK: Record<string, number> = { HOT: 0, WARM: 1, COLD: 2 };

/** The bucket of a due time, or null outside My Day (8 or more local days ahead). */
export function myDayBucket(dueAt: Date, now: Date, tomorrow: Date, end: Date): MyDayBucket | null {
  const t = dueAt.getTime();
  if (t < now.getTime()) return 'overdue';
  if (t < tomorrow.getTime()) return 'today';
  if (t < end.getTime()) return 'upcoming';
  return null;
}

/** Priority (Urgent first), then lead intent (Hot first; none last), then due time, then id. */
export function compareMyDay(
  a: { priority: string; intent: string | null; dueAt: Date; id: string },
  b: { priority: string; intent: string | null; dueAt: Date; id: string },
): number {
  return (
    (PRIORITY_RANK[a.priority] ?? 9) - (PRIORITY_RANK[b.priority] ?? 9) ||
    (INTENT_RANK[a.intent ?? ''] ?? 9) - (INTENT_RANK[b.intent ?? ''] ?? 9) ||
    a.dueAt.getTime() - b.dueAt.getTime() ||
    (a.id < b.id ? -1 : a.id > b.id ? 1 : 0)
  );
}

// ---------------------------------------------------------------------------------------------
// Meetings (FR-104, ADR-0017): start (due_at) and end, at most 24 hours; an overlap is a warning.

/** The longest meeting accepted (also task_end_after_start in the database). */
export const MEETING_MAX_HOURS = 24;
/** Most people invited to one meeting (a typo guard, not a business rule). */
export const MAX_ATTENDEES = 30;

/** Why a meeting end is refused, or null when acceptable. Required (owner decision). */
export function meetingEndProblem(start: Date, end: Date | null): string | null {
  if (!end) return 'Enter when the meeting ends';
  if (end.getTime() <= start.getTime()) return 'The end must be after the start';
  if (end.getTime() - start.getTime() > MEETING_MAX_HOURS * 3_600_000)
    return `A meeting can last at most ${MEETING_MAX_HOURS} hours`;
  return null;
}

/**
 * Two meetings overlap when their [start, end) intervals intersect. A meeting saved before end
 * times existed counts as its start minute only.
 */
export function meetingsOverlap(
  a: { dueAt: Date; endAt: Date | null },
  b: { dueAt: Date; endAt: Date | null },
): boolean {
  const end = (m: { dueAt: Date; endAt: Date | null }) =>
    (m.endAt ?? new Date(m.dueAt.getTime() + 60_000)).getTime();
  return a.dueAt.getTime() < end(b) && b.dueAt.getTime() < end(a);
}

/** A date as a datetime-local input value (YYYY-MM-DDTHH:MM) in the org's time zone. */
export function orgLocalInput(d: Date, timeZone: string): string {
  const p = Object.fromEntries(
    new Intl.DateTimeFormat('en-GB', {
      timeZone,
      year: 'numeric',
      month: '2-digit',
      day: '2-digit',
      hour: '2-digit',
      minute: '2-digit',
      hourCycle: 'h23',
    })
      .formatToParts(d)
      .map((x) => [x.type, x.value]),
  );
  return `${p.year}-${p.month}-${p.day}T${p.hour}:${p.minute}`;
}
