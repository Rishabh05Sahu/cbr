import Link from 'next/link';
import { Suspense, type ReactNode } from 'react';
import { Alert, Badge, Card, EmptyState, Field, Input, PageHeader, Select } from '@/components/ui';
import { listMembers } from '@/modules/members';
import {
  ARCHIVE_VIEWS,
  FOLLOW_UP_DUE,
  BULK_ARCHIVE_MAX,
  hasFilters,
  INTENTS,
  LEAD_SORTS,
  LEAD_STAGES,
  leadQueryString,
  listLeadSources,
  parseLeadQuery,
  PROPERTY_TYPES,
  assignmentTargets,
  listLeadTags,
  searchLeads,
  STAGE_LABELS,
  type SearchParams,
} from '@/modules/leads';
import { listTeams } from '@/modules/teams';
import { pageContext, pageRequire } from '@/platform/auth/session';
import { can, scopeOf, type RequestContext } from '@/platform/authz';
import { BulkActionsForm } from './bulk-actions-form';
import { fmtDateTime, label } from './labels';

const ERROR_LABELS: Record<string, string> = {
  q: 'Search',
  stage: 'Stage',
  intent: 'Intent',
  propertyType: 'Property type',
  owner: 'Owner',
  team: 'Team',
  source: 'Source',
  city: 'City',
  createdFrom: 'Created from',
  createdTo: 'Created to',
  assignedFrom: 'Assigned from',
  assignedTo: 'Assigned to',
  budgetFrom: 'Budget from',
  budgetTo: 'Budget up to',
  due: 'Follow-up due',
  archived: 'Archive view',
  sort: 'Sort',
  cursor: 'Page',
};

const ARCHIVE_VIEW_LABELS: Record<(typeof ARCHIVE_VIEWS)[number], string> = {
  active: 'Active leads',
  archived: 'Archived leads',
  all: 'Active and archived',
};

export default async function LeadsPage({ searchParams }: PageProps<'/app/leads'>) {
  const { ctx } = await pageContext();
  pageRequire(ctx, 'lead.read');
  const sp = await searchParams;
  const { query, errors } = parseLeadQuery(sp);
  // Filter options come only from the caller's own org and scope.
  const scope = scopeOf(ctx, 'lead.read');
  const wide = scope === 'TEAM' || scope === 'ORG';
  const [sources, people, teams] = await Promise.all([
    listLeadSources(ctx),
    wide && can(ctx, 'user.read') ? listMembers(ctx) : Promise.resolve([]),
    wide && can(ctx, 'team.read') ? listTeams(ctx) : Promise.resolve([]),
  ]);
  const filtered = hasFilters(query);
  const errorList = Object.entries(errors);

  const multi = (
    name: string,
    labelText: string,
    codes: readonly string[],
    values: string[],
    text: (c: string) => string,
  ) => (
    <Field label={labelText} htmlFor={`f-${name}`} hint="Ctrl/⌘-click for several">
      <Select id={`f-${name}`} name={name} multiple size={4} defaultValue={values}>
        {codes.map((c) => (
          <option key={c} value={c}>
            {text(c)}
          </option>
        ))}
      </Select>
    </Field>
  );
  const single = (name: string, labelText: string, value: string | null, children: ReactNode) => (
    <Field label={labelText} htmlFor={`f-${name}`}>
      <Select id={`f-${name}`} name={name} defaultValue={value ?? ''}>
        <option value="">Any</option>
        {children}
      </Select>
    </Field>
  );

  return (
    <>
      <div className="flex flex-wrap items-start justify-between gap-2">
        <PageHeader
          title="Leads"
          description="Leads you can see. Search by name, phone or email."
        />
        <div className="flex flex-wrap gap-2">
          {(can(ctx, 'lead.merge') || can(ctx, 'lead.archive')) && (
            <Link
              href="/app/leads/review"
              className="tap rounded-md border border-slate-300 bg-white px-3 py-2 text-sm font-medium text-slate-900 hover:bg-slate-50"
            >
              Review duplicates
            </Link>
          )}
          {can(ctx, 'lead.export') && (
            <Link
              href={
                `/app/leads/exports${leadQueryString({ ...query, cursor: null })}` as '/app/leads'
              }
              className="tap rounded-md border border-slate-300 bg-white px-3 py-2 text-sm font-medium text-slate-900 hover:bg-slate-50"
            >
              Export these leads
            </Link>
          )}
          {can(ctx, 'lead.assign') && (
            <Link
              href="/app/leads/queue"
              className="tap rounded-md border border-slate-300 bg-white px-3 py-2 text-sm font-medium text-slate-900 hover:bg-slate-50"
            >
              Unassigned queue
            </Link>
          )}
          {can(ctx, 'lead.import') && (
            <Link
              href="/app/leads/import"
              className="tap rounded-md border border-slate-300 bg-white px-3 py-2 text-sm font-medium text-slate-900 hover:bg-slate-50"
            >
              Import
            </Link>
          )}
          {can(ctx, 'lead.create') && (
            <Link
              href="/app/leads/new"
              className="tap rounded-md bg-blue-900 px-3 py-2 text-sm font-medium text-white hover:bg-blue-800"
            >
              New lead
            </Link>
          )}
        </div>
      </div>

      <Card>
        <form method="get" action="/app/leads" className="space-y-4" role="search">
          <div className="grid gap-4 sm:grid-cols-4">
            <div className="sm:col-span-2">
              <Field label="Search" htmlFor="f-q">
                <Input
                  id="f-q"
                  name="q"
                  type="search"
                  defaultValue={query.q ?? ''}
                  maxLength={100}
                  placeholder="Name, phone digits or email"
                />
              </Field>
            </div>
            <Field
              label="Show"
              htmlFor="f-archived"
              hint="Merged leads are reached from the lead they were merged into"
            >
              <Select id="f-archived" name="archived" defaultValue={query.archived}>
                {ARCHIVE_VIEWS.map((v) => (
                  <option key={v} value={v}>
                    {ARCHIVE_VIEW_LABELS[v]}
                  </option>
                ))}
              </Select>
            </Field>
            <Field label="Sort" htmlFor="f-sort">
              <Select id="f-sort" name="sort" defaultValue={query.sort}>
                {Object.entries(LEAD_SORTS).map(([v, t]) => (
                  <option key={v} value={v}>
                    {t}
                  </option>
                ))}
              </Select>
            </Field>
            {single(
              'source',
              'Source',
              query.sourceId,
              sources.map((s) => (
                <option key={s.id} value={s.id}>
                  {s.name}
                </option>
              )),
            )}
          </div>
          <details open={filtered} className="rounded-md border border-slate-200 p-3">
            <summary className="tap cursor-pointer text-sm font-medium text-slate-800">
              Filters
            </summary>
            <div className="mt-4 grid gap-4 sm:grid-cols-4">
              {multi(
                'stage',
                'Stage',
                LEAD_STAGES,
                query.stages,
                (c) => STAGE_LABELS[c as keyof typeof STAGE_LABELS],
              )}
              {multi('intent', 'Intent', INTENTS, query.intents, label)}
              {multi('propertyType', 'Property type', PROPERTY_TYPES, query.propertyTypes, label)}
              <div className="space-y-4">
                {single(
                  'due',
                  'Follow-up due',
                  query.followUpDue,
                  Object.entries(FOLLOW_UP_DUE).map(([v, t]) => (
                    <option key={v} value={v}>
                      {t}
                    </option>
                  )),
                )}
                {wide &&
                  single(
                    'owner',
                    'Owner',
                    query.owner,
                    <>
                      <option value="none">Unassigned</option>
                      {people.map((p) => (
                        <option key={p.userId} value={p.userId}>
                          {p.name}
                        </option>
                      ))}
                    </>,
                  )}
                {wide &&
                  teams.length > 0 &&
                  single(
                    'team',
                    'Team',
                    query.teamId,
                    teams.map((t) => (
                      <option key={t.id} value={t.id}>
                        {t.name}
                      </option>
                    )),
                  )}
              </div>
              <Field label="City" htmlFor="f-city">
                <Input id="f-city" name="city" defaultValue={query.city ?? ''} maxLength={100} />
              </Field>
              <Field label="Created from" htmlFor="f-createdFrom">
                <Input
                  id="f-createdFrom"
                  name="createdFrom"
                  type="date"
                  defaultValue={query.createdFrom ?? ''}
                />
              </Field>
              <Field label="Created to" htmlFor="f-createdTo">
                <Input
                  id="f-createdTo"
                  name="createdTo"
                  type="date"
                  defaultValue={query.createdTo ?? ''}
                />
              </Field>
              <Field label="Assigned from" htmlFor="f-assignedFrom" hint="To the current owner">
                <Input
                  id="f-assignedFrom"
                  name="assignedFrom"
                  type="date"
                  defaultValue={query.assignedFrom ?? ''}
                />
              </Field>
              <Field label="Assigned to" htmlFor="f-assignedTo">
                <Input
                  id="f-assignedTo"
                  name="assignedTo"
                  type="date"
                  defaultValue={query.assignedTo ?? ''}
                />
              </Field>
              <Field label="Budget (overlaps)" htmlFor="f-budgetFrom" hint="e.g. 50 L to 1.2 Cr">
                <div className="flex gap-2">
                  <Input
                    id="f-budgetFrom"
                    name="budgetFrom"
                    aria-label="Budget from"
                    defaultValue={
                      query.budgetFrom ?? (typeof sp.budgetFrom === 'string' ? sp.budgetFrom : '')
                    }
                    placeholder="from"
                  />
                  <Input
                    name="budgetTo"
                    aria-label="Budget up to"
                    defaultValue={
                      query.budgetTo ?? (typeof sp.budgetTo === 'string' ? sp.budgetTo : '')
                    }
                    placeholder="to"
                  />
                </div>
              </Field>
            </div>
          </details>
          <div className="flex flex-wrap items-center gap-3">
            <button
              type="submit"
              className="tap rounded-md bg-blue-900 px-3 py-2 text-sm font-medium text-white hover:bg-blue-800"
            >
              Apply
            </button>
            {(filtered || query.sort !== 'newest' || errorList.length > 0) && (
              <Link href="/app/leads" className="tap text-sm text-slate-700 underline">
                Clear
              </Link>
            )}
          </div>
        </form>
      </Card>

      <Suspense
        key={leadQueryString(query, query.cursor)}
        fallback={
          <div className="mt-6">
            <Card>
              <p role="status" className="text-sm text-slate-500">
                Loading leads…
              </p>
            </Card>
          </div>
        }
      >
        <LeadResults ctx={ctx} sp={sp} />
      </Suspense>
    </>
  );
}

/** Results stream in under a Suspense boundary; the page shell (and its 404 guard) comes first. */
async function LeadResults({ ctx, sp }: { ctx: RequestContext; sp: SearchParams }) {
  const { query, errors, rows, nextCursor } = await searchLeads(ctx, sp);
  // Bulk actions (FR-063), each shown only with its permissions; the server re-checks all of
  // them. Archive: lead.bulk_update + lead.archive. Change team: lead.assign (teams in scope).
  // Add tag: lead.bulk_update + lead.update. None on the archived view.
  const live = query.archived !== 'archived';
  const canArchive = live && can(ctx, 'lead.bulk_update') && can(ctx, 'lead.archive');
  const teams = live && can(ctx, 'lead.assign') ? (await assignmentTargets(ctx)).teams : null;
  const tags =
    live && can(ctx, 'lead.bulk_update') && can(ctx, 'lead.update')
      ? await listLeadTags(ctx)
      : null;
  const bulk = canArchive || teams !== null || tags !== null;
  const filtered = hasFilters(query);
  const errorList = Object.entries(errors);
  return (
    <div className="mt-6 space-y-4">
      {errorList.length > 0 && (
        <Alert tone="error">
          Please fix the search:
          <ul className="mt-1 list-disc pl-5">
            {errorList.map(([k, m]) => (
              <li key={k}>
                {ERROR_LABELS[k] ?? k}: {m}
              </li>
            ))}
          </ul>
        </Alert>
      )}
      <Card>
        {errorList.length > 0 ? (
          <EmptyState>No results until the search is fixed.</EmptyState>
        ) : (
          // The bulk form stays mounted when an action empties the list, so its result (e.g.
          // "Archived 2 leads.") is still shown above the empty state.
          <Bulk
            enabled={bulk}
            empty={rows.length === 0}
            archive={canArchive}
            teams={teams}
            tags={tags}
          >
            {rows.length === 0 ? (
              <EmptyState>
                {filtered
                  ? 'No leads match these filters.'
                  : query.cursor
                    ? 'No more leads.'
                    : 'No leads yet.'}
              </EmptyState>
            ) : (
              <div className="overflow-x-auto">
                <table className="min-w-full text-left text-sm">
                  <thead className="border-b text-xs uppercase text-slate-500">
                    <tr>
                      {bulk && (
                        <th className="py-2 pr-2">
                          <span className="sr-only">Select</span>
                        </th>
                      )}
                      <th className="py-2 pr-4">Lead</th>
                      <th className="py-2 pr-4">Stage</th>
                      <th className="py-2 pr-4">Intent</th>
                      <th className="py-2 pr-4">City</th>
                      <th className="py-2 pr-4">Owner</th>
                      <th className="py-2">Created</th>
                    </tr>
                  </thead>
                  <tbody className="divide-y divide-slate-100">
                    {rows.map((l) => (
                      <tr key={l.id}>
                        {bulk && (
                          <td className="py-2 pr-2">
                            {!l.archivedAt && (
                              <input
                                type="checkbox"
                                name="item"
                                value={`${l.id}:${l.version}`}
                                aria-label={`Select ${l.fullName}`}
                              />
                            )}
                          </td>
                        )}
                        <td className="py-2 pr-4">
                          <Link
                            href={`/app/leads/${l.id}` as '/app/leads'}
                            className="tap font-medium text-blue-900 underline-offset-2 hover:underline"
                          >
                            {l.fullName}
                          </Link>
                          {l.archivedAt && (
                            <>
                              {' '}
                              <Badge tone="warn">Archived</Badge>
                            </>
                          )}
                          <div className="text-xs text-slate-500">{l.primaryPhoneE164}</div>
                        </td>
                        <td className="py-2 pr-4">
                          <Badge>{STAGE_LABELS[l.stage]}</Badge>
                        </td>
                        <td className="py-2 pr-4">{label(l.intent)}</td>
                        <td className="py-2 pr-4">{l.preferredCity ?? '—'}</td>
                        <td className="py-2 pr-4">
                          {l.ownerName ?? 'Unassigned'}
                          {l.ownerActive === false && (
                            <>
                              {' '}
                              <Badge tone="warn">Inactive</Badge>
                            </>
                          )}
                          {l.teamName && <div className="text-xs text-slate-500">{l.teamName}</div>}
                        </td>
                        <td className="whitespace-nowrap py-2">{fmtDateTime(l.createdAt)}</td>
                      </tr>
                    ))}
                  </tbody>
                </table>
              </div>
            )}
          </Bulk>
        )}
        {errorList.length === 0 && (query.cursor || nextCursor) && (
          <nav aria-label="Pages" className="mt-4 flex justify-between text-sm">
            {query.cursor ? (
              <Link
                href={`/app/leads${leadQueryString(query)}` as '/app/leads'}
                className="tap underline"
              >
                ← First page
              </Link>
            ) : (
              <span />
            )}
            {nextCursor && (
              <Link
                href={`/app/leads${leadQueryString(query, nextCursor)}` as '/app/leads'}
                className="tap underline"
              >
                Next page →
              </Link>
            )}
          </nav>
        )}
      </Card>
    </div>
  );
}

function Bulk({
  enabled,
  empty,
  archive,
  teams,
  tags,
  children,
}: {
  enabled: boolean;
  empty: boolean;
  archive: boolean;
  teams: { id: string; name: string }[] | null;
  tags: { id: string; name: string }[] | null;
  children: ReactNode;
}) {
  return enabled ? (
    <BulkActionsForm
      max={BULK_ARCHIVE_MAX}
      empty={empty}
      archive={archive}
      teams={teams}
      tags={tags}
    >
      {children}
    </BulkActionsForm>
  ) : (
    children
  );
}
