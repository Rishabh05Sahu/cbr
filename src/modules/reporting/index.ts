// Reporting module (Phase 4 dashboards, FR-130–133; ADR-0023). Every figure is computed inside the
// viewer's `report.read` scope (Owner/Admin: organisation; Sales Manager: teams they lead; Sales
// Executive: themselves) and the selected filters, by the same row-set definition its drill-down
// lists (queries.ts), so a tile's count and its drill-down's count are equal by construction.
// Read-only: nothing here writes.
import { z } from 'zod';
import { parseOrgLocal, STAGE_LABELS } from '@/modules/leads';
import { addDays, dayKeyIn } from '@/modules/tasks/calendar-rules';
import { ledTeamIds } from '@/modules/teams';
import { authorize, type RequestContext } from '@/platform/authz';
import { tenantRunner, type Tx } from '@/platform/db';
import { DomainError, forbidden, notFound } from '@/platform/errors';
import { kpiById, KPIS, ratio, type KpiDef, type RatioValue } from './definitions';
import { resolvePeriod, type Period } from './periods';
import {
  BUILDERS,
  byUserSql,
  listSql,
  stageCountsSql,
  tileSql,
  type Frame,
  type ReportScope,
} from './queries';

export * from './definitions';
export * from './periods';
export type { ReportScope } from './queries';

/** Operational tiles (not KPIs): FR-130 today's / overdue work, FR-131 queue and visits. */
export const OPERATIONAL: Record<string, { name: string; description: string }> = {
  'tasks-today': {
    name: "Today's open tasks",
    description: 'Open tasks of any type due today (organisation time zone). Ignores the period.',
  },
  'tasks-overdue': {
    name: 'Open tasks past due',
    description:
      'Open tasks whose due time has passed. An operational list, not KPI K19 (no grace period or leave). Ignores the period.',
  },
  'follow-ups-overdue': {
    name: 'Overdue follow-ups',
    description:
      'Open follow-ups whose due time has passed. An operational list, not KPI K19 (no grace period or leave). Ignores the period.',
  },
  'open-by-stage': {
    name: 'Open leads by stage',
    description: 'Leads not Won or Lost, by their current stage. Ignores the period.',
  },
  'visits-upcoming': {
    name: 'Upcoming site visits',
    description: 'Open site visits in the next 7 days on leads in scope. Ignores the period.',
  },
};

export interface ReportFilters {
  period: Period;
  teamId: string | null;
  userId: string | null;
  sourceId: string | null;
}

export interface FilterOptions {
  teams: { id: string; name: string }[];
  users: { id: string; name: string }[];
  sources: { id: string; name: string }[];
}

export interface TileValue {
  id: string;
  def: KpiDef | null;
  name: string;
  description: string;
  unavailable: string | null;
  count: number | null;
  ratio: RatioValue | null;
  /** K03: median age in the queue, in hours. */
  medianAgeHours?: number | null;
}

export interface MemberRow {
  userId: string;
  name: string;
  counts: Record<string, number>;
  ratios: Record<string, RatioValue>;
}

export interface Dashboard {
  scope: ReportScope;
  filters: ReportFilters;
  error: string | null;
  options: FilterOptions;
  timeZone: string;
  kpis: TileValue[];
  operational: TileValue[];
  stages: { stage: string; label: string; count: number }[];
  members: MemberRow[] | null;
}

const RAW = z.object({
  period: z.string().max(20).optional(),
  from: z.string().max(10).optional(),
  to: z.string().max(10).optional(),
  team: z.string().max(40).optional(),
  user: z.string().max(40).optional(),
  source: z.string().max(40).optional(),
});
export type RawFilters = z.input<typeof RAW>;

/**
 * A problem with one filter value. `fieldErrors` names the filter, so pages can tell it from an
 * unknown report (NOT_FOUND without fieldErrors).
 */
const filterError = (code: 'VALIDATION_FAILED' | 'NOT_FOUND', field: string, message: string) =>
  new DomainError(code, message, { [field]: [message] });

const uuid = (v: string | undefined, field: string, what: string) => {
  if (!v) return null;
  const r = z.uuid().safeParse(v);
  if (!r.success) throw filterError('VALIDATION_FAILED', field, `Choose a valid ${what}`);
  return r.data;
};

async function orgTimeZone(tx: Tx) {
  return (await tx.organization.findFirstOrThrow({ select: { timeZone: true } })).timeZone;
}

/** Validates the filters against the viewer's scope (server-side; the UI is not trusted). */
async function loadFrame(
  tx: Tx,
  ctx: RequestContext,
  scope: ReportScope,
  raw: RawFilters,
  now: Date,
): Promise<{
  frame: Frame;
  filters: ReportFilters;
  error: string | null;
  timeZone: string;
  options: FilterOptions;
}> {
  if (ctx.kind !== 'member') throw forbidden();
  const parsed = RAW.safeParse(raw);
  if (!parsed.success)
    throw filterError(
      'VALIDATION_FAILED',
      String(parsed.error.issues[0]?.path[0] ?? 'filters'),
      'Choose valid report filters',
    );
  const input = parsed.data;
  const timeZone = await orgTimeZone(tx);
  const today = dayKeyIn(now, timeZone);
  const resolved = resolvePeriod(input.period, today, { from: input.from, to: input.to });
  const error = 'error' in resolved ? resolved.error : null;
  const period: Period =
    'error' in resolved ? (resolvePeriod('this_month', today) as Period) : resolved;

  const led = scope === 'TEAM' ? await ledTeamIds(tx, ctx.membershipId) : [];
  const memberIds = led.length
    ? [
        ...new Set(
          (
            await tx.teamMembership.findMany({
              where: { teamId: { in: led }, endedAt: null },
              select: { membership: { select: { userId: true } } },
            })
          ).map((m) => m.membership.userId),
        ),
      ]
    : [];

  const teams = await tx.team.findMany({
    where: scope === 'ORG' ? {} : { id: { in: led } },
    select: { id: true, name: true, archivedAt: true },
    orderBy: { name: 'asc' },
  });
  const peopleIds = scope === 'ORG' ? null : [...new Set([ctx.userId, ...memberIds])];
  const people = await tx.member.findMany({
    where: peopleIds ? { userId: { in: peopleIds } } : {},
    select: { userId: true, status: true, user: { select: { name: true } } },
  });
  const sources = await tx.leadSource.findMany({
    select: { id: true, name: true },
    orderBy: { name: 'asc' },
  });

  const teamId = uuid(input.team, 'team', 'team');
  const userId = uuid(input.user, 'user', 'person');
  const sourceId = uuid(input.source, 'source', 'lead source');
  // A filter outside the viewer's scope is refused, never silently widened. An unknown team or
  // person is refused the same way, so the answer never shows whether it exists elsewhere.
  if (teamId && !teams.some((t) => t.id === teamId)) throw forbidden();
  if (userId && !people.some((p) => p.userId === userId)) throw forbidden();
  // Every source of the org is visible to every viewer, so an unknown one is simply missing.
  if (sourceId && !sources.some((s) => s.id === sourceId))
    throw filterError('NOT_FOUND', 'source', 'Lead source not found');

  const at = (key: string) => parseOrgLocal(key, timeZone)!;
  const frame: Frame = {
    orgId: ctx.orgId,
    scope,
    me: ctx.userId,
    ledTeamIds: led,
    teamMemberIds: memberIds,
    from: at(period.first),
    to: at(period.end),
    now,
    todayFrom: at(today),
    todayTo: at(addDays(today, 1)),
    teamId,
    userId,
    sourceId,
  };
  return {
    frame,
    filters: { period, teamId, userId, sourceId },
    error,
    timeZone,
    options: {
      teams: teams.map((t) => ({ id: t.id, name: t.archivedAt ? `${t.name} (archived)` : t.name })),
      users: people
        .filter((p) => p.status === 'ACTIVE' || p.userId === userId)
        .map((p) => ({ id: p.userId, name: p.user.name }))
        .sort((a, b) => a.name.localeCompare(b.name)),
      sources,
    },
  };
}

interface TileRow {
  total: number;
  hits: number;
  in_progress: number;
  invalid: number;
  median_age_s: number | null;
}

async function tile(tx: Tx, id: string, f: Frame, stage?: string): Promise<TileRow> {
  const { text, values } = tileSql(id, f, stage);
  const [row] = await tx.$queryRawUnsafe<TileRow[]>(text, ...values);
  return row!;
}

function tileValue(id: string, row: TileRow | null): TileValue {
  const def = kpiById(id);
  const op = OPERATIONAL[id];
  const base = {
    id,
    def,
    name: def?.name ?? op?.name ?? id,
    description: def?.description ?? op?.description ?? '',
    unavailable: def?.unavailable ?? null,
  };
  if (!row) return { ...base, count: null, ratio: null };
  if (def?.kind === 'ratio')
    return {
      ...base,
      count: null,
      ratio: ratio(row.hits, row.total, {
        ...(def.lens === 'Cohort' ? { inProgress: row.in_progress, invalid: row.invalid } : {}),
      }),
    };
  return {
    ...base,
    count: row.total,
    ratio: null,
    ...(id === 'k03'
      ? { medianAgeHours: row.median_age_s === null ? null : row.median_age_s / 3600 }
      : {}),
  };
}

/** KPI tiles shown per scope (FR-130 personal, FR-131 team, FR-132 all of K01–K13, K18–K20). */
function kpiIds(scope: ReportScope): string[] {
  // K03 counts leads without an owner: an executive's scope holds only their own leads.
  return KPIS.map((k) => k.id).filter((id) => !(scope === 'OWN' && id === 'k03'));
}
const OPERATIONAL_IDS: Record<ReportScope, string[]> = {
  OWN: ['tasks-today', 'tasks-overdue'],
  TEAM: ['follow-ups-overdue', 'k03', 'visits-upcoming'],
  ORG: ['follow-ups-overdue', 'k03', 'visits-upcoming'],
};
/** Per-member table columns (count tiles, then ratios). */
export const MEMBER_COUNTS = ['k02', 'k05', 'k07', 'k11', 'k12', 'k18'] as const;
export const MEMBER_RATIOS = ['k19b', 'k20', 'k13'] as const;

export async function reportScope(ctx: RequestContext): Promise<ReportScope> {
  return authorize(ctx, 'report.read');
}

/** FR-130 / FR-131 / FR-132: the dashboard for the viewer's scope and the filters. */
export async function dashboard(ctx: RequestContext, raw: RawFilters): Promise<Dashboard> {
  const scope = authorize(ctx, 'report.read');
  return tenantRunner().withTenant(ctx.tenant, async (tx) => {
    const { frame, filters, error, timeZone, options } = await loadFrame(
      tx,
      ctx,
      scope,
      raw,
      new Date(),
    );
    const kpis: TileValue[] = [];
    for (const id of kpiIds(scope)) {
      const def = kpiById(id)!;
      kpis.push(tileValue(id, def.unavailable ? null : await tile(tx, id, frame)));
    }
    const operational: TileValue[] = [];
    for (const id of OPERATIONAL_IDS[scope])
      operational.push(tileValue(id, await tile(tx, id, frame)));
    const { text, values } = stageCountsSql(frame);
    const counts = await tx.$queryRawUnsafe<{ stage: string; total: number }[]>(text, ...values);
    const stages = Object.entries(STAGE_LABELS)
      .filter(([s]) => s !== 'WON' && s !== 'LOST')
      .map(([stage, label]) => ({
        stage,
        label,
        count: counts.find((c) => c.stage === stage)?.total ?? 0,
      }));
    const members = scope === 'OWN' ? null : await memberTable(tx, frame, options.users);
    return { scope, filters, error, options, timeZone, kpis, operational, stages, members };
  });
}

async function memberTable(
  tx: Tx,
  frame: Frame,
  users: { id: string; name: string }[],
): Promise<MemberRow[]> {
  const f = { ...frame, perUser: true };
  const rows = new Map<string, MemberRow>();
  const row = (id: string) => {
    let r = rows.get(id);
    if (!r) {
      r = {
        userId: id,
        name: users.find((u) => u.id === id)?.name ?? 'Former member',
        counts: {},
        ratios: {},
      };
      rows.set(id, r);
    }
    return r;
  };
  for (const u of users) if (!f.userId || u.id === f.userId) row(u.id);
  for (const id of [...MEMBER_COUNTS, ...MEMBER_RATIOS]) {
    const { text, values } = byUserSql(id, f);
    for (const r of await tx.$queryRawUnsafe<{ user_id: string; total: number; hits: number }[]>(
      text,
      ...values,
    )) {
      const m = row(r.user_id);
      if ((MEMBER_COUNTS as readonly string[]).includes(id)) m.counts[id] = r.total;
      else m.ratios[id] = ratio(r.hits, r.total);
    }
  }
  return [...rows.values()].sort((a, b) => a.name.localeCompare(b.name));
}

export interface DrillRow {
  id: string;
  leadId: string | null;
  leadName: string | null;
  leadStage: string | null;
  userName: string | null;
  at: Date;
  num: boolean;
  bucket: 'final' | 'in_progress' | 'invalid';
  extra: string | null;
}

export interface DrillDown {
  tile: TileValue;
  scope: ReportScope;
  filters: ReportFilters;
  error: string | null;
  options: FilterOptions;
  timeZone: string;
  stage: string | null;
  perMember: boolean;
  rows: DrillRow[];
  /** Rows in the whole drill-down (all buckets): paging. */
  totalRows: number;
  page: number;
  pageSize: number;
}

export const DRILL_PAGE_SIZE = 100;

/**
 * FR-133: the records that produced a tile, from the same definition and frame. `member` = the
 * per-member table's view (counts per person); `stage` narrows "open leads by stage".
 */
export async function drillDown(
  ctx: RequestContext,
  id: string,
  raw: RawFilters & {
    stage?: string | undefined;
    page?: string | undefined;
    member?: string | undefined;
  },
): Promise<DrillDown> {
  const scope = authorize(ctx, 'report.read');
  if (!kpiById(id) && !OPERATIONAL[id]) throw notFound('Report not found');
  if (id === 'k03' && scope === 'OWN') throw notFound('Report not found');
  return tenantRunner().withTenant(ctx.tenant, async (tx) => {
    const loaded = await loadFrame(tx, ctx, scope, raw, new Date());
    const perMember = raw.member === '1' && scope !== 'OWN';
    const frame = perMember ? { ...loaded.frame, perUser: true } : loaded.frame;
    const stage =
      id === 'open-by-stage' && raw.stage && raw.stage in STAGE_LABELS ? raw.stage : null;
    const def = kpiById(id);
    const page = Math.max(1, Math.min(10_000, Number.parseInt(raw.page ?? '1', 10) || 1));
    if (def?.unavailable)
      return {
        ...loaded,
        tile: tileValue(id, null),
        scope,
        stage,
        perMember,
        rows: [],
        totalRows: 0,
        page: 1,
        pageSize: DRILL_PAGE_SIZE,
      };
    if (!BUILDERS[id]) throw notFound('Report not found');
    const t = await tile(tx, id, frame, stage ?? undefined);
    const { text, values } = listSql(
      id,
      frame,
      { limit: DRILL_PAGE_SIZE, offset: (page - 1) * DRILL_PAGE_SIZE },
      stage ?? undefined,
    );
    const rows = await tx.$queryRawUnsafe<
      {
        rec_id: string;
        lead_id: string | null;
        user_id: string | null;
        at: Date;
        num: boolean;
        bucket: DrillRow['bucket'];
        extra: string | null;
        lead_name: string | null;
        lead_stage: string | null;
      }[]
    >(text, ...values);
    const names = new Map(loaded.options.users.map((u) => [u.id, u.name]));
    const missing = [
      ...new Set(rows.map((r) => r.user_id).filter((u): u is string => !!u && !names.has(u))),
    ];
    if (missing.length)
      for (const m of await tx.member.findMany({
        where: { userId: { in: missing } },
        select: { userId: true, user: { select: { name: true } } },
      }))
        names.set(m.userId, m.user.name);
    return {
      ...loaded,
      tile: tileValue(id, t),
      scope,
      stage,
      perMember,
      rows: rows.map((r) => ({
        id: r.rec_id,
        leadId: r.lead_id,
        leadName: r.lead_name,
        leadStage: r.lead_stage,
        userName: r.user_id ? (names.get(r.user_id) ?? 'Former member') : null,
        at: r.at,
        num: r.num,
        bucket: r.bucket,
        extra: r.extra,
      })),
      totalRows: t.total + t.in_progress + t.invalid,
      page,
      pageSize: DRILL_PAGE_SIZE,
    };
  });
}

/** Test seam: the tile and the drill-down row count of one definition, in one frame. */
export async function countPair(
  ctx: RequestContext,
  id: string,
  raw: RawFilters & { member?: string | undefined; stage?: string | undefined },
): Promise<{ tile: number; tileHits: number; listed: number; listedHits: number }> {
  const scope = authorize(ctx, 'report.read');
  return tenantRunner().withTenant(ctx.tenant, async (tx) => {
    const now = new Date();
    const { frame: base } = await loadFrame(tx, ctx, scope, raw, now);
    const frame = raw.member === '1' ? { ...base, perUser: true } : base;
    const t = await tile(tx, id, frame, raw.stage);
    const { text, values } = listSql(id, frame, { limit: 1_000_000, offset: 0 }, raw.stage);
    const rows = await tx.$queryRawUnsafe<{ num: boolean; bucket: string }[]>(text, ...values);
    const final = rows.filter((r) => r.bucket === 'final');
    return {
      tile: t.total,
      tileHits: t.hits,
      listed: final.length,
      listedHits: final.filter((r) => r.num).length,
    };
  });
}
