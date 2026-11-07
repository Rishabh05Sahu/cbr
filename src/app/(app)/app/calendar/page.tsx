import Link from 'next/link';
import { Alert, Badge, Card, PageHeader } from '@/components/ui';
import {
  calendar,
  CALENDAR_MAX,
  CALENDAR_VIEWS,
  TASK_TYPE_LABELS,
  type CalendarItem,
  type CalendarView,
} from '@/modules/tasks';
import { assignedVisits, type AssignedVisit } from '@/modules/visits';
import { can } from '@/platform/authz';
import { pageRequire, pageContext } from '@/platform/auth/session';
import { VisitEntry } from '../visits/visit-entry';

const VIEW_LABELS: Record<CalendarView, string> = { day: 'Day', week: 'Week', month: 'Month' };
const WEEKDAYS = ['Mon', 'Tue', 'Wed', 'Thu', 'Fri', 'Sat', 'Sun'];
/** Items named per day in a month cell before "+N more" (the day view lists them all). */
const MONTH_CELL_ITEMS = 3;

// The app shows times in India time (labels.ts fmtDateTime); day keys are org-local days.
const time = (d: Date) =>
  d.toLocaleTimeString('en-IN', { hour: 'numeric', minute: '2-digit', timeZone: 'Asia/Kolkata' });
const dayTitle = (key: string, opts: Intl.DateTimeFormatOptions) =>
  new Date(`${key}T00:00:00Z`).toLocaleDateString('en-IN', { ...opts, timeZone: 'UTC' });
const href = (view: CalendarView, date: string) =>
  `/app/calendar?view=${view}&date=${date}` as '/app/calendar';
const one = (v: string | string[] | undefined) => (Array.isArray(v) ? v[0] : v);

/**
 * FR-105 calendar: the signed-in member's own open tasks and the meetings they are invited to, by
 * day, week (Monday first) or month, with previous / today / next navigation. Read-only: tasks are
 * changed on My Day or the lead page. Same visibility as My Day (ADR-0018).
 */
export default async function CalendarPage({
  searchParams,
}: {
  searchParams: Promise<Record<string, string | string[] | undefined>>;
}) {
  const { ctx } = await pageContext();
  pageRequire(ctx, 'task.read');
  const sp = await searchParams;
  const cal = await calendar(ctx, { view: one(sp.view), date: one(sp.date) });
  // Owner decision 2026-10-30: the site visits assigned to me in this period (never others').
  const visitsByDay: Record<string, AssignedVisit[]> = {};
  if (can(ctx, 'site_visit.read'))
    for (const v of await assignedVisits(ctx, {
      fromDay: cal.period.first,
      toDay: cal.period.end,
    }))
      (visitsByDay[v.day] ??= []).push(v);
  const { period } = cal;
  const title =
    period.view === 'month'
      ? dayTitle(period.date, { month: 'long', year: 'numeric' })
      : period.view === 'week'
        ? `${dayTitle(period.days[0]!, { day: 'numeric', month: 'short' })} – ${dayTitle(
            period.days[6]!,
            { day: 'numeric', month: 'short', year: 'numeric' },
          )}`
        : dayTitle(period.date, {
            weekday: 'long',
            day: 'numeric',
            month: 'long',
            year: 'numeric',
          });
  const count =
    Object.values(cal.byDay).reduce((n, l) => n + l.length, 0) +
    Object.values(visitsByDay).reduce((n, l) => n + l.length, 0);

  return (
    <>
      <PageHeader
        title="Calendar"
        description="Your open follow-ups, tasks and meetings, and meetings you are invited to. Change them on My Day or the lead's page."
      />
      <nav aria-label="Calendar period" className="mb-4 space-y-3">
        <div className="flex flex-wrap items-center gap-2" role="group" aria-label="View">
          {CALENDAR_VIEWS.map((v) => (
            <Link
              key={v}
              href={href(v, period.date)}
              aria-current={v === period.view ? 'page' : undefined}
              className={`tap rounded-md border px-3 py-1.5 text-sm ${
                v === period.view
                  ? 'border-blue-900 bg-blue-900 text-white'
                  : 'border-slate-300 bg-white text-slate-800 hover:bg-slate-50'
              }`}
            >
              {VIEW_LABELS[v]}
            </Link>
          ))}
        </div>
        <div className="flex flex-wrap items-center gap-2">
          <Link
            href={href(period.view, period.prev)}
            className="tap rounded-md border border-slate-300 bg-white px-3 py-1.5 text-sm"
            aria-label={`Previous ${period.view}`}
          >
            ← Previous
          </Link>
          <Link
            href={href(period.view, cal.today)}
            className="tap rounded-md border border-slate-300 bg-white px-3 py-1.5 text-sm"
          >
            Today
          </Link>
          <Link
            href={href(period.view, period.next)}
            className="tap rounded-md border border-slate-300 bg-white px-3 py-1.5 text-sm"
            aria-label={`Next ${period.view}`}
          >
            Next →
          </Link>
          <h2 className="text-base font-semibold text-slate-900" aria-live="polite">
            {title}
          </h2>
        </div>
      </nav>
      {cal.truncated && (
        <div className="mb-4">
          <Alert tone="warn">
            More than {CALENDAR_MAX} items fall in this period. The earliest {CALENDAR_MAX} are
            shown.
          </Alert>
        </div>
      )}
      {period.view === 'month' ? (
        <MonthGrid cal={cal} visitsByDay={visitsByDay} />
      ) : (
        <div className={period.view === 'week' ? 'grid gap-3 lg:grid-cols-7' : ''}>
          {period.days.map((d) => (
            <DayColumn
              key={d}
              day={d}
              items={cal.byDay[d] ?? []}
              visits={visitsByDay[d] ?? []}
              today={d === cal.today}
              heading={
                period.view === 'week'
                  ? dayTitle(d, { weekday: 'short', day: 'numeric', month: 'short' })
                  : null
              }
            />
          ))}
        </div>
      )}
      {count === 0 && period.view !== 'month' && (
        <p className="mt-3 text-sm text-slate-600">Nothing scheduled in this period.</p>
      )}
    </>
  );
}

function DayColumn({
  day,
  items,
  visits,
  today,
  heading,
}: {
  day: string;
  items: CalendarItem[];
  visits: AssignedVisit[];
  today: boolean;
  heading: string | null;
}) {
  return (
    <section aria-label={dayTitle(day, { weekday: 'long', day: 'numeric', month: 'long' })}>
      {heading && (
        <h3 className="mb-1 flex items-center gap-2 text-sm font-semibold text-slate-900">
          <Link href={href('day', day)} className="tap underline-offset-2 hover:underline">
            {heading}
          </Link>
          {today && <Badge tone="good">Today</Badge>}
        </h3>
      )}
      <Card>
        {items.length === 0 && visits.length === 0 ? (
          <p className="text-sm text-slate-500">Nothing scheduled.</p>
        ) : (
          <ul className="divide-y divide-slate-100">
            {visits.map((v) => (
              <VisitEntry key={v.id} v={v} />
            ))}
            {items.map((t) => (
              <Entry key={t.id} t={t} />
            ))}
          </ul>
        )}
      </Card>
    </section>
  );
}

function Entry({ t }: { t: CalendarItem }) {
  return (
    <li className="space-y-1 py-2 text-sm" data-testid="calendar-item">
      <div className="flex flex-wrap items-center gap-x-2 gap-y-1">
        <span className="font-medium text-slate-900">
          {time(t.dueAt)}
          {t.endAt && `–${time(t.endAt)}`}
        </span>
        <Badge>{TASK_TYPE_LABELS[t.type]}</Badge>
        {t.attending && <Badge>Invited</Badge>}
        {t.overlaps && <Badge tone="warn">Overlaps</Badge>}
      </div>
      {t.title && <p className="text-slate-800">{t.title}</p>}
      {t.lead ? (
        <p>
          <Link
            href={`/app/leads/${t.lead.id}` as '/app/leads'}
            className="tap text-blue-900 underline-offset-2 hover:underline"
          >
            {t.lead.fullName}
          </Link>
        </p>
      ) : (
        <p className="text-xs text-slate-600">
          {!t.onLead ? 'No lead' : 'About a lead you cannot open'}
        </p>
      )}
      {t.location && <p className="text-xs text-slate-700">Where: {t.location}</p>}
      {t.attending && t.organiserName && (
        <p className="text-xs text-slate-600">Meeting of {t.organiserName}</p>
      )}
    </li>
  );
}

function MonthGrid({
  cal,
  visitsByDay,
}: {
  cal: Awaited<ReturnType<typeof calendar>>;
  visitsByDay: Record<string, AssignedVisit[]>;
}) {
  const { period } = cal;
  return (
    <div role="grid" aria-label="Month" className="rounded-md border border-slate-200 bg-white">
      <div role="row" className="grid grid-cols-7 border-b border-slate-200 text-center">
        {WEEKDAYS.map((w) => (
          <div key={w} role="columnheader" className="py-1 text-xs font-medium text-slate-600">
            {w}
          </div>
        ))}
      </div>
      {Array.from({ length: period.days.length / 7 }, (_, r) => (
        <div key={r} role="row" className="grid grid-cols-7">
          {period.days.slice(r * 7, r * 7 + 7).map((d) => {
            const items = cal.byDay[d] ?? [];
            const visits = visitsByDay[d] ?? [];
            const total = items.length + visits.length;
            const outside = period.outside.has(d);
            return (
              <div
                key={d}
                role="gridcell"
                className={`min-h-14 border-b border-r border-slate-100 p-1 sm:min-h-24 ${
                  outside ? 'bg-slate-50 text-slate-400' : ''
                }`}
              >
                <Link
                  href={href('day', d)}
                  className={`tap inline-block rounded px-1 text-xs ${
                    d === cal.today ? 'bg-blue-900 font-semibold text-white' : ''
                  }`}
                  aria-label={`${dayTitle(d, { weekday: 'long', day: 'numeric', month: 'long' })}: ${
                    total
                  } item${total === 1 ? '' : 's'}`}
                >
                  {Number(d.slice(8))}
                </Link>
                {/* Phones: a count; wider screens: the first items by time. */}
                {total > 0 && (
                  <span className="ml-1 rounded bg-blue-50 px-1 text-xs text-blue-900 sm:hidden">
                    {total}
                  </span>
                )}
                <ul className="mt-1 hidden space-y-0.5 sm:block">
                  {visits.slice(0, MONTH_CELL_ITEMS).map((v) => (
                    <li key={v.id} className="truncate text-xs" data-testid="calendar-visit">
                      <span className="text-slate-500">{time(v.scheduledFor)}</span> Site visit
                    </li>
                  ))}
                  {items.slice(0, Math.max(0, MONTH_CELL_ITEMS - visits.length)).map((t) => (
                    <li key={t.id} className="truncate text-xs" data-testid="calendar-item">
                      <span className="text-slate-500">{time(t.dueAt)}</span>{' '}
                      {t.title ?? TASK_TYPE_LABELS[t.type]}
                    </li>
                  ))}
                  {total > MONTH_CELL_ITEMS && (
                    <li className="text-xs">
                      <Link href={href('day', d)} className="text-blue-900 underline">
                        +{total - MONTH_CELL_ITEMS} more
                      </Link>
                    </li>
                  )}
                </ul>
              </div>
            );
          })}
        </div>
      ))}
    </div>
  );
}
