// FR-105 calendar periods (day / week / month), free of the database so they can be unit tested.
// Days are the org's local calendar days, written as YYYY-MM-DD keys. Weeks start on Monday (ISO
// 8601, as in India); a month view shows whole weeks around the month.

export const CALENDAR_VIEWS = ['day', 'week', 'month'] as const;
export type CalendarView = (typeof CALENDAR_VIEWS)[number];

const KEY = /^(\d{4})-(\d{2})-(\d{2})$/;

/** The key as a UTC-midnight date (calendar arithmetic only, never an instant of a task). */
function toUtc(key: string): Date | null {
  const m = KEY.exec(key);
  if (!m) return null;
  const d = new Date(Date.UTC(Number(m[1]), Number(m[2]) - 1, Number(m[3])));
  return d.getUTCDate() === Number(m[3]) && d.getUTCMonth() === Number(m[2]) - 1 ? d : null;
}
const fromUtc = (d: Date) => d.toISOString().slice(0, 10);

/** A valid day key, or null ("2026-02-30" and garbage are null). Years 2000–2100 only. */
export function validDayKey(key: string | undefined): string | null {
  if (!key) return null;
  const d = toUtc(key);
  if (!d) return null;
  const y = d.getUTCFullYear();
  return y >= 2000 && y <= 2100 ? key : null;
}

export function addDays(key: string, n: number): string {
  const d = toUtc(key)!;
  d.setUTCDate(d.getUTCDate() + n);
  return fromUtc(d);
}

/** 0 = Monday … 6 = Sunday. */
export function weekday(key: string): number {
  return (toUtc(key)!.getUTCDay() + 6) % 7;
}

function addMonths(key: string, n: number): string {
  const d = toUtc(key)!;
  const day = d.getUTCDate();
  d.setUTCDate(1);
  d.setUTCMonth(d.getUTCMonth() + n);
  const last = new Date(Date.UTC(d.getUTCFullYear(), d.getUTCMonth() + 1, 0)).getUTCDate();
  d.setUTCDate(Math.min(day, last));
  return fromUtc(d);
}

/** The org-local day of an instant. */
export function dayKeyIn(d: Date, timeZone: string): string {
  const p = Object.fromEntries(
    new Intl.DateTimeFormat('en-GB', {
      timeZone,
      year: 'numeric',
      month: '2-digit',
      day: '2-digit',
    })
      .formatToParts(d)
      .map((x) => [x.type, x.value]),
  );
  return `${p.year}-${p.month}-${p.day}`;
}

export interface CalendarPeriod {
  view: CalendarView;
  /** The chosen day (kept when switching views). */
  date: string;
  /** Days shown, in order; [first, end) is the range read. */
  days: string[];
  first: string;
  /** The day after the last one shown (exclusive end). */
  end: string;
  /** Days of a month view outside the month itself (shown dimmed). */
  outside: Set<string>;
  prev: string;
  next: string;
}

/** The days a view shows around `date`, and the dates of the previous and next periods. */
export function calendarPeriod(view: CalendarView, date: string): CalendarPeriod {
  let first: string;
  let count: number;
  const outside = new Set<string>();
  if (view === 'day') {
    first = date;
    count = 1;
  } else if (view === 'week') {
    first = addDays(date, -weekday(date));
    count = 7;
  } else {
    const monthStart = `${date.slice(0, 8)}01`;
    const monthEnd = addDays(addMonths(monthStart, 1), -1);
    first = addDays(monthStart, -weekday(monthStart));
    const last = addDays(monthEnd, 6 - weekday(monthEnd));
    count = Math.round((toUtc(last)!.getTime() - toUtc(first)!.getTime()) / 86_400_000) + 1;
  }
  const days = Array.from({ length: count }, (_, i) => addDays(first, i));
  if (view === 'month')
    for (const d of days) if (d.slice(0, 7) !== date.slice(0, 7)) outside.add(d);
  const step = view === 'day' ? 1 : view === 'week' ? 7 : 0;
  return {
    view,
    date,
    days,
    first,
    end: addDays(first, count),
    outside,
    prev: step ? addDays(date, -step) : addMonths(date, -1),
    next: step ? addDays(date, step) : addMonths(date, 1),
  };
}

/** View and date from the query string; anything invalid falls back to this week. */
export function parseCalendarQuery(
  view: string | undefined,
  date: string | undefined,
  today: string,
): { view: CalendarView; date: string } {
  return {
    view: (CALENDAR_VIEWS as readonly string[]).includes(view ?? '')
      ? (view as CalendarView)
      : 'week',
    date: validDayKey(date) ?? today,
  };
}
