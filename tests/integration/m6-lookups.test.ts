// Phase 2 M6 performance changes P-A to P-F: the same results as before, with lookups an index
// can serve under RLS. P-A returning-customer lookup, P-B normalised e-mail duplicate check,
// P-C exact path for a complete phone number in search, P-D name-sort order, P-F open-lead
// phone match. Needs migrations 0007 and 0008; synthetic data only.
//
// Plan checks run as crm_app inside a tenant transaction. The question is whether RLS lets the
// index serve the predicate at all: a non-LEAKPROOF predicate cannot be an index condition under
// RLS, whatever the table size. So the test org gets 5,000 unowned filler leads (fresh phones and
// e-mails, invisible to the other assertions) and the table is analysed, and seq scans are
// disabled; otherwise the planner picks any index on a near-empty, unanalysed table.
import { beforeAll, describe, expect, it } from 'vitest';
import * as leads from '@/modules/leads';
import type { SearchParams } from '@/modules/leads';
import { migrator, withRole } from '../support/db';
import { actorIn, seedOrg, type Actor } from '../support/factory';

const APP = process.env.TEST_DATABASE_URL!;

let A: Awaited<ReturnType<typeof seedOrg>>;
let B: Awaited<ReturnType<typeof seedOrg>>;
const a = {} as Record<'owner' | 'exec1' | 'exec2', Actor>;
let ownerB: Actor;
let sourceA: string;
let sourceB: string;

let seq = 0;
/** A fresh valid mobile number per call ("96xxxxxxxx"). */
const nextPhone = () => `96${String(20_000_000 + ++seq * 7_727).slice(-8)}`;

async function created(actor: Actor, input: Record<string, string> = {}): Promise<string> {
  const r = await leads.createLead(actor.ctx, {
    fullName: 'Synthetic M6',
    primaryPhone: nextPhone(),
    ...input,
  });
  if (r.status !== 'created') throw new Error(`expected created, got ${JSON.stringify(r)}`);
  return r.leadId;
}

/** A closed lead written directly (several closed leads may share a phone). */
async function closedLead(
  orgId: string,
  sourceId: string,
  primary10: string,
  o: {
    stage?: 'WON' | 'LOST';
    alternate10?: string;
    createdAt?: Date;
    deletedAt?: Date;
    ownerUserId?: string;
  } = {},
) {
  const l = await migrator().lead.create({
    data: {
      orgId,
      fullName: 'Synthetic Closed',
      primaryPhoneE164: `+91${primary10}`,
      primaryPhoneRaw: primary10,
      phoneLast10: primary10,
      alternatePhoneE164: o.alternate10 ? `+91${o.alternate10}` : null,
      sourceId,
      stage: o.stage ?? 'LOST',
      ...(o.stage === 'WON' ? { wonAt: new Date() } : { lostAt: new Date() }),
      ...(o.createdAt ? { createdAt: o.createdAt } : {}),
      ...(o.deletedAt ? { deletedAt: o.deletedAt } : {}),
      ...(o.ownerUserId ? { ownerUserId: o.ownerUserId } : {}),
    },
    select: { id: true },
  });
  // An owned lead always has its creation spell (M3); without it the 0004 backfill test, which
  // counts spells across the database, would pick this row up.
  if (o.ownerUserId)
    await migrator().$executeRaw`
      INSERT INTO lead_assignment_history (org_id, lead_id, user_id, started_at, source)
      VALUES (${orgId}::uuid, ${l.id}::uuid, ${o.ownerUserId}::uuid, now(), 'BULK')`;
  return l.id;
}

const previousOf = async (id: string) =>
  (await migrator().lead.findUniqueOrThrow({ where: { id } })).previousLeadId;

const emailCases = async (leadId: string) =>
  migrator().leadDuplicateMatch.findMany({
    where: { OR: [{ leadId }, { candidateLeadId: leadId }], matchType: 'EMAIL' },
    select: { leadId: true, candidateLeadId: true, orgId: true },
  });

interface PlanNode {
  'Node Type': string;
  'Index Name'?: string;
  'Index Cond'?: string;
  Plans?: PlanNode[];
}

/** EXPLAIN (FORMAT JSON) as crm_app in a tenant transaction, seq scans disabled. */
async function planAsApp(
  actor: Actor,
  sql: string,
  params: unknown[],
  settings: string[] = [],
): Promise<PlanNode> {
  return withRole(APP, async (c) => {
    await c.query('BEGIN');
    try {
      await c.query(
        "SELECT set_config('app.org_id', $1, true), set_config('app.user_id', $2, true)",
        [actor.ctx.orgId, actor.user.id],
      );
      await c.query('SET LOCAL enable_seqscan = off');
      for (const setting of settings) await c.query(`SET LOCAL ${setting}`);
      const r = await c.query(`EXPLAIN (FORMAT JSON) ${sql}`, params);
      return (r.rows[0]['QUERY PLAN'] as { Plan: PlanNode }[])[0]!.Plan;
    } finally {
      await c.query('ROLLBACK');
    }
  });
}

/** Every node of a plan tree. */
const nodesOf = (n: PlanNode): PlanNode[] => [n, ...(n.Plans ?? []).flatMap(nodesOf)];

/** Index conditions of the scans on the named index, joined. */
const indexConds = (plan: PlanNode, index: string) =>
  nodesOf(plan)
    .filter((n) => n['Index Name'] === index)
    .map((n) => n['Index Cond'] ?? '')
    .join(' | ');

beforeAll(async () => {
  A = await seedOrg('M6LookupA');
  B = await seedOrg('M6LookupB');
  for (const k of ['owner', 'exec1', 'exec2'] as const) a[k] = await actorIn(A.users[k], A.orgId);
  ownerB = await actorIn(B.users.owner, B.orgId);
  sourceA = (
    await migrator().leadSource.create({
      data: { orgId: A.orgId, name: 'M6 Source', channel: 'PORTAL' },
    })
  ).id;
  sourceB = (
    await migrator().leadSource.create({
      data: { orgId: B.orgId, name: 'M6 Source', channel: 'PORTAL' },
    })
  ).id;
  // Filler for the plan checks: unowned, phones 95…, e-mails filler.m6.<n>@example.test.
  await migrator().$executeRaw`
    INSERT INTO lead (org_id, full_name, primary_phone_e164, primary_phone_raw, phone_last10,
                      alternate_phone_e164, email, source_id, stage)
    SELECT ${A.orgId}::uuid, 'Synthetic Filler ' || g, '+9195' || lpad(g::text, 8, '0'),
           '95' || lpad(g::text, 8, '0'), '95' || lpad(g::text, 8, '0'),
           CASE WHEN g % 10 = 0 THEN '+9194' || lpad(g::text, 8, '0') END,
           CASE WHEN g % 2 = 0 THEN 'filler.m6.' || g || '@example.test' END,
           ${sourceA}::uuid, (CASE WHEN g % 5 = 0 THEN 'LOST' ELSE 'NEW' END)::lead_stage
      FROM generate_series(1, 5000) g`;
  await migrator().$executeRawUnsafe('ANALYZE lead');
});

// ---------------------------------------------------------------------------------------------
describe('P-A returning-customer lookup (lead-lifecycle §5.3): unchanged rules', () => {
  it('a closed lead with the same primary phone is linked, also when typed in another format', async () => {
    const p = nextPhone();
    const old = await closedLead(A.orgId, sourceA, p);
    const id = await created(a.exec1, { primaryPhone: `+91 ${p.slice(0, 5)} ${p.slice(5)}` });
    expect(await previousOf(id)).toBe(old);
    const act = await migrator().leadActivity.findFirstOrThrow({
      where: { leadId: id, type: 'CREATED' },
    });
    expect(act.summary).toMatchObject({ returning: true });
  });

  it('alternate numbers do not link: only primary against primary (as before)', async () => {
    // The closed lead has the number only as its alternate.
    const p = nextPhone();
    await closedLead(A.orgId, sourceA, nextPhone(), { alternate10: p });
    const viaAlt = await created(a.exec1, { primaryPhone: p });
    expect(await previousOf(viaAlt)).toBeNull();
    // The new lead has the closed lead's primary only as its alternate.
    const q = nextPhone();
    await closedLead(A.orgId, sourceA, q);
    const newAlt = await created(a.exec1, { primaryPhone: nextPhone(), alternatePhone: q });
    expect(await previousOf(newAlt)).toBeNull();
  });

  it('several closed leads: the most recently created live one wins; deleted ones are ignored', async () => {
    const p = nextPhone();
    const day = 86_400_000;
    await closedLead(A.orgId, sourceA, p, {
      stage: 'WON',
      createdAt: new Date(Date.now() - 30 * day),
    });
    const newest = await closedLead(A.orgId, sourceA, p, {
      stage: 'LOST',
      createdAt: new Date(Date.now() - 2 * day),
    });
    await closedLead(A.orgId, sourceA, p, {
      createdAt: new Date(Date.now() - day),
      deletedAt: new Date(),
    });
    const id = await created(a.exec1, { primaryPhone: p });
    expect(await previousOf(id)).toBe(newest);
  });

  it('is tenant-scoped: a closed lead of another org is never linked', async () => {
    const p = nextPhone();
    await closedLead(B.orgId, sourceB, p);
    const id = await created(a.exec1, { primaryPhone: p });
    expect(await previousOf(id)).toBeNull();
    // And org B still links its own.
    const own = await closedLead(B.orgId, sourceB, nextPhone());
    const phoneB = (await migrator().lead.findUniqueOrThrow({ where: { id: own } })).phoneLast10;
    const bId = await created(ownerB, { primaryPhone: phoneB });
    expect(await previousOf(bId)).toBe(own);
  });

  it('every lead keeps phone_last10 = last 10 digits of the primary phone (the index key)', async () => {
    const bad = await migrator().$queryRaw<{ n: number }[]>`
      SELECT count(*)::int n FROM lead WHERE phone_last10 <> right(primary_phone_e164, 10)
        AND org_id IN (${A.orgId}::uuid, ${B.orgId}::uuid)`;
    expect(bad[0]!.n).toBe(0);
  });

  it('plan as crm_app under RLS: the (org_id, phone_last10) index serves it', async () => {
    const plan = await planAsApp(
      a.exec1,
      `SELECT id FROM lead WHERE org_id = $1::uuid AND phone_last10 = $2 AND primary_phone_e164 = $3
         AND stage IN ('WON', 'LOST') AND deleted_at IS NULL ORDER BY created_at DESC LIMIT 1`,
      [A.orgId, '9600000000', '+919600000000'],
    );
    expect(indexConds(plan, 'lead_org_id_phone_last10_idx')).toMatch(/phone_last10 = /);
  });
});

// ---------------------------------------------------------------------------------------------
describe('P-B e-mail duplicate check on email_normalized: unchanged rules', () => {
  it('an exact e-mail match in another case opens one EMAIL case', async () => {
    const first = await created(a.exec1, { email: 'Mixed.Case.M6@Example.test' });
    const second = await created(a.exec2, { email: 'mixed.case.m6@example.TEST' });
    expect(await emailCases(second)).toEqual([
      { leadId: second, candidateLeadId: first, orgId: A.orgId },
    ]);
  });

  it('leads without an e-mail never match each other', async () => {
    const x = await created(a.exec1);
    const y = await created(a.exec1, { email: '' });
    expect(await emailCases(x)).toEqual([]);
    expect(await emailCases(y)).toEqual([]);
    expect((await migrator().lead.findUniqueOrThrow({ where: { id: y } })).email).toBeNull();
  });

  it('a different address, or one that only contains the other, does not match', async () => {
    await created(a.exec1, { email: 'contains.m6@example.test' });
    const z = await created(a.exec1, { email: 'xcontains.m6@example.test' });
    expect(await emailCases(z)).toEqual([]);
  });

  it('deleted and merged leads are not candidates (as before)', async () => {
    const gone = await created(a.exec1, { email: 'gone.m6@example.test' });
    await migrator().lead.update({ where: { id: gone }, data: { deletedAt: new Date() } });
    const n = await created(a.exec1, { email: 'gone.m6@example.test' });
    expect(await emailCases(n)).toEqual([]);
  });

  it('is tenant-scoped: the same e-mail in another org opens nothing in either org', async () => {
    const inA = await created(a.exec1, { email: 'shared.m6@example.test' });
    const inB = await created(ownerB, { email: 'SHARED.m6@example.test' });
    expect(await emailCases(inA)).toEqual([]);
    expect(await emailCases(inB)).toEqual([]);
  });

  it('the database maintains the value on every write; nobody can write it directly', async () => {
    const id = await created(a.exec1, { email: 'Upper.M6@Example.TEST' });
    const val = async () =>
      (
        await migrator().$queryRaw<{ v: string | null }[]>`
          SELECT email_normalized v FROM lead WHERE id = ${id}::uuid`
      )[0]!.v;
    expect(await val()).toBe('upper.m6@example.test');
    // Any later write path (here the schema owner, as a future contact edit would) keeps it in step.
    await migrator()
      .$executeRaw`UPDATE lead SET email = 'Changed.M6@Example.test' WHERE id = ${id}::uuid`;
    expect(await val()).toBe('changed.m6@example.test');
    await migrator().$executeRaw`UPDATE lead SET email = NULL WHERE id = ${id}::uuid`;
    expect(await val()).toBeNull();
    for (const sql of [
      `UPDATE lead SET email_normalized = 'forged@example.test' WHERE id = '${id}'`,
      `INSERT INTO lead (org_id, full_name, primary_phone_e164, primary_phone_raw, phone_last10, source_id, created_by, email_normalized)
         VALUES ('${A.orgId}', 'X', '+919611111111', '9611111111', '9611111111', '${sourceA}', '${A.users.exec1.id}', 'forged@example.test')`,
    ])
      await expect(
        withRole(APP, async (c) => {
          await c.query('BEGIN');
          try {
            await c.query(
              "SELECT set_config('app.org_id', $1, true), set_config('app.user_id', $2, true)",
              [A.orgId, A.users.exec1.id],
            );
            await c.query(sql);
          } finally {
            await c.query('ROLLBACK');
          }
        }),
      ).rejects.toThrow(
        /can only be updated to DEFAULT|cannot insert a non-DEFAULT value|permission denied/,
      );
  });

  it('plan as crm_app under RLS: equality on email_normalized uses its index', async () => {
    const plan = await planAsApp(
      a.exec1,
      `SELECT id FROM lead WHERE org_id = $1::uuid AND email_normalized = lower($2)
         AND id <> $3::uuid AND merged_into_lead_id IS NULL AND deleted_at IS NULL
       ORDER BY created_at LIMIT 10`,
      [A.orgId, 'X@Example.test', A.orgId],
    );
    expect(indexConds(plan, 'lead_org_id_email_normalized_idx')).toMatch(/email_normalized = /);
  });
});

// ---------------------------------------------------------------------------------------------
describe('P-C search: a complete phone number takes the exact path', () => {
  const ids: Record<string, string> = {};
  let p: string;
  const search = async (actor: Actor, params: SearchParams) =>
    (await leads.searchLeads(actor.ctx, params)).rows.map((r) => r.id).sort();
  beforeAll(async () => {
    p = nextPhone();
    // Only one OPEN lead may hold a number (either slot), so the other holders are closed leads.
    ids.primary = await created(a.exec1, { primaryPhone: p, fullName: 'Primary Holder' });
    ids.alternate = await closedLead(A.orgId, sourceA, nextPhone(), {
      alternate10: p,
      ownerUserId: A.users.exec1.id,
    });
    ids.closed = await closedLead(A.orgId, sourceA, p, {
      stage: 'WON',
      ownerUserId: A.users.exec1.id,
    });
    ids.emailHasDigits = await created(a.exec1, { email: `${p}@example.test` });
    ids.inB = await created(ownerB, { primaryPhone: p });
  });

  it('matches primary and alternate numbers in every accepted format, any stage', async () => {
    const expected = [ids.primary!, ids.alternate!, ids.closed!].sort();
    for (const q of [p, `+91${p}`, `+91 ${p.slice(0, 5)} ${p.slice(5)}`, `0${p}`, `91-${p}`])
      expect(await search(a.exec1, { q }), q).toEqual(expected);
  });

  it('documented change: an e-mail or name that merely contains the number is not a match', async () => {
    expect(await search(a.exec1, { q: p })).not.toContain(ids.emailHasDigits);
    // The same digits as a fragment still use the substring path (name, e-mail, phones).
    expect(await search(a.exec1, { q: p.slice(2) })).toEqual(
      [ids.primary!, ids.alternate!, ids.emailHasDigits!, ids.closed!].sort(),
    );
  });

  it('partial numbers keep substring matching', async () => {
    expect(await search(a.exec1, { q: p.slice(-6) })).toEqual(
      expect.arrayContaining([ids.primary!, ids.alternate!, ids.closed!]),
    );
    expect(await search(a.exec1, { q: p.slice(3, 8) })).toEqual(
      expect.arrayContaining([ids.primary!, ids.alternate!]),
    );
  });

  it('scope and tenant still apply: other orgs and out-of-scope leads are never returned', async () => {
    expect(await search(ownerB, { q: p })).toEqual([ids.inB]);
    expect(await search(a.exec2, { q: p })).toEqual([]);
    const owner = await search(a.owner, { q: p });
    expect(owner).not.toContain(ids.inB);
    expect(owner).toEqual([ids.primary!, ids.alternate!, ids.closed!].sort());
  });

  it('plan as crm_app under RLS: both phone indexes serve the exact path', async () => {
    const plan = await planAsApp(
      a.exec1,
      `SELECT id FROM lead WHERE ((phone_last10 = $1 AND primary_phone_e164 = $2)
         OR alternate_phone_e164 = $2) AND merged_into_lead_id IS NULL`,
      [p, `+91${p}`],
    );
    expect(indexConds(plan, 'lead_org_id_phone_last10_idx')).toMatch(/phone_last10 = /);
    expect(indexConds(plan, 'lead_org_id_alternate_phone_e164_idx')).toMatch(
      /alternate_phone_e164 = /,
    );
  });
});

// ---------------------------------------------------------------------------------------------
describe('P-D name sort: same order with the (org_id, full_name, id) index', () => {
  const names = [
    'beta',
    'Alpha',
    'alpha',
    'Émile',
    'emile',
    'Zed',
    'alpha',
    'Ålesund',
    'a b',
    'ab',
  ];
  let org: Awaited<ReturnType<typeof seedOrg>>;
  let owner: Actor;
  beforeAll(async () => {
    org = await seedOrg('M6Sort');
    owner = await actorIn(org.users.owner, org.orgId);
    for (const n of names) await created(owner, { fullName: n });
    for (let i = 0; i < 30; i++) await created(owner, { fullName: 'Tie M6' });
  });

  it('pages follow ORDER BY full_name, id (database collation, id as tie-breaker)', async () => {
    const seen: string[] = [];
    let cursor: string | null = null;
    for (let i = 0; i < 10; i++) {
      const page = await leads.searchLeads(owner.ctx, {
        sort: 'name',
        ...(cursor ? { cursor } : {}),
      });
      seen.push(...page.rows.map((r) => r.id));
      cursor = page.nextCursor;
      if (!cursor) break;
    }
    const expected = await migrator().$queryRaw<{ id: string }[]>`
      SELECT id FROM lead WHERE org_id = ${org.orgId}::uuid AND archived_at IS NULL
        AND merged_into_lead_id IS NULL ORDER BY full_name, id`;
    expect(seen).toEqual(expected.map((e) => e.id));
    expect(seen).toHaveLength(names.length + 30);
  });

  it('plan as crm_app under RLS: the index returns rows in order (no sort step)', async () => {
    const plan = await planAsApp(
      owner,
      `SELECT id FROM lead WHERE archived_at IS NULL AND merged_into_lead_id IS NULL
       ORDER BY full_name ASC, id ASC LIMIT 26`,
      [],
    );
    const nodes = nodesOf(plan);
    expect(nodes.some((n) => n['Index Name'] === 'lead_org_id_full_name_id_idx')).toBe(true);
    expect(nodes.some((n) => n['Node Type'] === 'Sort')).toBe(false);
  });
});

// ---------------------------------------------------------------------------------------------
describe('P-F open-lead phone match (lead-lifecycle §5.1): unchanged rules', () => {
  /** An open (or other-state) lead written directly, so several may share a number. */
  async function openLead(
    orgId: string,
    sourceId: string,
    primary10: string,
    o: {
      alternate10?: string;
      stage?: 'NEW' | 'WON' | 'LOST';
      createdAt?: Date;
      archivedAt?: Date;
      deletedAt?: Date;
      mergedIntoLeadId?: string;
    } = {},
  ) {
    const stage = o.stage ?? 'NEW';
    return (
      await migrator().lead.create({
        data: {
          orgId,
          fullName: 'Synthetic Open',
          primaryPhoneE164: `+91${primary10}`,
          primaryPhoneRaw: primary10,
          phoneLast10: primary10,
          alternatePhoneE164: o.alternate10 ? `+91${o.alternate10}` : null,
          sourceId,
          stage,
          ...(stage === 'WON' ? { wonAt: new Date() } : {}),
          ...(stage === 'LOST' ? { lostAt: new Date() } : {}),
          ...(o.createdAt ? { createdAt: o.createdAt } : {}),
          ...(o.archivedAt ? { archivedAt: o.archivedAt } : {}),
          ...(o.deletedAt ? { deletedAt: o.deletedAt } : {}),
          ...(o.mergedIntoLeadId ? { mergedIntoLeadId: o.mergedIntoLeadId } : {}),
        },
        select: { id: true },
      })
    ).id;
  }
  const create = (actor: Actor, primaryPhone: string, alternatePhone?: string) =>
    leads.createLead(actor.ctx, {
      fullName: 'Synthetic P-F',
      primaryPhone,
      ...(alternatePhone ? { alternatePhone } : {}),
    });

  it('primary against primary, in any accepted format', async () => {
    const p = nextPhone();
    const id = await openLead(A.orgId, sourceA, p);
    const r = await create(a.owner, `+91 ${p.slice(0, 5)} ${p.slice(5)}`);
    expect(r).toMatchObject({ status: 'duplicate', leadId: id, archived: false });
  });

  it('alternate numbers match in every direction (primary/alternate, alternate/alternate)', async () => {
    const p = nextPhone();
    const q = nextPhone();
    const r = nextPhone();
    const viaItsAlt = await openLead(A.orgId, sourceA, nextPhone(), { alternate10: p });
    expect(await create(a.owner, p)).toMatchObject({ status: 'duplicate', leadId: viaItsAlt });
    const viaMyAlt = await openLead(A.orgId, sourceA, q);
    expect(await create(a.owner, nextPhone(), q)).toMatchObject({
      status: 'duplicate',
      leadId: viaMyAlt,
    });
    const altAlt = await openLead(A.orgId, sourceA, nextPhone(), { alternate10: r });
    expect(await create(a.owner, nextPhone(), r)).toMatchObject({
      status: 'duplicate',
      leadId: altAlt,
    });
  });

  it('won, lost, deleted and merged leads are not open matches; archived ones are (flagged)', async () => {
    for (const stage of ['WON', 'LOST'] as const) {
      const p = nextPhone();
      await openLead(A.orgId, sourceA, p, { stage });
      expect((await create(a.owner, p)).status).toBe('created');
    }
    const d = nextPhone();
    await openLead(A.orgId, sourceA, d, { deletedAt: new Date() });
    expect((await create(a.owner, d)).status).toBe('created');
    const m = nextPhone();
    const target = await openLead(A.orgId, sourceA, nextPhone());
    await openLead(A.orgId, sourceA, m, { mergedIntoLeadId: target });
    expect((await create(a.owner, m)).status).toBe('created');
    const ar = nextPhone();
    const archived = await openLead(A.orgId, sourceA, ar, { archivedAt: new Date() });
    expect(await create(a.owner, ar)).toMatchObject({
      status: 'duplicate',
      leadId: archived,
      archived: true,
    });
  });

  it('several open matches: the oldest wins, whichever phone matched', async () => {
    const p = nextPhone();
    const day = 86_400_000;
    await openLead(A.orgId, sourceA, p, { createdAt: new Date(Date.now() - day) });
    const oldest = await openLead(A.orgId, sourceA, nextPhone(), {
      alternate10: p,
      createdAt: new Date(Date.now() - 9 * day),
    });
    expect(await create(a.owner, p)).toMatchObject({ status: 'duplicate', leadId: oldest });
  });

  it('is tenant-scoped: an open lead of another org never matches', async () => {
    const p = nextPhone();
    const q = nextPhone();
    await openLead(B.orgId, sourceB, p, { alternate10: q });
    expect((await create(a.owner, p)).status).toBe('created');
    expect((await create(a.owner, nextPhone(), q)).status).toBe('created');
    // Org B still finds its own.
    expect((await create(ownerB, q)).status).toBe('duplicate');
  });

  it('concurrent creates sharing one number as primary or alternate: one lead, the rest duplicates', async () => {
    const p = nextPhone();
    const results = await Promise.all(
      Array.from({ length: 8 }, (_, i) =>
        i % 2 ? create(i % 4 === 1 ? a.exec1 : a.owner, nextPhone(), p) : create(a.owner, p),
      ),
    );
    expect(results.filter((r) => r.status === 'created')).toHaveLength(1);
    expect(results.filter((r) => r.status === 'duplicate')).toHaveLength(7);
    const holders = await migrator().lead.count({
      where: {
        orgId: A.orgId,
        OR: [{ primaryPhoneE164: `+91${p}` }, { alternatePhoneE164: `+91${p}` }],
      },
    });
    expect(holders).toBe(1);
  });

  it('plan as crm_app under RLS: lead_open_phone_uq and the alternate index serve it', async () => {
    // The SQL of findOpenMatch (src/modules/leads/access.ts), with its literal stage list. On the
    // test org (≈ 4k open leads) the cheapest plan is to read all of them through the partial
    // index and filter; at 250k (crm_perf) the planner picks the BitmapOr below by cost. Raising
    // the per-row filter cost here shows the same plan, i.e. that RLS lets both phone conditions
    // be index conditions. The tests above added leads after the first ANALYZE.
    await migrator().$executeRawUnsafe('ANALYZE lead');
    const plan = await planAsApp(
      a.exec1,
      `SELECT id, archived_at FROM lead
        WHERE stage NOT IN ('WON', 'LOST') AND deleted_at IS NULL AND merged_into_lead_id IS NULL
          AND (primary_phone_e164 = ANY($1::text[]) OR alternate_phone_e164 = ANY($1::text[]))
        ORDER BY created_at ASC LIMIT 1`,
      [['+919500000010', '+919400000010']],
      ['cpu_operator_cost = 1'],
    );
    expect(indexConds(plan, 'lead_open_phone_uq')).toMatch(/primary_phone_e164 = ANY/);
    expect(indexConds(plan, 'lead_org_id_alternate_phone_e164_idx')).toMatch(
      /alternate_phone_e164 = ANY/,
    );
  });
});
