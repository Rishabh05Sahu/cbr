// S1-17 performance sanity: lead list with RLS + scope on 250k seeded leads,
// p95 <= 500 ms locally; RLS overhead vs the same query without RLS <= 15%.
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import {
  createAppClient,
  createLocalSuperuserBaselinePool,
  createMigratorClient,
  tenantRunnerFor,
} from '../db/clients';
import { listLeads } from '../harness/lead-repository';

const LEADS = 250_000;
const EXECS = 20;
const TEAMS = 4;
const RUNS = 200;
const WARMUP = 20;
const PERF_ORG = 'PERF-250k';

const migrator = createMigratorClient(2);
const app = createAppClient(5);
const { withTenant } = tenantRunnerFor(app);
// Baseline only: the local superuser bypasses RLS entirely. Never used by the app.
const superuser = createLocalSuperuserBaselinePool();

interface Perf {
  orgId: string;
  admin: string;
  manager: string;
  execs: string[];
}
let P: Perf;

async function seedPerfOrg(): Promise<Perf> {
  const db = migrator.prisma;
  const existing = await db.organization.findFirst({ where: { name: PERF_ORG } });
  if (!existing) {
    await db.$executeRawUnsafe(`
      WITH o AS (INSERT INTO organization (name) VALUES ('${PERF_ORG}') RETURNING id),
      u AS (
        INSERT INTO "user" (email, name)
        SELECT 'perf' || g || '@perf.test', 'Perf ' || g FROM generate_series(0, ${EXECS + TEAMS}) g
        RETURNING id, email
      ),
      m AS (
        INSERT INTO organization_membership (org_id, user_id, role_code)
        SELECT o.id, u.id,
          CASE WHEN u.email = 'perf0@perf.test' THEN 'ADMIN'::membership_role
               WHEN substring(u.email from 'perf(\\d+)')::int > ${EXECS} THEN 'SALES_MANAGER'::membership_role
               ELSE 'SALES_EXECUTIVE'::membership_role END
        FROM o, u
        RETURNING id, user_id, org_id
      )
      SELECT count(*) FROM m`);
    const org = (await db.organization.findFirst({ where: { name: PERF_ORG } }))!;
    const members = await db.organizationMembership.findMany({
      where: { orgId: org.id },
      include: { user: true },
    });
    const num = (e: string) => Number(/perf(\d+)@/.exec(e)![1]);
    const execs = members
      .filter((m) => m.roleCode === 'SALES_EXECUTIVE')
      .sort((a, b) => num(a.user.email) - num(b.user.email));
    const managers = members
      .filter((m) => m.roleCode === 'SALES_MANAGER')
      .sort((a, b) => num(a.user.email) - num(b.user.email));
    for (let t = 0; t < TEAMS; t++) {
      const team = await db.team.create({ data: { orgId: org.id, name: `Team ${t}` } });
      await db.teamMembership.create({
        data: { orgId: org.id, teamId: team.id, membershipId: managers[t]!.id, teamRole: 'LEAD' },
      });
      const teamExecs = execs.slice(t * (EXECS / TEAMS), (t + 1) * (EXECS / TEAMS));
      for (const e of teamExecs) {
        await db.teamMembership.create({
          data: { orgId: org.id, teamId: team.id, membershipId: e.id },
        });
      }
    }
    // 250k leads: owner round-robin over execs, team = owner's team, created over the last 2 years.
    await db.$executeRawUnsafe(
      `
      WITH e AS (
        SELECT m.user_id, tm.team_id, row_number() OVER (ORDER BY u.email) - 1 AS idx
        FROM organization_membership m
        JOIN "user" u ON u.id = m.user_id
        JOIN team_membership tm ON tm.membership_id = m.id AND tm.org_id = m.org_id
        WHERE m.org_id = $1::uuid AND m.role_code = 'SALES_EXECUTIVE'
      )
      INSERT INTO lead (org_id, full_name, primary_phone_e164, owner_user_id, team_id, created_at)
      SELECT $1::uuid, 'Lead ' || g, '+9190' || lpad(g::text, 8, '0'), e.user_id, e.team_id,
             now() - (random() * interval '730 days')
      FROM generate_series(1, ${LEADS}) g
      JOIN e ON e.idx = g % ${EXECS}`,
      org.id,
    );
  }
  await db.$executeRawUnsafe('ANALYZE lead');
  await db.$executeRawUnsafe('ANALYZE team_membership');
  await db.$executeRawUnsafe('ANALYZE organization_membership');
  const org = (await db.organization.findFirst({ where: { name: PERF_ORG } }))!;
  const members = await db.organizationMembership.findMany({
    where: { orgId: org.id },
    include: { user: true },
  });
  return {
    orgId: org.id,
    admin: members.find((m) => m.roleCode === 'ADMIN')!.userId,
    manager: members.find((m) => m.roleCode === 'SALES_MANAGER')!.userId,
    execs: members.filter((m) => m.roleCode === 'SALES_EXECUTIVE').map((m) => m.userId),
  };
}

const pct = (xs: number[], p: number) => {
  const s = [...xs].sort((a, b) => a - b);
  return s[Math.min(s.length - 1, Math.ceil((p / 100) * s.length) - 1)]!;
};
const fmt = (n: number) => n.toFixed(2);

beforeAll(async () => {
  P = await seedPerfOrg();
}, 600_000);
afterAll(async () => {
  await Promise.all([app.close(), migrator.close(), superuser.end()]);
});

describe('S1-17 performance sanity', () => {
  it('seed check: 250k leads in the perf org', async () => {
    const n = await withTenant({ orgId: P.orgId, userId: P.admin }, (tx) => tx.lead.count());
    expect(n).toBe(LEADS);
  });

  it.each([
    ['Sales Executive (OWN)', () => P.execs[3]!],
    ['Sales Manager (TEAM)', () => P.manager],
    ['Admin (ORG)', () => P.admin],
  ])('end-to-end list (withTenant + scope + ORM), %s: p95 <= 500 ms', async (label, who) => {
    const userId = who();
    const times: number[] = [];
    for (let i = 0; i < WARMUP + RUNS; i++) {
      const t = performance.now();
      const rows = await withTenant({ orgId: P.orgId, userId }, (tx) =>
        listLeads(tx, userId, { take: 50 }),
      );
      if (i >= WARMUP) times.push(performance.now() - t);
      expect(rows.length).toBe(50);
    }
    console.info(
      `[S1-17] ${label}: p50=${fmt(pct(times, 50))}ms p95=${fmt(pct(times, 95))}ms max=${fmt(Math.max(...times))}ms`,
    );
    expect(pct(times, 95)).toBeLessThanOrEqual(500);
  });

  it('RLS overhead vs the same query without RLS (superuser + explicit org predicate) <= 15%', async () => {
    const owners = P.execs.slice(0, 5);
    const rlsSql = `SELECT id, full_name, owner_user_id, created_at FROM lead
      WHERE owner_user_id = ANY($1::uuid[]) ORDER BY created_at DESC, id DESC LIMIT 50`;
    const baseSql = `SELECT id, full_name, owner_user_id, created_at FROM lead
      WHERE org_id = $2::uuid AND owner_user_id = ANY($1::uuid[]) ORDER BY created_at DESC, id DESC LIMIT 50`;

    const appConn = await app.pool.connect();
    const suConn = await superuser.connect();
    const rls: number[] = [];
    const base: number[] = [];
    try {
      // Interleave to share cache state and background noise.
      for (let i = 0; i < WARMUP + RUNS; i++) {
        await appConn.query('BEGIN');
        await appConn.query("SELECT set_config('app.org_id', $1, true)", [P.orgId]);
        let t = performance.now();
        const r1 = await appConn.query(rlsSql, [owners]);
        const d1 = performance.now() - t;
        await appConn.query('COMMIT');

        await suConn.query('BEGIN');
        t = performance.now();
        const r2 = await suConn.query(baseSql, [owners, P.orgId]);
        const d2 = performance.now() - t;
        await suConn.query('COMMIT');

        expect(r1.rows.map((r) => r.id)).toEqual(r2.rows.map((r) => r.id));
        if (i >= WARMUP) {
          rls.push(d1);
          base.push(d2);
        }
      }
      const plan = await suConn.query(`EXPLAIN (ANALYZE, COSTS OFF, TIMING OFF) ${baseSql}`, [
        owners,
        P.orgId,
      ]);
      await appConn.query('BEGIN');
      await appConn.query("SELECT set_config('app.org_id', $1, true)", [P.orgId]);
      const rlsPlan = await appConn.query(`EXPLAIN (ANALYZE, COSTS OFF, TIMING OFF) ${rlsSql}`, [
        owners,
      ]);
      await appConn.query('COMMIT');
      console.info(
        `[S1-17] baseline plan:\n${plan.rows.map((r: Record<string, string>) => r['QUERY PLAN']).join('\n')}`,
      );
      console.info(
        `[S1-17] RLS plan:\n${rlsPlan.rows.map((r: Record<string, string>) => r['QUERY PLAN']).join('\n')}`,
      );
    } finally {
      appConn.release();
      suConn.release();
    }
    const o50 = pct(rls, 50) / pct(base, 50) - 1;
    const o95 = pct(rls, 95) / pct(base, 95) - 1;
    console.info(
      `[S1-17] RLS p50=${fmt(pct(rls, 50))}ms p95=${fmt(pct(rls, 95))}ms | ` +
        `baseline p50=${fmt(pct(base, 50))}ms p95=${fmt(pct(base, 95))}ms | ` +
        `overhead p50=${(o50 * 100).toFixed(1)}% p95=${(o95 * 100).toFixed(1)}%`,
    );
    expect(o50).toBeLessThanOrEqual(0.15);
  });
});
