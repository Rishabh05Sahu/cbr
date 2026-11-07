import Link from 'next/link';
import { notFound } from 'next/navigation';
import { Alert, Badge, Card, EmptyState, PageHeader } from '@/components/ui';
import { STAGE_LABELS } from '@/modules/leads';
import { drillDown, type DrillRow } from '@/modules/reporting';
import { pageContext, pageRequire } from '@/platform/auth/session';
import { DomainError } from '@/platform/errors';
import { fmtDateTime } from '../../leads/labels';
import {
  drillHref,
  extraLabel,
  filterQuery,
  FilterForm,
  FilterProblem,
  isFilterProblem,
  one,
  periodText,
  SCOPE_NOTE,
  TileBody,
  type SearchParams,
} from '../parts';

const BUCKETS: Record<DrillRow['bucket'], string | null> = {
  final: null,
  in_progress: 'In progress (window not over)',
  invalid: 'Invalid number (not in the ratio)',
};

/**
 * FR-133: the records behind one dashboard figure, from the same definition, scope and filters
 * as its tile, so the tile's count equals the number of counted rows listed here.
 */
export default async function DrillDownPage({
  params,
  searchParams,
}: {
  params: Promise<{ kpi: string }>;
  searchParams: Promise<SearchParams>;
}) {
  const { ctx } = await pageContext();
  pageRequire(ctx, 'report.read');
  const { kpi } = await params;
  const sp = await searchParams;
  const d = await drillDown(ctx, kpi, {
    period: one(sp.period),
    from: one(sp.from),
    to: one(sp.to),
    team: one(sp.team),
    user: one(sp.user),
    source: one(sp.source),
    stage: one(sp.stage),
    page: one(sp.page),
    member: one(sp.member),
  }).catch((e: unknown) => {
    // An unknown report, or one outside the viewer's dashboard (K03 for an executive): 404.
    if (e instanceof DomainError && e.code === 'NOT_FOUND' && !e.fieldErrors) notFound();
    // A refused, malformed or missing filter: no figures, never a wider view.
    if (isFilterProblem(e)) return e;
    throw e;
  });
  if (d instanceof DomainError) return <FilterProblem error={d} />;
  const t = d.tile;
  const extra: Record<string, string> = {
    ...(d.stage ? { stage: d.stage } : {}),
    ...(d.perMember ? { member: '1' } : {}),
  };
  const pages = Math.max(1, Math.ceil(d.totalRows / d.pageSize));
  const isRatio = t.def?.kind === 'ratio';
  return (
    <>
      <p className="mb-2 text-sm">
        <Link
          href={`/app/dashboard?${filterQuery(d.filters)}` as '/app/dashboard'}
          className="tap text-blue-900 underline-offset-2 hover:underline"
        >
          ← Dashboard
        </Link>
      </p>
      <PageHeader
        title={`${t.def ? `${t.def.code} ` : ''}${t.name}${
          d.stage ? `: ${(STAGE_LABELS as Record<string, string>)[d.stage]}` : ''
        }`}
        description={`${t.description} ${periodText(d.filters)}.`}
      />
      <div className="mb-4">
        <FilterForm
          action={`/app/dashboard/${kpi}`}
          scope={d.scope}
          filters={d.filters}
          options={d.options}
          hidden={extra}
        />
      </div>
      {d.error && (
        <div className="mb-4">
          <Alert tone="error">{d.error}. Showing this month instead.</Alert>
        </div>
      )}
      <div
        className="mb-4 rounded-lg border border-slate-200 bg-white p-3"
        data-testid="drill-summary"
      >
        <TileBody t={t} />
        {d.perMember && (
          <p className="mt-1 text-xs text-slate-600">
            Per-member view: every assignment spell counts for the person who held it.
          </p>
        )}
      </div>
      {t.unavailable ? (
        <EmptyState>Not available yet: {t.unavailable}</EmptyState>
      ) : (
        <Card>
          {d.rows.length === 0 ? (
            <EmptyState>No records.</EmptyState>
          ) : (
            <ul className="divide-y divide-slate-100" data-testid="drill-rows">
              {d.rows.map((r) => (
                <li key={r.id} className="space-y-1 py-2 text-sm" data-testid="drill-row">
                  <div className="flex flex-wrap items-center gap-x-2 gap-y-1">
                    <span className="font-medium text-slate-900">{fmtDateTime(r.at)}</span>
                    {r.extra && <Badge>{extraLabel(r.extra)}</Badge>}
                    {isRatio && r.bucket === 'final' && (
                      <Badge tone={r.num ? 'good' : 'neutral'}>
                        {r.num ? 'Counts in numerator' : 'Denominator only'}
                      </Badge>
                    )}
                    {BUCKETS[r.bucket] && <Badge tone="warn">{BUCKETS[r.bucket]}</Badge>}
                  </div>
                  <p>
                    {r.leadId ? (
                      <Link
                        href={`/app/leads/${r.leadId}` as '/app/leads'}
                        className="tap text-blue-900 underline-offset-2 hover:underline"
                      >
                        {r.leadName}
                      </Link>
                    ) : (
                      <span className="text-slate-600">No lead</span>
                    )}
                    {r.leadStage && (
                      <span className="text-xs text-slate-600">
                        {' '}
                        · now {extraLabel(r.leadStage)}
                      </span>
                    )}
                  </p>
                  {r.userName && <p className="text-xs text-slate-700">Credited to {r.userName}</p>}
                </li>
              ))}
            </ul>
          )}
          {pages > 1 && (
            <nav aria-label="Pages" className="mt-3 flex flex-wrap items-center gap-3 text-sm">
              {d.page > 1 && (
                <Link
                  className="tap text-blue-900 underline"
                  href={drillHref(kpi, d.filters, { ...extra, page: String(d.page - 1) })}
                >
                  ← Previous
                </Link>
              )}
              <span>
                Page {d.page} of {pages}
              </span>
              {d.page < pages && (
                <Link
                  className="tap text-blue-900 underline"
                  href={drillHref(kpi, d.filters, { ...extra, page: String(d.page + 1) })}
                >
                  Next →
                </Link>
              )}
            </nav>
          )}
        </Card>
      )}
      <p className="mt-4 text-xs text-slate-500">{SCOPE_NOTE}</p>
    </>
  );
}
