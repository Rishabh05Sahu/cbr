import Link from 'next/link';
import { Alert, Badge, Card, PageHeader } from '@/components/ui';
import {
  COHORT_WINDOW_DAYS,
  dashboard,
  MEMBER_COUNTS,
  MEMBER_RATIOS,
  kpiById,
  percent,
  type Lens,
} from '@/modules/reporting';
import { pageContext, pageRequire } from '@/platform/auth/session';
import { DomainError } from '@/platform/errors';
import {
  drillHref,
  FilterForm,
  FilterProblem,
  isFilterProblem,
  one,
  periodText,
  SCOPE_NOTE,
  Tile,
  type SearchParams,
} from './parts';

const TITLES = {
  OWN: 'My dashboard',
  TEAM: 'Team dashboard',
  ORG: 'Organisation dashboard',
} as const;
const LENSES: { lens: Lens; title: string; note: string }[] = [
  {
    lens: 'Activity',
    title: 'Activity in the period',
    note: 'What happened in the period, credited to who did it.',
  },
  { lens: 'Snapshot', title: 'Right now', note: 'Current state; ignores the period.' },
  {
    lens: 'Cohort',
    title: 'Conversion (cohort)',
    note: `Leads entering in the period that reached the milestone within ${COHORT_WINDOW_DAYS} days. Only entries whose ${COHORT_WINDOW_DAYS} days have passed count; the rest are "in progress". The ${COHORT_WINDOW_DAYS}-day window is provisional while OD-02 is open. No targets are set.`,
  },
];

/**
 * FR-130 (Sales Executive: own), FR-131 (Sales Manager: teams led) and FR-132 (Owner/Admin:
 * organisation) dashboards in one page, chosen by the viewer's `report.read` scope (enforced in
 * the reporting module, not here). Every tile links to its drill-down (FR-133).
 */
export default async function DashboardPage({
  searchParams,
}: {
  searchParams: Promise<SearchParams>;
}) {
  const { ctx } = await pageContext();
  pageRequire(ctx, 'report.read');
  const sp = await searchParams;
  const d = await dashboard(ctx, {
    period: one(sp.period),
    from: one(sp.from),
    to: one(sp.to),
    team: one(sp.team),
    user: one(sp.user),
    source: one(sp.source),
  }).catch((e: unknown) => {
    // A refused, malformed or missing filter: no figures, never a wider view. Anything else is
    // a real error.
    if (isFilterProblem(e)) return e;
    throw e;
  });
  if (d instanceof DomainError) return <FilterProblem error={d} />;
  const f = d.filters;
  return (
    <>
      <PageHeader
        title={TITLES[d.scope]}
        description={`${periodText(f)} · times in ${d.timeZone}. Select a figure to see the records behind it.`}
      />
      <div className="mb-4">
        <FilterForm action="/app/dashboard" scope={d.scope} filters={f} options={d.options} />
      </div>
      {d.error && (
        <div className="mb-4">
          <Alert tone="error">{d.error}. Showing this month instead.</Alert>
        </div>
      )}

      <section aria-labelledby="dash-now" className="mb-6 space-y-2">
        <h2 id="dash-now" className="text-base font-semibold text-slate-900">
          {d.scope === 'OWN' ? 'Your work' : 'Team work'}
        </h2>
        <ul className="grid gap-3 sm:grid-cols-2 lg:grid-cols-3">
          {d.operational.map((t) => (
            <Tile key={t.id} t={t} filters={f} />
          ))}
        </ul>
        <Card title="Open leads by stage">
          <ul className="grid gap-2 sm:grid-cols-2 lg:grid-cols-4" data-testid="stage-counts">
            {d.stages.map((s) => (
              <li key={s.stage} className="flex items-center justify-between gap-2 text-sm">
                <Link
                  href={drillHref('open-by-stage', f, { stage: s.stage })}
                  className="tap text-blue-900 underline-offset-2 hover:underline"
                >
                  {s.label}
                </Link>
                <Badge>{s.count}</Badge>
              </li>
            ))}
          </ul>
        </Card>
      </section>

      {LENSES.map(({ lens, title, note }) => {
        const tiles = d.kpis.filter((t) => t.def?.lens === lens);
        if (!tiles.length) return null;
        return (
          <section key={lens} aria-labelledby={`dash-${lens}`} className="mb-6 space-y-2">
            <h2
              id={`dash-${lens}`}
              className="flex flex-wrap items-center gap-2 text-base font-semibold text-slate-900"
            >
              {title}
              {lens === 'Cohort' && <Badge tone="warn">Provisional window (OD-02)</Badge>}
            </h2>
            <p className="text-xs text-slate-600">{note}</p>
            <ul className="grid gap-3 sm:grid-cols-2 lg:grid-cols-4">
              {tiles.map((t) => (
                <Tile key={t.id} t={t} filters={f} />
              ))}
            </ul>
          </section>
        );
      })}

      {d.members && (
        <section aria-labelledby="dash-members" className="mb-6 space-y-2">
          <h2 id="dash-members" className="text-base font-semibold text-slate-900">
            Per member
          </h2>
          <p className="text-xs text-slate-600">
            Counts per person in the period. A lead reassigned in the period counts once for each
            person who held it. Ratios under 20 records are greyed as low sample.
          </p>
          <div className="overflow-x-auto rounded-lg border border-slate-200 bg-white">
            <table className="min-w-full text-sm" data-testid="member-table">
              <thead className="bg-slate-50 text-left text-xs text-slate-600">
                <tr>
                  <th scope="col" className="px-3 py-2">
                    Member
                  </th>
                  {[...MEMBER_COUNTS, ...MEMBER_RATIOS].map((id) => (
                    <th key={id} scope="col" className="px-3 py-2">
                      {kpiById(id)!.code} {kpiById(id)!.name}
                    </th>
                  ))}
                </tr>
              </thead>
              <tbody className="divide-y divide-slate-100">
                {d.members.map((m) => (
                  <tr key={m.userId}>
                    <th scope="row" className="px-3 py-2 text-left font-medium text-slate-900">
                      {m.name}
                    </th>
                    {MEMBER_COUNTS.map((id) => (
                      <td key={id} className="px-3 py-2">
                        <Link
                          className="text-blue-900 underline-offset-2 hover:underline"
                          href={drillHref(id, { ...f, userId: m.userId }, { member: '1' })}
                        >
                          {m.counts[id] ?? 0}
                        </Link>
                      </td>
                    ))}
                    {MEMBER_RATIOS.map((id) => {
                      const r = m.ratios[id];
                      return (
                        <td
                          key={id}
                          className={`px-3 py-2 ${!r || r.lowSample ? 'text-slate-400' : ''}`}
                        >
                          <Link
                            className="underline-offset-2 hover:underline"
                            href={drillHref(id, { ...f, userId: m.userId }, { member: '1' })}
                          >
                            {r ? `${percent(r)} (${r.numerator}/${r.denominator})` : '— (0)'}
                          </Link>
                        </td>
                      );
                    })}
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
        </section>
      )}
      <p className="text-xs text-slate-500">
        Excluded everywhere: test, deleted and merged-away leads (a merged lead&apos;s records count
        on the surviving lead). Invalid-number leads are left out of conversion denominators and
        shown separately. {SCOPE_NOTE}
      </p>
    </>
  );
}
