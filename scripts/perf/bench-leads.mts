// M6 PRELIMINARY local benchmark of the lead list, search, filters, sorting, pagination, lead
// detail and timeline on the ISOLATED crm_perf database (250k-lead synthetic org). It calls the
// real application code path (searchLeads/getLead/getTimeline → tenantRunner → crm_app with RLS
// and the scope filter), so latency includes Prisma, the pool and the tenant transaction. It is
// NOT the staging acceptance (k6 over HTTPS against staging, NFR-001/002); see
// docs/PHASE-2-M6-LOAD-TEST-PLAN.md.
//
//   pnpm exec tsx scripts/perf/bench-leads.mts <accounts.json> <results.json> [--only <regex>] [--no-load]
//
// --only runs the scenarios whose name matches (plus pagination when it matches "pagination");
// --no-load skips the concurrency and open-loop phases. Same memory guard as import-run.mts
// (PERF_MIN_FREE_MB, PERF_MAX_RSS_MB): it stops the run with exit code 3, never restarts it.
//
// Per scenario: 5 warm-up calls, then 30 timed sequential calls → p50/p95/p99/max. Concurrency:
// closed-loop virtual users (no think time) for a fixed duration. Tenant isolation is checked on
// every returned row. EXPLAIN (ANALYZE, BUFFERS) is captured for every scenario as crm_app inside a
// tenant transaction (RLS applies), using the same where-builders as searchLeads.
import { spawnSync } from 'node:child_process';
import { readFileSync, writeFileSync } from 'node:fs';
import { freemem } from 'node:os';
import type { Prisma } from '../../src/generated/prisma/client';

interface PlanNode {
  'Node Type': string;
  'Index Name'?: string;
  'Relation Name'?: string;
  'Shared Hit Blocks'?: number;
  'Shared Read Blocks'?: number;
  Plans?: PlanNode[];
}
import { createRequire } from 'node:module';
const req = createRequire('C:/Users/aDMIN/Desktop/CRM/package.json');
req('dotenv').config({ path: 'C:/Users/aDMIN/Desktop/CRM/.env', quiet: true });
const pg = req('pg') as typeof import('pg');

const perf = (v: string) => {
  const u = new URL(process.env[v]!);
  if (u.hostname !== '127.0.0.1' || u.port !== '55432' || u.pathname !== '/crm_test')
    throw new Error(`${v} is not the local crm_test URL`);
  u.pathname = '/crm_perf';
  return u.toString();
};
const urls = Object.entries({
  DATABASE_URL: 'TEST_DATABASE_URL',
  AUTH_DATABASE_URL: 'TEST_AUTH_DATABASE_URL',
  PLATFORM_DATABASE_URL: 'TEST_PLATFORM_DATABASE_URL',
  TEST_MIGRATOR_URL: 'TEST_MIGRATOR_URL',
}).map(([k, v]) => [k, perf(v)] as const);
for (const [k, v] of urls) process.env[k] = v;
process.env.CLEANUP_DATABASE_URL = '';
process.env.REDIS_URL = `${(process.env.REDIS_URL ?? 'redis://127.0.0.1:56379').replace(/\/\d+$/, '')}/3`;
process.env.BETTER_AUTH_URL = 'http://localhost:3400';
process.env.LOG_LEVEL = 'silent';

const acc = JSON.parse(readFileSync(process.argv[2]!, 'utf8'));
const OUT = process.argv[3]!;
const argOnly = process.argv.indexOf('--only');
const ONLY = argOnly > 0 ? new RegExp(process.argv[argOnly + 1]!) : null;
const LOAD = !process.argv.includes('--no-load');
const ROOT = 'file:///C:/Users/aDMIN/Desktop/CRM';
const { authenticators } = await import(`${ROOT}/tests/support/totp.ts`);
for (const u of [acc.A.owner, acc.A.manager, acc.B.owner])
  if (u.secret) authenticators.set(u.email.toLowerCase(), u.secret);
const f = await import(`${ROOT}/tests/support/factory.ts`);
const leads = await import(`${ROOT}/src/modules/leads/index.ts`);
const { filterWhere } = await import(`${ROOT}/src/modules/leads/list-where.ts`);
const { scopeFilter } = await import(`${ROOT}/src/modules/leads/access.ts`);
const { parseLeadQuery } = await import(`${ROOT}/src/modules/leads/list-query.ts`);
const { createTenantRunner } = await import(`${ROOT}/src/platform/db/with-tenant.ts`);
const { PrismaClient } = await import(`${ROOT}/src/generated/prisma/client.ts`);
const { PrismaPg } = req('@prisma/adapter-pg');

const migrator = new pg.Client({ connectionString: process.env.TEST_MIGRATOR_URL });
await migrator.connect();
{
  const who = (await migrator.query('SELECT current_database() d, current_user u')).rows[0];
  if (who.d !== 'crm_perf' || who.u !== 'crm_migrator')
    throw new Error('refusing: not crm_perf as crm_migrator');
}

const owner = await f.actorIn(acc.A.owner, acc.A.orgId);
const manager = await f.actorIn(acc.A.manager, acc.A.orgId);
const exec = await f.actorIn({ ...acc.A.exec, name: acc.A.exec.name }, acc.A.orgId);
const ownerB = await f.actorIn(acc.B.owner, acc.B.orgId);

const pct = (xs: number[], p: number) => {
  const s = [...xs].sort((a, b) => a - b);
  return s[Math.min(s.length - 1, Math.ceil((p / 100) * s.length) - 1)]!;
};
const r1 = (x: number) => Math.round(x * 10) / 10;
const stats = (xs: number[]) => ({
  n: xs.length,
  p50: r1(pct(xs, 50)),
  p95: r1(pct(xs, 95)),
  p99: r1(pct(xs, 99)),
  max: r1(Math.max(...xs)),
});

async function timed<T>(fn: () => Promise<T>): Promise<[number, T]> {
  const t = performance.now();
  const v = await fn();
  return [performance.now() - t, v];
}

// ---- Scenarios ---------------------------------------------------------------------------------
const d = (daysAgo: number) =>
  new Date(Date.parse(acc.now) - daysAgo * 86_400_000).toISOString().slice(0, 10);
const execId = acc.A.execs[3];
// Real values from the dataset (not guessed), so 'exact' searches find their row.
const sampleLead = (
  await migrator.query(
    `SELECT full_name, email FROM lead WHERE org_id = $1 AND email IS NOT NULL ORDER BY id OFFSET 123456 LIMIT 1`,
    [acc.A.orgId],
  )
).rows[0];
// A lead with an alternate phone (seed: about 10%), for the alternate-number search.
const altLead = (
  await migrator.query(
    `SELECT alternate_phone_e164 alt FROM lead WHERE org_id = $1 AND alternate_phone_e164 IS NOT NULL ORDER BY id OFFSET 4321 LIMIT 1`,
    [acc.A.orgId],
  )
).rows[0];
type Scenario = {
  name: string;
  kind: 'list' | 'search';
  params: Record<string, string | string[]>;
  /** Added in the P-C re-measure; kept out of the load mix so that stays comparable. */
  extra?: true;
};
const SCENARIOS: Scenario[] = [
  { name: 'list: default (active, newest)', kind: 'list', params: {} },
  { name: 'list: oldest first', kind: 'list', params: { sort: 'oldest' } },
  { name: 'list: name A–Z', kind: 'list', params: { sort: 'name' } },
  { name: 'list: all incl. archived', kind: 'list', params: { archived: 'all' } },
  { name: 'list: archived only (3%)', kind: 'list', params: { archived: 'archived' } },
  { name: 'filter: stage CONTACTED (20%)', kind: 'list', params: { stage: 'CONTACTED' } },
  { name: 'filter: stage NEGOTIATION (4%)', kind: 'list', params: { stage: 'NEGOTIATION' } },
  {
    name: 'filter: 3 stages',
    kind: 'list',
    params: { stage: ['QUALIFIED', 'SITE_VISIT_SCHEDULED', 'NEGOTIATION'] },
  },
  { name: 'filter: owner (1 of 40)', kind: 'list', params: { owner: execId } },
  { name: 'filter: unassigned', kind: 'list', params: { owner: 'none' } },
  { name: 'filter: team', kind: 'list', params: { team: acc.A.teams[1] } },
  { name: 'filter: city Pune', kind: 'list', params: { city: 'Pune' } },
  {
    name: 'filter: created last 30 days',
    kind: 'list',
    params: { createdFrom: d(30), createdTo: d(0) },
  },
  {
    name: 'filter: created 2 years ago (1 month)',
    kind: 'list',
    params: { createdFrom: d(760), createdTo: d(730) },
  },
  {
    name: 'filter: assigned last 30 days',
    kind: 'list',
    params: { assignedFrom: d(30), assignedTo: d(0) },
  },
  {
    name: 'filter: budget 50 L–1 Cr',
    kind: 'list',
    params: { budgetFrom: '50 L', budgetTo: '1 Cr' },
  },
  {
    name: 'combo typical: CONTACTED+Pune+budget',
    kind: 'list',
    params: { stage: 'CONTACTED', city: 'Pune', budgetFrom: '50 L', budgetTo: '1.5 Cr' },
  },
  {
    name: 'combo rare: NEGOTIATION+SHOP+Chennai+HOT',
    kind: 'list',
    params: { stage: 'NEGOTIATION', propertyType: 'SHOP', city: 'Chennai', intent: 'HOT' },
  },
  {
    name: 'combo high-card: owner+stage+created 90d',
    kind: 'list',
    params: { owner: execId, stage: 'CONTACTED', createdFrom: d(90), createdTo: d(0) },
  },
  { name: 'search: common surname', kind: 'search', params: { q: 'Kulkarni' } },
  { name: 'search: exact name', kind: 'search', params: { q: sampleLead.full_name } },
  { name: 'search: no match', kind: 'search', params: { q: 'zzqqxx' } },
  { name: 'search: full phone', kind: 'search', params: { q: '7000123456' } },
  { name: 'search: phone fragment 6 digits', kind: 'search', params: { q: '123456' } },
  { name: 'search: phone fragment 4 digits', kind: 'search', params: { q: '9876' } },
  { name: 'search: email', kind: 'search', params: { q: sampleLead.email } },
  {
    name: 'search + filter: surname + CONTACTED',
    kind: 'search',
    params: { q: 'Kulkarni', stage: 'CONTACTED' },
  },
  {
    name: 'search: full phone, +91 spaced',
    kind: 'search',
    params: { q: '+91 70001 23456' },
    extra: true,
  },
  {
    name: 'search: full phone, alternate number',
    kind: 'search',
    params: { q: altLead.alt.slice(3) },
    extra: true,
  },
  {
    name: 'search: full phone, no match',
    kind: 'search',
    params: { q: '9999999999' },
    extra: true,
  },
];
const RUN = ONLY ? SCENARIOS.filter((s) => ONLY.test(s.name)) : SCENARIOS;

// ---- Resource monitoring and the memory guard ---------------------------------------------------
const MIN_FREE_MB = Number(process.env.PERF_MIN_FREE_MB ?? 1000);
const MAX_RSS_MB = Number(process.env.PERF_MAX_RSS_MB ?? 3000);
const mb = (b: number) => Math.round(b / 1048576);
const pgMem = () =>
  spawnSync(
    'docker',
    ['stats', '--no-stream', '--format', '{{.MemUsage}} cpu {{.CPUPerc}}', 'cbr-crm-postgres-1'],
    { encoding: 'utf8' },
  ).stdout.trim();
const resources: Record<string, unknown> & { peakRssMb: number; minFreeMb: number } = {
  peakRssMb: 0,
  minFreeMb: mb(freemem()),
  postgresAtStart: pgMem(),
};
let partial: unknown = null;
const guard = setInterval(() => {
  const rss = mb(process.memoryUsage().rss);
  const free = mb(freemem());
  resources.peakRssMb = Math.max(resources.peakRssMb, rss);
  resources.minFreeMb = Math.min(resources.minFreeMb, free);
  if (free < MIN_FREE_MB || rss > MAX_RSS_MB) {
    clearInterval(guard);
    console.error(`MEMORY GUARD: rss ${rss} MB, free ${free} MB; stopping (not restarted)`);
    writeFileSync(
      OUT,
      JSON.stringify({ stoppedByMemoryGuard: { rssMb: rss, freeMb: free }, partial }, null, 2),
    );
    process.exit(3);
  }
}, 1000);

// ---- Tenant isolation of returned rows ----------------------------------------------------------
async function checkRows(actor: typeof owner, ids: string[]): Promise<string | null> {
  if (!ids.length) return null;
  const rows = (
    await migrator.query(
      `SELECT id, org_id, owner_user_id, team_id FROM lead WHERE id = ANY($1::uuid[])`,
      [ids],
    )
  ).rows;
  if (rows.length !== ids.length) return 'unknown ids';
  for (const r of rows) {
    if (r.org_id !== actor.ctx.orgId) return `row from another org (${r.id})`;
    if (actor === exec && r.owner_user_id !== actor.user.id)
      return `exec saw a lead it does not own (${r.id})`;
    if (actor === manager) {
      const team1 = acc.A.teams[0];
      const ok =
        r.owner_user_id === actor.user.id ||
        r.team_id === team1 ||
        (
          await migrator.query(
            `SELECT 1 FROM team_membership tm JOIN organization_membership m ON m.id = tm.membership_id WHERE tm.team_id = $1 AND tm.ended_at IS NULL AND m.user_id = $2`,
            [team1, r.owner_user_id],
          )
        ).rowCount;
      if (!ok) return `manager saw a lead outside the team (${r.id})`;
    }
  }
  return null;
}

// ---- EXPLAIN through a logging client with the same where-builders as searchLeads ---------------
const explainPool = new pg.Pool({ connectionString: process.env.DATABASE_URL, max: 2 });
let lastQuery: { query: string; params: string } | null = null;
const logClient = new PrismaClient({
  adapter: new PrismaPg(explainPool),
  log: [{ emit: 'event', level: 'query' }],
});
logClient.$on('query', (e: { query: string; params: string }) => {
  if (/FROM "public"\."lead"/.test(e.query)) lastQuery = e;
});
const runner = createTenantRunner(logClient, { maxWait: 10_000, timeout: 120_000 });
const ORDER = {
  newest: [{ id: 'desc' }],
  oldest: [{ id: 'asc' }],
  name: [{ fullName: 'asc' }, { id: 'asc' }],
} as const;
async function explain(actor: typeof owner, params: Record<string, string | string[]>) {
  const { query } = parseLeadQuery(params);
  return runner.withTenant(actor.ctx.tenant, async (tx: Prisma.TransactionClient) => {
    lastQuery = null;
    await tx.lead.findMany({
      where: {
        AND: [
          await scopeFilter(tx, actor.ctx, 'ORG'),
          { mergedIntoLeadId: null },
          ...filterWhere(query, 'Asia/Kolkata'),
        ],
      },
      orderBy: ORDER[query.sort as keyof typeof ORDER],
      take: 51,
      select: {
        id: true,
        fullName: true,
        owner: { select: { status: true } },
        team: { select: { name: true } },
      },
    });
    if (!lastQuery) return null;
    const params2 = JSON.parse(lastQuery.params);
    const plan = (await tx.$queryRawUnsafe(
      `EXPLAIN (ANALYZE, BUFFERS, FORMAT JSON) ${lastQuery.query}`,
      ...params2,
    )) as {
      'QUERY PLAN': { Plan: PlanNode; 'Execution Time': number; 'Planning Time': number }[];
    }[];
    const p = plan[0]!['QUERY PLAN'][0]!;
    const nodes: string[] = [];
    const walk = (n: PlanNode) => {
      nodes.push(
        `${n['Node Type']}${n['Index Name'] ? `(${n['Index Name']})` : n['Relation Name'] ? `(${n['Relation Name']})` : ''}`,
      );
      (n.Plans ?? []).forEach(walk);
    };
    walk(p.Plan);
    return {
      executionMs: r1(p['Execution Time']),
      planningMs: r1(p['Planning Time']),
      nodes: [...new Set(nodes)].slice(0, 8),
      sharedHitBlocks: p.Plan['Shared Hit Blocks'],
      sharedReadBlocks: p.Plan['Shared Read Blocks'],
    };
  });
}

// ---- Run ----------------------------------------------------------------------------------------
const THRESHOLD = { list: 500, search: 700, detail: 400, timeline: 300 };
const results: {
  scenarios: Record<string, unknown>[];
  pagination: Record<string, unknown>[] | null;
  detail: Record<string, unknown> | null;
  concurrency: Record<string, unknown>[];
  isolation: Record<string, unknown>[];
  [k: string]: unknown;
} = {
  generatedAt: new Date().toISOString(),
  dataset: { leadsA: acc.A.leads, leadsB: acc.B.leads },
  thresholds: THRESHOLD,
  scenarios: [],
  pagination: null,
  detail: null,
  concurrency: [],
  isolation: [],
  options: { only: ONLY?.source ?? null, load: LOAD },
  resources,
};
partial = results;
const WARMUP = 5,
  REPEATS = 30;
for (const s of RUN) {
  for (let i = 0; i < WARMUP; i++) await leads.searchLeads(owner.ctx, s.params);
  const xs: number[] = [];
  let rows = 0;
  for (let i = 0; i < REPEATS; i++) {
    const [ms, page] = await timed(() => leads.searchLeads(owner.ctx, s.params));
    xs.push(ms);
    rows = page.rows.length;
    if (Object.keys(page.errors).length)
      throw new Error(`${s.name}: ${JSON.stringify(page.errors)}`);
  }
  const st = stats(xs);
  const limit = THRESHOLD[s.kind];
  const plan = await explain(owner, s.params);
  results.scenarios.push({
    ...s,
    rowsOnPage: rows,
    ...st,
    threshold: limit,
    pass: st.p95 <= limit,
    explain: plan,
  });
  console.log(
    `${st.p95 <= limit ? 'ok  ' : 'SLOW'} ${s.name.padEnd(46)} p50 ${String(st.p50).padStart(7)}  p95 ${String(st.p95).padStart(7)}  p99 ${String(st.p99).padStart(7)} ms  rows ${rows}  db ${plan?.executionMs ?? '?'} ms`,
  );
}

// Pagination: follow the cursor 20 pages deep (newest and name order).
for (const sort of ['newest', 'name']) {
  if (ONLY && !ONLY.test(`pagination ${sort}`)) continue;
  const xs: number[] = [];
  let cursor: string | null = null;
  const seen = new Set<string>();
  for (let p = 0; p < 20; p++) {
    const [ms, page] = await timed(() =>
      leads.searchLeads(owner.ctx, { sort, ...(cursor ? { cursor } : {}) }),
    );
    xs.push(ms);
    for (const r of page.rows) {
      if (seen.has(r.id)) throw new Error('duplicate row across pages');
      seen.add(r.id);
    }
    cursor = page.nextCursor;
    if (!cursor) break;
  }
  const st = stats(xs);
  results.pagination ??= [];
  results.pagination.push({
    sort,
    pages: xs.length,
    distinctRows: seen.size,
    ...st,
    threshold: THRESHOLD.list,
    pass: st.p95 <= THRESHOLD.list,
  });
  console.log(
    `pagination ${sort}: ${xs.length} pages, ${seen.size} distinct rows, p95 ${st.p95} ms`,
  );
}

// Lead detail and timeline (NFR-002), including leads with 300+ activities.
if (!ONLY) {
  const sample = (
    await migrator.query(`SELECT id FROM lead WHERE org_id = $1 ORDER BY id LIMIT 20 OFFSET 1000`, [
      acc.A.orgId,
    ])
  ).rows.map((r: { id: string }) => r.id);
  const ids = [...sample, ...acc.A.timelineLeads];
  for (const id of ids.slice(0, 5)) {
    await leads.getLead(owner.ctx, id);
    await leads.getTimeline(owner.ctx, id);
  }
  const dx: number[] = [],
    tx: number[] = [];
  for (const id of ids) {
    dx.push((await timed(() => leads.getLead(owner.ctx, id)))[0]);
    tx.push((await timed(() => leads.getTimeline(owner.ctx, id)))[0]);
  }
  results.detail = {
    leads: ids.length,
    heavyTimelineLeads: acc.A.timelineLeads.length,
    detail: { ...stats(dx), threshold: THRESHOLD.detail, pass: pct(dx, 95) <= THRESHOLD.detail },
    timeline: {
      ...stats(tx),
      threshold: THRESHOLD.timeline,
      pass: pct(tx, 95) <= THRESHOLD.timeline,
    },
  };
  console.log(`detail p95 ${r1(pct(dx, 95))} ms; timeline p95 ${r1(pct(tx, 95))} ms`);
}

// Concurrency: closed-loop virtual users over a mixed scenario set, fixed duration.
const MIX = SCENARIOS.filter(
  (s) => !s.extra && !s.name.startsWith('list: name') && !s.name.includes('no match'),
);
async function concurrent(vus: number, seconds: number, mix: Scenario[], label: string) {
  const until = Date.now() + seconds * 1000;
  const lat: number[] = [];
  let errors = 0,
    maxConn = 0,
    maxRss = 0,
    k = 0;
  const sampler = setInterval(async () => {
    try {
      const n = Number(
        (
          await migrator.query(
            `SELECT count(*) n FROM pg_stat_activity WHERE datname = 'crm_perf' AND application_name = 'cbr-crm-app'`,
          )
        ).rows[0].n,
      );
      maxConn = Math.max(maxConn, n);
    } catch {
      /* sampling only */
    }
    maxRss = Math.max(maxRss, process.memoryUsage().rss);
  }, 250);
  await Promise.all(
    Array.from({ length: vus }, async () => {
      while (Date.now() < until) {
        const s = mix[k++ % mix.length]!;
        try {
          lat.push((await timed(() => leads.searchLeads(owner.ctx, s.params)))[0]);
        } catch {
          errors++;
        }
      }
    }),
  );
  clearInterval(sampler);
  const st = stats(lat);
  const out = {
    label,
    vus,
    seconds,
    requests: lat.length + errors,
    throughputPerSec: r1(lat.length / seconds),
    errors,
    ...st,
    appPoolMax: 10,
    maxAppConnections: maxConn,
    maxRssMb: Math.round(maxRss / 1048576),
  };
  results.concurrency.push(out);
  console.log(
    `concurrency ${label} vus=${vus}: ${out.requests} req, ${out.throughputPerSec}/s, errors ${errors}, p50 ${st.p50} p95 ${st.p95} p99 ${st.p99} ms, conns ${maxConn}, rss ${out.maxRssMb} MB`,
  );
}
if (LOAD) {
  await concurrent(1, 20, MIX, 'mixed');
  await concurrent(10, 30, MIX, 'mixed');
  await concurrent(25, 30, MIX, 'mixed');
}

// Open loop: requests arrive at a fixed rate (closer to real users with think time), so latency
// reflects the service time at that load rather than a saturated queue.
async function openLoop(rate: number, seconds: number, mix: Scenario[]) {
  const lat: number[] = [];
  const byScenario = new Map<string, number[]>();
  let errors = 0,
    k = 0;
  const inflight: Promise<void>[] = [];
  const start = Date.now();
  for (let i = 0; i < rate * seconds; i++) {
    const due = start + (i * 1000) / rate;
    const wait = due - Date.now();
    if (wait > 0) await new Promise((r) => setTimeout(r, wait));
    const s = mix[k++ % mix.length]!;
    inflight.push(
      timed(() => leads.searchLeads(owner.ctx, s.params)).then(
        ([ms]) => {
          lat.push(ms);
          (byScenario.get(s.name) ?? byScenario.set(s.name, []).get(s.name)!).push(ms);
        },
        () => {
          errors++;
        },
      ),
    );
  }
  await Promise.all(inflight);
  const st = stats(lat);
  const slowest = [...byScenario]
    .map(([n, xs]) => [n, r1(pct(xs, 95))] as const)
    .sort((a, b) => b[1] - a[1])
    .slice(0, 4);
  const out = {
    label: 'open-loop mixed',
    ratePerSec: rate,
    seconds,
    requests: lat.length + errors,
    errors,
    ...st,
    slowestScenariosP95: slowest,
  };
  results.concurrency.push(out);
  console.log(
    `open loop ${rate}/s: ${out.requests} req, errors ${errors}, p50 ${st.p50} p95 ${st.p95} p99 ${st.p99} ms; slowest ${JSON.stringify(slowest)}`,
  );
}
if (LOAD) for (const rate of [5, 10, 20, 30]) await openLoop(rate, 30, MIX);

// Tenant isolation and scope on every scenario (org B owner, A manager, A executive).
for (const [label, actor] of [
  ['org B owner', ownerB],
  ['org A manager (team)', manager],
  ['org A executive (own)', exec],
] as const) {
  let rowsChecked = 0;
  const failures: string[] = [];
  for (const s of RUN) {
    const page = await leads.searchLeads(actor.ctx, s.params);
    rowsChecked += page.rows.length;
    const problem = await checkRows(
      actor,
      page.rows.map((r: { id: string }) => r.id),
    );
    if (problem) failures.push(`${s.name}: ${problem}`);
  }
  // A lead of org A requested directly by org B must not be found.
  if (label === 'org B owner') {
    const aLead = (
      await migrator.query(`SELECT id FROM lead WHERE org_id = $1 LIMIT 1`, [acc.A.orgId])
    ).rows[0].id;
    try {
      await leads.getLead(actor.ctx, aLead);
      failures.push('org B could open an org A lead');
    } catch (e) {
      const code = (e as { code?: string } | null)?.code;
      if (code !== 'NOT_FOUND') failures.push(`unexpected: ${code}`);
    }
  }
  results.isolation.push({ actor: label, scenarios: RUN.length, rowsChecked, failures });
  console.log(`isolation ${label}: ${rowsChecked} rows checked, ${failures.length} failures`);
}

clearInterval(guard);
resources.postgresAtEnd = pgMem();
writeFileSync(OUT, JSON.stringify(results, null, 2));
await migrator.end();
await explainPool.end();
process.exit(0);
