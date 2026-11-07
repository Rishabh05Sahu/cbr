// M6 P-F: the open-lead phone match (findOpenMatch) before and after, on the ISOLATED crm_perf
// database, as crm_app inside a tenant transaction (RLS applies). "before" is the SQL Prisma sent
// for the old findFirst (stage list bound as CAST($n::text AS lead_stage)); "after" is the SQL in
// src/modules/leads/access.ts. Read-only. 5 warm-up + 50 timed executions per case; reports
// p50/p95/p99/max of the round trip and the plan's execution time and index use.
//
//   pnpm exec tsx scripts/perf/open-match-bench.mts <accounts.json> <results.json>
import { readFileSync, writeFileSync } from 'node:fs';
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
const acc = JSON.parse(readFileSync(process.argv[2]!, 'utf8'));
const app = new pg.Client({ connectionString: perf('TEST_DATABASE_URL') });
const mig = new pg.Client({ connectionString: perf('TEST_MIGRATOR_URL') });
await app.connect();
await mig.connect();
for (const [c, role] of [
  [app, 'crm_app'],
  [mig, 'crm_migrator'],
] as const) {
  const w = (await c.query('SELECT current_database() d, current_user u')).rows[0];
  if (w.d !== 'crm_perf' || w.u !== role) throw new Error(`refusing: not crm_perf as ${role}`);
}

const BEFORE = `SELECT "public"."lead"."id", "public"."lead"."archived_at" FROM "public"."lead"
  WHERE ("public"."lead"."stage" NOT IN (CAST($1::text AS "public"."lead_stage"), CAST($2::text AS "public"."lead_stage"))
    AND "public"."lead"."deleted_at" IS NULL AND "public"."lead"."merged_into_lead_id" IS NULL
    AND ("public"."lead"."primary_phone_e164" IN ($3,$4) OR "public"."lead"."alternate_phone_e164" IN ($5,$6)))
  ORDER BY "public"."lead"."created_at" ASC LIMIT $7 OFFSET $8`;
const AFTER = `SELECT id, archived_at FROM lead
  WHERE stage NOT IN ('WON', 'LOST') AND deleted_at IS NULL AND merged_into_lead_id IS NULL
    AND (primary_phone_e164 = ANY($1::text[]) OR alternate_phone_e164 = ANY($1::text[]))
  ORDER BY created_at ASC LIMIT 1`;
const params = (form: string, phones: [string, string]) =>
  form === 'before' ? ['WON', 'LOST', ...phones, ...phones, 1, 0] : [phones];

interface PlanNode {
  'Node Type': string;
  'Index Name'?: string;
  Plans?: PlanNode[];
}
const nodes = (n: PlanNode): PlanNode[] => [n, ...(n.Plans ?? []).flatMap(nodes)];
const pct = (xs: number[], p: number) =>
  [...xs].sort((a, b) => a - b)[Math.min(xs.length - 1, Math.ceil((p / 100) * xs.length) - 1)]!;
const r2 = (x: number) => Math.round(x * 100) / 100;

async function sample(orgId: string, where: string) {
  const r = await mig.query(
    `SELECT primary_phone_e164 p, alternate_phone_e164 a FROM lead WHERE org_id = $1 AND ${where} ORDER BY id LIMIT 1 OFFSET 777`,
    [orgId],
  );
  return r.rows[0] as { p: string; a: string | null };
}

const results: Record<string, unknown>[] = [];
for (const [org, orgId] of [
  ['A (250k)', acc.A.orgId],
  ['B (5k)', acc.B.orgId],
] as const) {
  const open = await sample(
    orgId,
    `stage NOT IN ('WON','LOST') AND deleted_at IS NULL AND merged_into_lead_id IS NULL`,
  );
  const withAlt = await sample(
    orgId,
    `alternate_phone_e164 IS NOT NULL AND stage NOT IN ('WON','LOST') AND deleted_at IS NULL AND merged_into_lead_id IS NULL`,
  );
  const cases: [string, [string, string]][] = [
    ['open primary', [open.p, '+919999999901']],
    ...(withAlt
      ? ([['open alternate', [withAlt.a!, '+919999999902']]] as [string, [string, string]][])
      : []),
    ['no match', ['+919999999903', '+919999999904']],
  ];
  for (const [name, phones] of cases)
    for (const form of ['before', 'after']) {
      const sql = form === 'before' ? BEFORE : AFTER;
      await app.query('BEGIN');
      await app.query("SELECT set_config('app.org_id', $1, true)", [orgId]);
      const found: (string | null)[] = [];
      const ms: number[] = [];
      for (let i = 0; i < 55; i++) {
        const t = performance.now();
        const q = await app.query(sql, params(form, phones));
        if (i >= 5) ms.push(performance.now() - t);
        found.push(q.rows[0]?.id ?? null);
      }
      const ex = await app.query(`EXPLAIN (ANALYZE, FORMAT JSON) ${sql}`, params(form, phones));
      await app.query('ROLLBACK');
      const plan = ex.rows[0]['QUERY PLAN'][0];
      const row = {
        org,
        case: name,
        form,
        match: found[0],
        p50: r2(pct(ms, 50)),
        p95: r2(pct(ms, 95)),
        p99: r2(pct(ms, 99)),
        max: r2(Math.max(...ms)),
        dbExecMs: r2(plan['Execution Time']),
        indexes: [
          ...new Set(
            nodes(plan.Plan)
              .map((n) => n['Index Name'])
              .filter(Boolean),
          ),
        ].join(','),
        seqScan: nodes(plan.Plan).some((n) => n['Node Type'].includes('Seq Scan')),
      };
      results.push(row);
      console.log(JSON.stringify(row));
    }
}
// Same answer either way, for every case.
const mismatch = results.filter((r, i) => r.form === 'after' && r.match !== results[i - 1]!.match);
console.log('before/after answers identical:', mismatch.length === 0);
writeFileSync(
  process.argv[3]!,
  JSON.stringify(
    { generatedAt: new Date().toISOString(), results, identical: mismatch.length === 0 },
    null,
    2,
  ),
);
await app.end();
await mig.end();
