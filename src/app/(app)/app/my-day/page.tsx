import Link from 'next/link';
import { ActionForm } from '@/components/action-form';
import { Alert, Badge, Card, EmptyState, Field, Input, PageHeader, Select } from '@/components/ui';
import { STAGE_LABELS, type LeadStage } from '@/modules/leads';
import {
  assigneeOptions,
  attendeeOptions,
  listMySeries,
  MY_DAY_LATER_MAX,
  MY_DAY_MAX,
  myDay,
  NEW_TASK_TYPES,
  TASK_PRIORITIES,
  TASK_TYPE_LABELS,
  type FollowUpView,
  type MyDayItem,
  type SeriesView,
} from '@/modules/tasks';
import { createSeriesAction, createTaskAction } from '@/modules/tasks/actions';
import { can } from '@/platform/authz';
import { pageContext, pageRequire } from '@/platform/auth/session';
import { FollowUpRow } from '../leads/[id]/follow-up-row';
import { MeetingFields, meetingSummary, type MeetingPerson } from '../leads/[id]/meeting-fields';
import { SeriesFields } from './series-fields';
import { SeriesList } from './series-list';
import { assignedVisits } from '@/modules/visits';
import { VisitEntry } from '../visits/visit-entry';
import { fmtDateTime, label } from '../leads/labels';

const PRIORITY: Record<string, string> = { URGENT: 'Urgent', HIGH: 'High', LOW: 'Low' };

const SECTIONS = [
  { key: 'overdue', title: 'Overdue', empty: 'Nothing overdue.' },
  { key: 'today', title: 'Due today', empty: 'Nothing else due today.' },
  { key: 'upcoming', title: 'Upcoming (next 7 days)', empty: 'Nothing due in the next 7 days.' },
] as const;

/**
 * FR-101 My Day: the signed-in member's own open tasks of every type that are overdue, due today
 * or due in the next 7 days (org time zone), each section ordered by priority, then lead intent
 * (Hot first), then due time; then open tasks due later. A lead's tasks are completed,
 * rescheduled and cancelled on the lead page; tasks with no lead are added and changed here
 * (FR-100, ADR-0015). Meetings show their end, location and attendees; meetings the caller is
 * invited to appear read-only (FR-104, ADR-0017). Owners, Admins and Sales Managers also manage
 * their recurring no-lead tasks here (FR-107, ADR-0020).
 */
export default async function MyDayPage() {
  const { ctx } = await pageContext();
  pageRequire(ctx, 'task.read');
  const [day, people, invitees, series, visits] = await Promise.all([
    myDay(ctx),
    assigneeOptions(ctx, null),
    attendeeOptions(ctx),
    listMySeries(ctx),
    // Owner decision 2026-10-30: visits assigned to me, open, up to the end of the 7-day window.
    can(ctx, 'site_visit.read') ? assignedVisits(ctx, { nextDays: 7 }) : Promise.resolve([]),
  ]);
  const total = day.overdue.length + day.today.length + day.upcoming.length;
  return (
    <>
      <PageHeader
        title="My Day"
        description="Your open follow-ups and tasks: overdue, due today and the next 7 days. Most urgent first, then Hot leads."
      />
      {day.truncated && (
        <div className="mb-4">
          <Alert tone="warn">
            You have more than {MY_DAY_MAX} open tasks in this period. The earliest-due {MY_DAY_MAX}{' '}
            are shown.
          </Alert>
        </div>
      )}
      {can(ctx, 'task.create') && <NewTask people={people} invitees={invitees} />}
      {can(ctx, 'task.recur') && <Repeating series={series} invitees={invitees} />}
      {visits.length > 0 && (
        <section aria-labelledby="myday-visits" className="mb-6">
          <h2
            id="myday-visits"
            className="mb-2 flex items-center gap-2 text-base font-semibold text-slate-900"
          >
            Your site visits <Badge>{visits.length}</Badge>
          </h2>
          <Card>
            <ul className="divide-y divide-slate-100">
              {visits.map((v) => (
                <VisitEntry key={v.id} v={v} withDate />
              ))}
            </ul>
          </Card>
        </section>
      )}
      {total === 0 ? (
        <Card>
          <EmptyState>
            Nothing due in the next 7 days. Schedule a follow-up from a lead&apos;s page, or add a
            task above.
          </EmptyState>
        </Card>
      ) : (
        <div className="space-y-6">
          {SECTIONS.map((s) => (
            <section key={s.key} aria-labelledby={`myday-${s.key}`}>
              <h2
                id={`myday-${s.key}`}
                className="mb-2 flex items-center gap-2 text-base font-semibold text-slate-900"
              >
                {s.title}
                <Badge tone={s.key === 'overdue' && day.overdue.length ? 'warn' : 'neutral'}>
                  {day[s.key].length}
                </Badge>
              </h2>
              <Card>
                {day[s.key].length === 0 ? (
                  <p className="text-sm text-slate-600">{s.empty}</p>
                ) : (
                  <ul className="divide-y divide-slate-100">
                    {day[s.key].map((t) => (
                      <Item key={t.id} task={t} overdue={s.key === 'overdue'} invitees={invitees} />
                    ))}
                  </ul>
                )}
              </Card>
            </section>
          ))}
        </div>
      )}
      {day.later.length > 0 && (
        <section aria-labelledby="myday-later" className="mt-6">
          <h2
            id="myday-later"
            className="mb-2 flex items-center gap-2 text-base font-semibold text-slate-900"
          >
            Later
            <Badge>{day.later.length}</Badge>
          </h2>
          <Card>
            <ul className="divide-y divide-slate-100">
              {day.later.map((t) => (
                <Item key={t.id} task={t} overdue={false} invitees={invitees} />
              ))}
            </ul>
            {day.later.length === MY_DAY_LATER_MAX && (
              <p className="mt-2 text-xs text-slate-600">
                The earliest {MY_DAY_LATER_MAX} are shown.
              </p>
            )}
          </Card>
        </section>
      )}
    </>
  );
}

/**
 * FR-100: a task with no lead (tasks on a lead are added on its page), for oneself or, with
 * task.assign, for someone the caller may give tasks to (FR-103). A task for someone else does
 * not appear here; it appears on their My Day.
 */
function NewTask({
  people,
  invitees,
}: {
  people: { userId: string; name: string }[];
  invitees: MeetingPerson[];
}) {
  return (
    <div className="mb-6">
      <Card
        title="Add a task"
        description="Not about a lead. Times are in your organisation's time zone."
      >
        <ActionForm
          action={createTaskAction}
          successMessage="Task added."
          submitLabel="Add task"
          fieldLabels={{
            type: 'Type',
            title: 'Task',
            dueAt: 'Date and time',
            assigneeUserId: 'For',
            endAt: 'Ends at',
            location: 'Location or link',
            attendeeUserIds: 'Attendees',
          }}
          className="space-y-4"
        >
          <div className="grid gap-4 sm:grid-cols-2">
            {people.length > 0 && (
              <Field label="For" htmlFor="nt-for" hint="They are notified in the app.">
                <Select id="nt-for" name="assigneeUserId" defaultValue="">
                  <option value="">Me</option>
                  {people.map((p) => (
                    <option key={p.userId} value={p.userId}>
                      {p.name}
                    </option>
                  ))}
                </Select>
              </Field>
            )}
            <Field label="Type" htmlFor="nt-type">
              <Select id="nt-type" name="type" defaultValue="" required>
                <option value="" disabled>
                  Choose…
                </option>
                {NEW_TASK_TYPES.map((t) => (
                  <option key={t} value={t}>
                    {TASK_TYPE_LABELS[t]}
                  </option>
                ))}
              </Select>
            </Field>
            <Field label="Date and time" htmlFor="nt-due">
              <Input id="nt-due" name="dueAt" type="datetime-local" required />
            </Field>
            <Field label="Task" htmlFor="nt-title">
              <Input id="nt-title" name="title" maxLength={200} required />
            </Field>
            <Field label="Priority" htmlFor="nt-priority">
              <Select id="nt-priority" name="priority" defaultValue="NORMAL">
                {TASK_PRIORITIES.map((p) => (
                  <option key={p} value={p}>
                    {p.charAt(0) + p.slice(1).toLowerCase()}
                  </option>
                ))}
              </Select>
            </Field>
            <MeetingFields idPrefix="nt-mt" people={invitees} />
          </div>
        </ActionForm>
      </Card>
    </div>
  );
}

/**
 * FR-107: recurring no-lead tasks of one's own (Owner, Admin, Sales Manager). One occurrence is
 * open at a time; the next is created when it is completed or cancelled.
 */
function Repeating({ series, invitees }: { series: SeriesView[]; invitees: MeetingPerson[] }) {
  return (
    <div className="mb-6">
      <Card
        title="Repeating tasks"
        description="For yourself, not about a lead. The next one is created when you complete or cancel the current one; missed days are skipped."
      >
        <div className="space-y-4">
          {series.length > 0 && <SeriesList series={series} people={invitees} />}
          <details className="rounded-md border border-slate-200 p-3">
            <summary className="tap cursor-pointer text-sm font-medium text-slate-900">
              Add a repeating task
            </summary>
            <ActionForm
              action={createSeriesAction}
              successMessage="Repeating task added. Its first occurrence is on My Day."
              submitLabel="Add repeating task"
              fieldLabels={{
                type: 'Type',
                title: 'Task',
                frequency: 'Repeats',
                weekday: 'Day of the week',
                localTime: 'Time',
                endDate: 'Ends on',
                durationMinutes: 'Length',
                location: 'Location or link',
                attendeeUserIds: 'Attendees',
              }}
              className="mt-3 space-y-4"
            >
              <Field label="Type" htmlFor="rs-type">
                <Select id="rs-type" name="type" defaultValue="" required>
                  <option value="" disabled>
                    Choose…
                  </option>
                  {NEW_TASK_TYPES.map((t) => (
                    <option key={t} value={t}>
                      {TASK_TYPE_LABELS[t]}
                    </option>
                  ))}
                </Select>
              </Field>
              <SeriesFields idPrefix="rs" people={invitees} meeting="maybe" />
            </ActionForm>
          </details>
        </div>
      </Card>
    </div>
  );
}

/** A task with no lead as the shared task row shows it, with its actions. */
const asView = (t: MyDayItem, overdue: boolean): FollowUpView => ({
  id: t.id,
  type: t.type,
  title: t.title,
  dueAt: t.dueAt,
  priority: t.priority,
  status: 'OPEN',
  assigneeUserId: '',
  assigneeName: null,
  assignedByName: t.assignedByName,
  rescheduleCount: t.rescheduleCount,
  completedAt: null,
  cancelledAt: null,
  cancelReason: null,
  version: t.version,
  overdue,
  canUpdate: t.canUpdate,
  rescheduleNeedsReason: t.rescheduleNeedsReason,
  endAt: t.endAt,
  location: t.location,
  attendees: t.attendees,
  endAtLocal: t.endAtLocal,
  seriesId: t.seriesId,
});

function Item({
  task: t,
  overdue,
  invitees,
}: {
  task: MyDayItem;
  overdue: boolean;
  invitees: MeetingPerson[];
}) {
  if (t.canUpdate)
    return (
      <FollowUpRow task={asView(t, overdue)} leadId={null} people={invitees}>
        <p className="text-xs text-slate-600">No lead</p>
      </FollowUpRow>
    );
  return (
    <li className="space-y-1 py-3 text-sm">
      <div className="flex flex-wrap items-center gap-x-2 gap-y-1">
        <span className="font-medium text-slate-900">{fmtDateTime(t.dueAt)}</span>
        {overdue && !t.attending && <Badge tone="warn">Overdue</Badge>}
        {t.type !== 'FOLLOW_UP' && <Badge>{TASK_TYPE_LABELS[t.type]}</Badge>}
        {t.attending && <Badge>Invited</Badge>}
        {t.seriesId && <Badge>Repeats</Badge>}
        {PRIORITY[t.priority] && <Badge>{PRIORITY[t.priority]} priority</Badge>}
        {t.lead?.intent && <Badge>{label(t.lead.intent)}</Badge>}
      </div>
      {!t.onLead ? (
        <p className="text-slate-600">No lead</p>
      ) : t.lead ? (
        <p>
          <Link
            href={`/app/leads/${t.lead.id}` as '/app/leads'}
            className="tap font-medium text-blue-900 underline-offset-2 hover:underline"
          >
            {t.lead.fullName}
          </Link>
          <span className="text-slate-600">
            {' '}
            · {STAGE_LABELS[t.lead.stage as LeadStage] ?? t.lead.stage}
          </span>
          {t.lead.archived && (
            <>
              {' '}
              <Badge tone="warn">Archived lead</Badge>
            </>
          )}
        </p>
      ) : (
        <p className="text-slate-600">
          {t.attending
            ? 'About a lead you cannot open.'
            : 'On a lead you can no longer open (it moved outside what you can see).'}
        </p>
      )}
      {t.title && <p className="text-slate-800">{t.title}</p>}
      {t.type === 'MEETING' &&
        meetingSummary(t, fmtDateTime).map((line) => (
          <p key={line} className="text-xs text-slate-700">
            {line}
          </p>
        ))}
      {t.attending && t.organiserName && (
        <p className="text-xs text-slate-600">Meeting of {t.organiserName} (you are invited)</p>
      )}
      {t.assignedByName && <p className="text-xs text-slate-600">Assigned by {t.assignedByName}</p>}
      {t.rescheduleCount > 0 && (
        <p className="text-xs text-slate-600">
          Rescheduled {t.rescheduleCount} time{t.rescheduleCount === 1 ? '' : 's'}
        </p>
      )}
    </li>
  );
}
