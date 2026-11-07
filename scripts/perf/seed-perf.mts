// M6 load-test seed for the ISOLATED local database crm_perf (scripts/perf/perf-db.mjs). Never
// runs against anything else (identity queried). SYNTHETIC data only (tests/support/synthetic-
// data.ts); deterministic: row i always has the same values.
//
//   pnpm exec tsx scripts/perf/seed-perf.mts <accounts-out.json> [leadsA=250000] [leadsB=5000]
//
// Org A ("PerfA"): owner, admin, manager (leads team 1), HR, 40 sales executives in 4 teams,
// 8 sources, LEADS_A leads with one enquiry, one CREATED activity and (when owned) one open
// assignment each; 20 leads get 300 extra activities for the timeline test.
// Org B ("PerfB"): owner + 5 executives, LEADS_B leads (tenant-isolation checks).
// Users go through the real auth stack (tests/support/factory); bulk rows are inserted as the
// schema owner (crm_migrator, `maintenance` policy) in batches, exactly within the CHECKs.
import { writeFileSync } from 'node:fs';
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
  DATABASE_MIGRATOR_URL: 'TEST_MIGRATOR_URL',
}).map(([k, v]) => [k, perf(v)] as const);
for (const [k, v] of urls) process.env[k] = v;
process.env.CLEANUP_DATABASE_URL = '';
process.env.REDIS_URL = `${(process.env.REDIS_URL ?? 'redis://127.0.0.1:56379').replace(/\/\d+$/, '')}/3`;
process.env.BETTER_AUTH_URL = 'http://localhost:3400';
process.env.LOG_LEVEL = 'silent';

const db = new pg.Client({ connectionString: process.env.TEST_MIGRATOR_URL });
await db.connect();
const id = (await db.query('SELECT current_database() d, current_user u')).rows[0];
if (id.d !== 'crm_perf' || id.u !== 'crm_migrator')
  throw new Error('refusing: not crm_perf as crm_migrator');
if (Number((await db.query('SELECT count(*) n FROM lead')).rows[0].n) > 0)
  throw new Error('crm_perf already has leads; drop and recreate it first');

const ROOT = 'file:///C:/Users/aDMIN/Desktop/CRM';
const f = await import(`${ROOT}/tests/support/factory.ts`);
const { authenticators } = await import(`${ROOT}/tests/support/totp.ts`);
const S = await import(`${ROOT}/tests/support/synthetic-data.ts`);

const LEADS_A = Number(process.argv[3] ?? 250_000);
const LEADS_B = Number(process.argv[4] ?? 5_000);
const SEED = 20261026;
const NOW = Date.UTC(2026, 9, 26, 6, 0, 0); // fixed "now" so dates are reproducible
const DAY = 86_400_000;
const t0 = Date.now();

const STAGES = [
  ['NEW', 12],
  ['ASSIGNED', 18],
  ['CONTACTED', 20],
  ['QUALIFIED', 10],
  ['SITE_VISIT_SCHEDULED', 5],
  ['SITE_VISIT_COMPLETED', 5],
  ['NEGOTIATION', 4],
  ['WON', 6],
  ['LOST', 15],
  ['NURTURE', 5],
] as const;
const PTYPES = [
  'APARTMENT',
  'APARTMENT',
  'APARTMENT',
  'VILLA',
  'PLOT',
  'ROW_HOUSE',
  'OFFICE',
  'SHOP',
];
const TXN = ['BUY', 'BUY', 'BUY', 'RENT', 'LEASE_COMMERCIAL'];

async function org(name: string, execs: number) {
  const o = await f.seedOrg(name);
  const extra = [];
  for (let i = 3; i <= execs; i++) {
    const u = await f.createUser(`${name}-exec${i}`);
    await f.addMember(o.orgId, u, 'sales_executive');
    extra.push(u);
  }
  const execUsers = [o.users.exec1, o.users.exec2, ...extra];
  const sources: string[] = [];
  for (const [n, ch] of [
    ['Website', 'WEBSITE'],
    ['99acres', 'PORTAL'],
    ['MagicBricks', 'PORTAL'],
    ['Housing.com', 'PORTAL'],
    ['Facebook Ads', 'SOCIAL_ADS'],
    ['Google Ads', 'SOCIAL_ADS'],
    ['Referral', 'REFERRAL'],
    ['Walk-in', 'WALK_IN'],
  ] as const)
    sources.push(
      (
        await db.query(
          `INSERT INTO lead_source (org_id, name, channel) VALUES ($1, $2, $3) ON CONFLICT DO NOTHING RETURNING id`,
          [o.orgId, n, ch],
        )
      ).rows[0]?.id,
    );
  const teams: string[] = [];
  for (let t = 1; t <= 4; t++)
    teams.push(
      (
        await db.query(`INSERT INTO team (org_id, name) VALUES ($1, $2) RETURNING id`, [
          o.orgId,
          `Synthetic Team ${t}`,
        ])
      ).rows[0].id,
    );
  const memberId = async (userId: string) =>
    (
      await db.query(`SELECT id FROM organization_membership WHERE org_id = $1 AND user_id = $2`, [
        o.orgId,
        userId,
      ])
    ).rows[0].id;
  await db.query(
    `INSERT INTO team_membership (org_id, team_id, membership_id, team_role) VALUES ($1, $2, $3, 'LEAD')`,
    [o.orgId, teams[0], await memberId(o.users.manager.id)],
  );
  const teamOf = new Map<string, string>();
  for (const [k, u] of execUsers.entries()) {
    const team = teams[k % 4]!;
    teamOf.set(u.id, team);
    await db.query(
      `INSERT INTO team_membership (org_id, team_id, membership_id) VALUES ($1, $2, $3)`,
      [o.orgId, team, await memberId(u.id)],
    );
  }
  return { o, execUsers, sources: sources.filter(Boolean), teams, teamOf };
}

async function seedLeads(
  g: Awaited<ReturnType<typeof org>>,
  count: number,
  block: 7 | 8,
  heavyTimeline: number,
) {
  const BATCH = 2000;
  const columns = [
    'org_id',
    'full_name',
    'primary_phone_e164',
    'primary_phone_raw',
    'phone_last10',
    'alternate_phone_e164',
    'email',
    'transaction_type',
    'property_type',
    'bhk_min',
    'bhk_max',
    'budget_min',
    'budget_max',
    'preferred_city',
    'preferred_localities',
    'intent',
    'source_id',
    'owner_user_id',
    'team_id',
    'stage',
    'created_at',
    'updated_at',
    'archived_at',
    'won_at',
    'lost_at',
  ];
  const types = [
    'uuid',
    'text',
    'text',
    'text',
    'text',
    'text',
    'citext',
    'text',
    'text',
    'int2',
    'int2',
    'numeric',
    'numeric',
    'text',
    'text',
    'text',
    'uuid',
    'uuid',
    'uuid',
    'lead_stage',
    'timestamptz',
    'timestamptz',
    'timestamptz',
    'timestamptz',
    'timestamptz',
  ];
  let firstIds: string[] = [];
  for (let start = 0; start < count; start += BATCH) {
    const cols: unknown[][] = columns.map(() => []);
    const n = Math.min(BATCH, count - start);
    for (let k = 0; k < n; k++) {
      const i = start + k;
      const r = S.rowRandom(SEED + block, i);
      const digits = S.syntheticMobile(block, i);
      const stage = S.weighted(r, STAGES) as string;
      const owner = stage === 'NEW' && r() < 0.6 ? null : S.pick(r, g.execUsers).id;
      // Skewed towards recent: 3-year horizon, half within the last 6 months.
      const ageDays = r() < 0.5 ? r() * 180 : 180 + r() * 915;
      const created = new Date(NOW - ageDays * DAY);
      const city = r() < 0.85 ? S.pick(r, S.CITY_NAMES) : null;
      const budget = r() < 0.7 ? S.syntheticBudget(r) : null;
      const bhk = r() < 0.6 ? 1 + Math.floor(r() * 4) : null;
      const closedAt = new Date(created.getTime() + r() * 60 * DAY);
      const row = [
        g.o.orgId,
        S.syntheticName(r, i),
        `+91${digits}`,
        digits,
        digits,
        r() < 0.1 ? `+91${S.syntheticMobile(block, i, 1)}` : null,
        r() < 0.5 ? S.syntheticEmail(i, `${block}x`) : null,
        r() < 0.75 ? S.pick(r, TXN) : null,
        r() < 0.8 ? S.pick(r, PTYPES) : null,
        bhk,
        bhk === null ? null : bhk + (r() < 0.3 ? 1 : 0),
        budget?.min ?? null,
        budget?.max ?? null,
        city,
        city ? S.pick(r, S.CITIES[city]!) : null,
        r() < 0.6 ? S.pick(r, ['HOT', 'WARM', 'COLD']) : null,
        S.pick(r, g.sources),
        owner,
        owner ? g.teamOf.get(owner)! : null,
        stage,
        created,
        created,
        r() < 0.03 ? new Date(created.getTime() + 30 * DAY) : null,
        stage === 'WON' ? closedAt : null,
        stage === 'LOST' ? closedAt : null,
      ];
      row.forEach((v, c) => cols[c]!.push(v));
    }
    const unnest = columns.map((_, c) => `$${c + 1}::${types[c]}[]`).join(', ');
    // preferred_localities is text[]: one locality per row is passed as text and wrapped here.
    const select = columns
      .map((name, c) =>
        name === 'preferred_localities'
          ? `CASE WHEN t.c${c} IS NULL THEN '{}'::text[] ELSE ARRAY[t.c${c}] END`
          : `t.c${c}`,
      )
      .join(', ');
    const alias = columns.map((_, c) => `c${c}`).join(', ');
    const ids = (
      await db.query(
        `INSERT INTO lead (${columns.join(', ')})
         SELECT ${select} FROM unnest(${unnest}) AS t(${alias}) RETURNING id, owner_user_id, team_id, created_at, source_id`,
        cols,
      )
    ).rows as {
      id: string;
      owner_user_id: string | null;
      team_id: string | null;
      created_at: Date;
      source_id: string;
    }[];
    if (start === 0) firstIds = ids.slice(0, heavyTimeline).map((x) => x.id);
    await db.query(
      `INSERT INTO lead_enquiry (org_id, lead_id, source_id, received_at, created_at)
       SELECT $1, l, s, c, c FROM unnest($2::uuid[], $3::uuid[], $4::timestamptz[]) AS t(l, s, c)`,
      [g.o.orgId, ids.map((x) => x.id), ids.map((x) => x.source_id), ids.map((x) => x.created_at)],
    );
    await db.query(
      `INSERT INTO lead_activity (org_id, lead_id, type, summary, occurred_at)
       SELECT $1, l, 'CREATED', '{}'::jsonb, c FROM unnest($2::uuid[], $3::timestamptz[]) AS t(l, c)`,
      [g.o.orgId, ids.map((x) => x.id), ids.map((x) => x.created_at)],
    );
    const owned = ids.filter((x) => x.owner_user_id);
    await db.query(
      `INSERT INTO lead_assignment_history (org_id, lead_id, user_id, team_id, started_at, source)
       SELECT $1, l, u, t, c + interval '1 hour', 'BULK'
         FROM unnest($2::uuid[], $3::uuid[], $4::uuid[], $5::timestamptz[]) AS x(l, u, t, c)`,
      [
        g.o.orgId,
        owned.map((x) => x.id),
        owned.map((x) => x.owner_user_id),
        owned.map((x) => x.team_id),
        owned.map((x) => x.created_at),
      ],
    );
    if ((start / BATCH) % 25 === 0)
      console.log(
        `  ${g.o.name}: ${start + n}/${count} leads (${((Date.now() - t0) / 1000).toFixed(0)} s)`,
      );
  }
  for (const leadId of firstIds)
    await db.query(
      `INSERT INTO lead_activity (org_id, lead_id, type, summary, occurred_at)
       SELECT $1, $2, 'NOTE', jsonb_build_object('n', g), $3::timestamptz + g * interval '1 hour'
         FROM generate_series(1, 300) g`,
      [g.o.orgId, leadId, new Date(NOW - 400 * DAY)],
    );
  return firstIds;
}

console.log('seeding crm_perf (synthetic)…');
const A = await org('PerfA', 40);
const timelineLeads = await seedLeads(A, LEADS_A, 7, 20);
const B = await org('PerfB', 5);
await seedLeads(B, LEADS_B, 8, 0);
await db.query('ANALYZE');
const who = (u: { id: string; email: string; name: string }) => ({
  id: u.id,
  email: u.email,
  name: u.name,
  secret: authenticators.get(u.email.toLowerCase()) ?? null,
});
writeFileSync(
  process.argv[2]!,
  JSON.stringify(
    {
      password: f.PASSWORD,
      seed: SEED,
      now: new Date(NOW).toISOString(),
      A: {
        orgId: A.o.orgId,
        leads: LEADS_A,
        teams: A.teams,
        sources: A.sources,
        owner: who(A.o.users.owner),
        manager: who(A.o.users.manager),
        exec: who(A.execUsers[0]!),
        execs: A.execUsers.map((u: { id: string }) => u.id),
        timelineLeads,
      },
      B: { orgId: B.o.orgId, leads: LEADS_B, owner: who(B.o.users.owner) },
    },
    null,
    2,
  ),
);
const counts = (
  await db.query(
    `SELECT (SELECT count(*) FROM lead) leads, (SELECT count(*) FROM lead_enquiry) enquiries, (SELECT count(*) FROM lead_activity) activities, (SELECT count(*) FROM lead_assignment_history) assignments, pg_size_pretty(pg_database_size('crm_perf')) size`,
  )
).rows[0];
console.log(`done in ${((Date.now() - t0) / 1000).toFixed(0)} s:`, counts);
await db.end();
process.exit(0);
