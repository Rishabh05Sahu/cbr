// Shared pieces of the dashboard and its drill-downs (FR-130–133, ADR-0023): the filter form (a
// plain GET form, so filters live in the URL and every link keeps them), tiles and value labels.
import Link from 'next/link';
import { Alert, Badge, Button, Field, Input, PageHeader, Select } from '@/components/ui';
import { STAGE_LABELS } from '@/modules/leads';
import {
  LOW_SAMPLE,
  percent,
  PERIOD_LABELS,
  PERIODS,
  type FilterOptions,
  type ReportFilters,
  type ReportScope,
  type TileValue,
} from '@/modules/reporting';
import { DomainError } from '@/platform/errors';
import { CHANNEL_LABELS } from '@/modules/interactions/rules';

export type SearchParams = Record<string, string | string[] | undefined>;

/** The current-scope rule (ADR-0023 owner decision), shown on the dashboard and drill-downs. */
export const SCOPE_NOTE =
  'Figures cover only leads you can open now: when a lead is reassigned outside your scope, its earlier activity leaves your dashboard and drill-downs (the activity and audit records themselves are unchanged).';
export const one = (v: string | string[] | undefined) => (Array.isArray(v) ? v[0] : v);

/** The filters as query parameters, so tiles and drill-downs keep the same frame. */
export function filterQuery(f: ReportFilters, extra: Record<string, string> = {}): string {
  const q = new URLSearchParams({ period: f.period.kind });
  if (f.period.kind === 'custom') {
    q.set('from', f.period.first);
    const last = new Date(`${f.period.end}T00:00:00Z`);
    last.setUTCDate(last.getUTCDate() - 1);
    q.set('to', last.toISOString().slice(0, 10));
  }
  if (f.teamId) q.set('team', f.teamId);
  if (f.userId) q.set('user', f.userId);
  if (f.sourceId) q.set('source', f.sourceId);
  for (const [k, v] of Object.entries(extra)) q.set(k, v);
  return q.toString();
}

/**
 * A filter the reporting module refused: outside the viewer's scope (FORBIDDEN), malformed
 * (VALIDATION_FAILED) or a missing lead source (NOT_FOUND). The module names the filter in
 * `fieldErrors`; an unknown report (NOT_FOUND without it) and every other error are not this.
 */
export function isFilterProblem(e: unknown): e is DomainError {
  return (
    e instanceof DomainError &&
    (e.code === 'FORBIDDEN' ||
      ((e.code === 'VALIDATION_FAILED' || e.code === 'NOT_FOUND') && e.fieldErrors !== undefined))
  );
}

/**
 * No figure is shown. Out of scope: the same message whether the team or person exists or not.
 * Malformed or missing: the module's own message ("Choose a valid person", "Lead source not
 * found").
 */
export function FilterProblem({ error }: { error: DomainError }) {
  return (
    <>
      <PageHeader title="Dashboard" />
      <Alert tone="error">
        {error.code === 'FORBIDDEN'
          ? 'You can only filter by teams and people within your reporting scope.'
          : `This filter cannot be used: ${error.message}.`}{' '}
        No figures are shown for this filter.
      </Alert>
      <p className="mt-4 text-sm">
        <Link
          href="/app/dashboard"
          className="tap text-blue-900 underline-offset-2 hover:underline"
        >
          Back to the dashboard
        </Link>
      </p>
    </>
  );
}

export const drillHref = (id: string, f: ReportFilters, extra: Record<string, string> = {}) =>
  `/app/dashboard/${id}?${filterQuery(f, extra)}` as '/app/dashboard';

/** The last day included, for display ("1 Oct – 31 Oct 2026"). */
export function periodText(f: ReportFilters): string {
  const fmt = (key: string, year: boolean) =>
    new Date(`${key}T00:00:00Z`).toLocaleDateString('en-IN', {
      day: 'numeric',
      month: 'short',
      ...(year ? { year: 'numeric' } : {}),
      timeZone: 'UTC',
    });
  const last = new Date(`${f.period.end}T00:00:00Z`);
  last.setUTCDate(last.getUTCDate() - 1);
  const lastKey = last.toISOString().slice(0, 10);
  return f.period.first === lastKey
    ? fmt(lastKey, true)
    : `${fmt(f.period.first, false)} – ${fmt(lastKey, true)}`;
}

export function FilterForm({
  action,
  scope,
  filters,
  options,
  hidden = {},
}: {
  action: string;
  scope: ReportScope;
  filters: ReportFilters;
  options: FilterOptions;
  hidden?: Record<string, string>;
}) {
  const custom = filters.period.kind === 'custom';
  const last = new Date(`${filters.period.end}T00:00:00Z`);
  last.setUTCDate(last.getUTCDate() - 1);
  return (
    <form
      method="get"
      action={action}
      aria-label="Report filters"
      className="grid gap-3 rounded-lg border border-slate-200 bg-white p-4 sm:grid-cols-2 lg:grid-cols-6"
    >
      {Object.entries(hidden).map(([k, v]) => (
        <input key={k} type="hidden" name={k} value={v} />
      ))}
      <Field label="Period" htmlFor="rp-period">
        <Select id="rp-period" name="period" defaultValue={filters.period.kind}>
          {PERIODS.map((p) => (
            <option key={p} value={p}>
              {PERIOD_LABELS[p]}
            </option>
          ))}
        </Select>
      </Field>
      <Field label="From (custom)" htmlFor="rp-from">
        <Input
          id="rp-from"
          name="from"
          type="date"
          defaultValue={custom ? filters.period.first : ''}
        />
      </Field>
      <Field label="To (custom)" htmlFor="rp-to" hint="Up to 366 days">
        <Input
          id="rp-to"
          name="to"
          type="date"
          defaultValue={custom ? last.toISOString().slice(0, 10) : ''}
        />
      </Field>
      {scope !== 'OWN' && (
        <Field label="Team" htmlFor="rp-team">
          <Select id="rp-team" name="team" defaultValue={filters.teamId ?? ''}>
            <option value="">{scope === 'ORG' ? 'All teams' : 'All my teams'}</option>
            {options.teams.map((t) => (
              <option key={t.id} value={t.id}>
                {t.name}
              </option>
            ))}
          </Select>
        </Field>
      )}
      {scope !== 'OWN' && (
        <Field label="Person" htmlFor="rp-user">
          <Select id="rp-user" name="user" defaultValue={filters.userId ?? ''}>
            <option value="">Everyone in scope</option>
            {options.users.map((u) => (
              <option key={u.id} value={u.id}>
                {u.name}
              </option>
            ))}
          </Select>
        </Field>
      )}
      <Field label="Lead source" htmlFor="rp-source">
        <Select id="rp-source" name="source" defaultValue={filters.sourceId ?? ''}>
          <option value="">All sources</option>
          {options.sources.map((s) => (
            <option key={s.id} value={s.id}>
              {s.name}
            </option>
          ))}
        </Select>
      </Field>
      <div className="flex items-end sm:col-span-2 lg:col-span-6">
        <Button type="submit">Apply filters</Button>
      </div>
    </form>
  );
}

/** A KPI tile's value: count, ratio (with sample size) or "—" with the reason. */
export function TileBody({ t }: { t: TileValue }) {
  if (t.unavailable)
    return (
      <>
        <p className="text-2xl font-semibold text-slate-400" aria-label="Not available">
          —
        </p>
        <p className="text-xs text-slate-600">{t.unavailable}</p>
      </>
    );
  if (t.ratio) {
    const r = t.ratio;
    // K08's own rule: hidden below the low-sample threshold (metrics-and-kpis §3).
    const hidden = t.id === 'k08' && r.lowSample;
    return (
      <>
        <p
          className={`text-2xl font-semibold ${r.lowSample ? 'text-slate-400' : 'text-slate-900'}`}
          data-testid="tile-value"
        >
          {hidden ? '—' : percent(r)}
        </p>
        <p className="text-xs text-slate-600">
          {r.numerator} of {r.denominator}
          {r.inProgress !== undefined && ` · ${r.inProgress} in progress`}
          {r.invalid ? ` · ${r.invalid} invalid number` : ''}
        </p>
        {r.lowSample && (
          <Badge tone="warn">
            Low sample{hidden ? ` (under ${LOW_SAMPLE}, hidden)` : ` (under ${LOW_SAMPLE})`}
          </Badge>
        )}
      </>
    );
  }
  return (
    <>
      <p className="text-2xl font-semibold text-slate-900" data-testid="tile-value">
        {t.count}
      </p>
      {t.medianAgeHours !== undefined && (
        <p className="text-xs text-slate-600">
          Median age in queue:{' '}
          {t.medianAgeHours === null ? '—' : `${Math.round(t.medianAgeHours * 10) / 10} h`}
        </p>
      )}
    </>
  );
}

export function Tile({ t, filters }: { t: TileValue; filters: ReportFilters }) {
  return (
    <li
      className="flex flex-col gap-1 rounded-lg border border-slate-200 bg-white p-3 shadow-sm"
      data-testid="kpi-tile"
      data-kpi={t.id}
    >
      <div className="flex flex-wrap items-center gap-2">
        {t.def && <span className="text-xs font-medium text-slate-500">{t.def.code}</span>}
        {t.unavailable ? (
          <span className="text-sm font-medium text-slate-900">{t.name}</span>
        ) : (
          <Link
            href={drillHref(t.id, filters)}
            className="tap text-sm font-medium text-blue-900 underline-offset-2 hover:underline"
          >
            {t.name}
          </Link>
        )}
      </div>
      <TileBody t={t} />
    </li>
  );
}

const human = (s: string) => s.charAt(0) + s.slice(1).toLowerCase().replaceAll('_', ' ');
/** Drill-down badges: stages, interaction channels and the Call / WhatsApp buttons (K04). */
const EXTRA_LABELS: Record<string, string> = {
  ...(STAGE_LABELS as Record<string, string>),
  ...(CHANNEL_LABELS as Record<string, string>),
  CALL_BUTTON: 'Call button tap',
  WHATSAPP_BUTTON: 'WhatsApp button tap',
};
export const extraLabel = (s: string | null) => (s === null ? '' : (EXTRA_LABELS[s] ?? human(s)));
