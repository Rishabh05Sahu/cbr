// FR-107 recurrence rules (ADR-0020), free of the database so they can be unit tested. A series
// repeats DAILY at an org-local time, or WEEKLY on one weekday (0 = Monday … 6 = Sunday) at that
// time, up to an optional inclusive end date (org-local day). The next occurrence is always
// strictly after a given moment: missed dates are skipped, never created as a backlog.
import { addDays, dayKeyIn, weekday } from './calendar-rules';

export const SERIES_FREQUENCIES = ['DAILY', 'WEEKLY'] as const;
export type SeriesFrequency = (typeof SERIES_FREQUENCIES)[number];
export const WEEKDAY_NAMES = [
  'Monday',
  'Tuesday',
  'Wednesday',
  'Thursday',
  'Friday',
  'Saturday',
  'Sunday',
] as const;

export interface SeriesRule {
  frequency: SeriesFrequency;
  /** WEEKLY only. */
  weekday: number | null;
  /** HH:MM, org-local. */
  localTime: string;
  /** YYYY-MM-DD, inclusive, org-local; null = until stopped. */
  endDate: string | null;
}

export const validLocalTime = (s: string | undefined): s is string =>
  !!s && /^([01]\d|2[0-3]):[0-5]\d$/.test(s);

/** An org-local wall-clock time as an instant (DST: the zone's own offset at that time). */
type ToInstant = (localDateTime: string) => Date | null;

/**
 * The first occurrence strictly after `after`, or null when it would fall after the end date.
 * `toInstant` turns "YYYY-MM-DDTHH:MM" in the org's zone into an instant (parseOrgLocal).
 */
export function nextOccurrence(
  rule: SeriesRule,
  after: Date,
  timeZone: string,
  toInstant: ToInstant,
): Date | null {
  // Start one day early: a local day can begin before `after`'s UTC day in zones east of UTC.
  // The day is advanced inside the body, not in the for-update clause: the dev bundler (Turbopack)
  // left an imported function called there unresolved ("addDays is not defined").
  const first = addDays(dayKeyIn(after, timeZone), -1);
  for (let i = 0; i < 9; i++) {
    const day = addDays(first, i);
    if (rule.frequency === 'WEEKLY' && weekday(day) !== rule.weekday) continue;
    const at = toInstant(`${day}T${rule.localTime}`);
    if (!at || at.getTime() <= after.getTime()) continue;
    if (rule.endDate && day > rule.endDate) return null;
    return at;
  }
  return null;
}

/** "Daily at 09:00" / "Every Monday at 09:00", with "until 30 Nov 2026" when it ends. */
export function describeSeries(rule: SeriesRule): string {
  const when =
    rule.frequency === 'DAILY'
      ? `Daily at ${rule.localTime}`
      : `Every ${WEEKDAY_NAMES[rule.weekday ?? 0]} at ${rule.localTime}`;
  if (!rule.endDate) return when;
  const end = new Date(`${rule.endDate}T00:00:00Z`).toLocaleDateString('en-IN', {
    day: 'numeric',
    month: 'short',
    year: 'numeric',
    timeZone: 'UTC',
  });
  return `${when}, until ${end}`;
}
