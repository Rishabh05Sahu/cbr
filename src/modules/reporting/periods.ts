// Report periods (metrics-and-kpis §1.2), free of the database so they can be unit tested:
// today, yesterday, this / last week (Monday–Sunday), this / last month, or a custom range of at
// most 366 days. All are org-local calendar days; a period is the half-open [first, end) range of
// day keys (YYYY-MM-DD), converted to instants in the org's time zone by the caller.
import { addDays, validDayKey, weekday } from '@/modules/tasks/calendar-rules';

export const PERIODS = [
  'today',
  'yesterday',
  'this_week',
  'last_week',
  'this_month',
  'last_month',
  'custom',
] as const;
export type PeriodKind = (typeof PERIODS)[number];
export const PERIOD_LABELS: Record<PeriodKind, string> = {
  today: 'Today',
  yesterday: 'Yesterday',
  this_week: 'This week',
  last_week: 'Last week',
  this_month: 'This month',
  last_month: 'Last month',
  custom: 'Custom range',
};
export const MAX_CUSTOM_DAYS = 366;

export interface Period {
  kind: PeriodKind;
  /** First day included (org-local). */
  first: string;
  /** Day after the last one included (exclusive). */
  end: string;
}

const monthStart = (key: string) => `${key.slice(0, 8)}01`;
function addMonths(key: string, n: number): string {
  const d = new Date(`${monthStart(key)}T00:00:00Z`);
  d.setUTCMonth(d.getUTCMonth() + n);
  return d.toISOString().slice(0, 10);
}
const daysBetween = (a: string, b: string) =>
  Math.round((Date.parse(`${b}T00:00:00Z`) - Date.parse(`${a}T00:00:00Z`)) / 86_400_000);

/**
 * The period for `kind` around `today` (an org-local day key). A custom range takes `from` and
 * `to` (both inclusive); it must be valid, in order and at most 366 days, otherwise the result is
 * an error message. Anything unknown falls back to this month.
 */
export function resolvePeriod(
  kind: string | undefined,
  today: string,
  custom: { from?: string | undefined; to?: string | undefined } = {},
): Period | { error: string } {
  switch (kind) {
    case 'today':
      return { kind, first: today, end: addDays(today, 1) };
    case 'yesterday':
      return { kind, first: addDays(today, -1), end: today };
    case 'this_week': {
      const first = addDays(today, -weekday(today));
      return { kind, first, end: addDays(first, 7) };
    }
    case 'last_week': {
      const end = addDays(today, -weekday(today));
      return { kind, first: addDays(end, -7), end };
    }
    case 'last_month':
      return { kind, first: addMonths(today, -1), end: monthStart(today) };
    case 'custom': {
      const from = validDayKey(custom.from);
      const to = validDayKey(custom.to);
      if (!from || !to) return { error: 'Enter both dates of the custom range' };
      if (to < from) return { error: 'The range ends before it starts' };
      if (daysBetween(from, to) + 1 > MAX_CUSTOM_DAYS)
        return { error: `A custom range covers at most ${MAX_CUSTOM_DAYS} days` };
      return { kind, first: from, end: addDays(to, 1) };
    }
    default:
      return { kind: 'this_month', first: monthStart(today), end: addMonths(today, 1) };
  }
}
