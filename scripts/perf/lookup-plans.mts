// M6: query plans and timings of the per-lead lookups on the create path (manual create and
// import share insertNewLead) on the ISOLATED crm_perf database. Runs the REAL insertNewLead as
// crm_app inside a tenant transaction (RLS and the session context apply), captures the SQL that
// Prisma sends, runs EXPLAIN (ANALYZE, BUFFERS) on each lead lookup in that same transaction, and
// then ROLLS BACK: nothing is kept.
//
//   pnpm exec tsx scripts/perf/lookup-plans.mts <accounts.json> <results.json> [label]
//
// Each sample uses the phone of a seeded won/lost lead (so the returning-customer lookup finds
// it) and the e-mail of a seeded lead (so the duplicate check finds it), in org A (250k) and
// org B (5k).
import { readFileSync, writeFileSync } from 'node:fs';
import { createRequire } from 'node:module';
import type { Prisma } from '../../src/generated/prisma/client';
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
for (const [k, v] of Object.entries({
  DATABASE_URL: 'TEST_DATABASE_URL',
  AUTH_DATABASE_URL: 'TEST_AUTH_DATABASE_URL',
  PLATFORM_DATABASE_URL: 'TEST_PLATFORM_DATABASE_URL',
  TEST_MIGRATOR_URL: 'TEST_MIGRATOR_URL',
}))
  process.env[k] = perf(v);
process.env.CLEANUP_DATABASE_URL = '';
process.env.REDIS_URL = `${(process.env.REDIS_URL ?? 'redis://127.0.0.1:56379').replace(/\/\d+$/, '')}/3`;
process.env.BETTER_AUTH_URL = 'http://localhost:3400';
process.env.LOG_LEVEL = 'silent';

const acc = JSON.parse(readFileSync(process.argv[2]!, 'utf8'));
const ROOT = 'file:///C:/Users/aDMIN/Desktop/CRM';
const { authenticators } = await import(`${ROOT}/tests/support/totp.ts`);
for (const u of [acc.A.owner, acc.B.owner])
  if (u.secret) authenticators.set(u.email.toLowerCase(), u.secret);
const f = await import(`${ROOT}/tests/support/factory.ts`);
const { insertNewLead } = await import(`${ROOT}/src/modules/leads/write.ts`);
const { prepareLead } = await import(`${ROOT}/src/modules/leads/input.ts`);
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
const appPool = new pg.Pool({ connectionString: process.env.DATABASE_URL, max: 1 });
{
  const c = await appPool.connect();
  const who = (await c.query('SELECT current_database() d, current_user u')).rows[0];
  c.release();
  if (who.d !== 'crm_perf' || who.u !== 'crm_app')
    throw new Error('refusing: app pool is not crm_perf as crm_app');
}
const captured: { query: string; params: string }[] = [];
const client = new PrismaClient({
  adapter: new PrismaPg(appPool),
  log: [{ emit: 'event', level: 'query' }],
});
client.$on('query', (e: { query: string; params: string }) => captured.push(e));
const runner = createTenantRunner(client, { maxWait: 10_000, timeout: 120_000 });

interface PlanNode {
  'Node Type': string;
  'Index Name'?: string;
  'Relation Name'?: string;
  Plans?: PlanNode[];
}
const nodesOf = (p: PlanNode) => {
  const out: string[] = [];
  const walk = (n: PlanNode) => {
    out.push(
      `${n['Node Type']}${n['Index Name'] ? `(${n['Index Name']})` : n['Relation Name'] ? `(${n['Relation Name']})` : ''}`,
    );
    (n.Plans ?? []).forEach(walk);
  };
  walk(p);
  return [...new Set(out)];
};
const label = (q: string) =>
  /"stage" IN|stage" = ANY/.test(q) && /primary_phone_e164/.test(q)
    ? 'returning-customer lookup (P-A)'
    : /email/.test(q)
      ? 'e-mail duplicate check (P-B)'
      : null;

class Rollback extends Error {}
const SAMPLES = 20;
const out: Record<string, unknown> = {
  generatedAt: new Date().toISOString(),
  label: process.argv[4] ?? null,
  role: 'crm_app (RLS, tenant transaction)',
  orgs: {},
};
for (const [org, orgId, account] of [
  ['A (250k)', acc.A.orgId, acc.A.owner],
  ['B (5k)', acc.B.orgId, acc.B.owner],
] as const) {
  const actor = await f.actorIn(account, orgId);
  const closed = (
    await migrator.query(
      `SELECT primary_phone_e164 p FROM lead WHERE org_id = $1 AND stage IN ('WON','LOST') ORDER BY id LIMIT $2`,
      [orgId, SAMPLES],
    )
  ).rows.map((r: { p: string }) => r.p);
  const emails = (
    await migrator.query(
      `SELECT email::text e FROM lead WHERE org_id = $1 AND email IS NOT NULL ORDER BY id DESC LIMIT $2`,
      [orgId, SAMPLES],
    )
  ).rows.map((r: { e: string }) => r.e.toUpperCase()); // case-insensitive match is part of the rule
  const source = (
    await migrator.query(`SELECT id FROM lead_source WHERE org_id = $1 LIMIT 1`, [orgId])
  ).rows[0].id;
  const byLabel: Record<string, { ms: number[]; nodes: string[]; found: number[]; sql: string }> =
    {};
  for (let k = 0; k < SAMPLES; k++) {
    const p = prepareLead({
      fullName: `Synthetic Plan Probe ${k}`,
      primaryPhone: closed[k]!.slice(3),
      email: emails[k]!,
    } as never);
    if (!p.ok) throw new Error(JSON.stringify(p.issues));
    try {
      await runner.withTenant(actor.ctx.tenant, async (tx: Prisma.TransactionClient) => {
        captured.length = 0;
        const res = await insertNewLead(tx as never, actor.ctx, p.lead, {
          sourceId: source,
          ownerUserId: null,
          teamId: null,
          origin: 'IMPORT',
        });
        const dupCases = Number(
          (
            (await tx.$queryRawUnsafe(
              `SELECT count(*)::int n FROM lead_duplicate_match WHERE lead_id = $1::uuid`,
              res.leadId,
            )) as { n: number }[]
          )[0]!.n,
        );
        for (const q of [...captured]) {
          const l = label(q.query);
          if (!l || !/^\s*SELECT/i.test(q.query)) continue;
          const plan = (await tx.$queryRawUnsafe(
            `EXPLAIN (ANALYZE, BUFFERS, FORMAT JSON) ${q.query}`,
            ...JSON.parse(q.params),
          )) as { 'QUERY PLAN': { Plan: PlanNode; 'Execution Time': number }[] }[];
          const top = plan[0]!['QUERY PLAN'][0]!;
          const e = (byLabel[l] ??= { ms: [], nodes: nodesOf(top.Plan), found: [], sql: q.query });
          e.ms.push(Math.round(top['Execution Time'] * 100) / 100);
          e.found.push(l.startsWith('returning') ? (res.returning ? 1 : 0) : dupCases);
        }
        throw new Rollback();
      });
    } catch (e) {
      if (!(e instanceof Rollback)) throw e;
    }
  }
  const summary: Record<string, unknown> = {};
  for (const [l, e] of Object.entries(byLabel)) {
    const s = [...e.ms].sort((a, b) => a - b);
    summary[l] = {
      samples: s.length,
      p50Ms: s[Math.floor(s.length / 2)],
      maxMs: s[s.length - 1],
      plan: e.nodes,
      matchedEverySample: e.found.every((x) => x > 0),
      sql: e.sql.replace(/\s+/g, ' ').slice(0, 600),
    };
    console.log(
      `${org} ${l}: p50 ${s[Math.floor(s.length / 2)]} ms, max ${s[s.length - 1]} ms, matched ${e.found.filter((x) => x > 0).length}/${e.found.length}, plan ${e.nodes.join(' > ')}`,
    );
  }
  (out.orgs as Record<string, unknown>)[org] = summary;
}
const leftovers = Number(
  (
    await migrator.query(
      `SELECT count(*) n FROM lead WHERE full_name LIKE 'Synthetic Plan Probe %'`,
    )
  ).rows[0].n,
);
out.rolledBack = leftovers === 0;
console.log('rolled back (no probe leads kept):', leftovers === 0);
writeFileSync(process.argv[3]!, JSON.stringify(out, null, 2));
await migrator.end();
await client.$disconnect();
await appPool.end();
process.exit(0);
