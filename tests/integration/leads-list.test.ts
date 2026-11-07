// Phase 2 M2 (FR-056): lead list search, filters and cursor pagination over a static synthetic
// dataset, with tenant and role scope applied before every filter and cursor.
import { beforeAll, describe, expect, it } from 'vitest';
import * as leads from '@/modules/leads';
import type { SearchParams } from '@/modules/leads';
import * as teams from '@/modules/teams';
import { DomainError } from '@/platform/errors';
import { migrator } from '../support/db';
import { actorIn, seedOrg, type Actor } from '../support/factory';

let A: Awaited<ReturnType<typeof seedOrg>>;
let B: Awaited<ReturnType<typeof seedOrg>>;
const a = {} as Record<'owner' | 'admin' | 'manager' | 'exec1' | 'exec2' | 'hr', Actor>;
let ownerB: Actor;
let teamId: string;
let sourceId: string;
const ids: Record<string, string> = {};

let seq = 0;
const phone = () => `97${String(30_000_000 + ++seq * 104_729).slice(-8)}`;

async function make(actor: Actor, key: string, input: Record<string, string> = {}) {
  const r = await leads.createLead(actor.ctx, {
    fullName: 'Synthetic',
    primaryPhone: phone(),
    ...input,
  });
  if (r.status !== 'created') throw new Error(`duplicate for ${key}`);
  ids[key] = r.leadId;
  return r.leadId;
}

/** Follows nextCursor to the end; returns ids in page order and the page sizes. */
async function walk(actor: Actor, params: SearchParams) {
  const seen: string[] = [];
  const sizes: number[] = [];
  let cursor: string | null = null;
  for (let i = 0; i < 20; i++) {
    const page = await leads.searchLeads(actor.ctx, { ...params, ...(cursor ? { cursor } : {}) });
    expect(page.errors).toEqual({});
    seen.push(...page.rows.map((r) => r.id));
    sizes.push(page.rows.length);
    cursor = page.nextCursor;
    if (!cursor) return { seen, sizes };
  }
  throw new Error('pagination did not end');
}

const idsOf = async (actor: Actor, params: SearchParams) =>
  (await leads.searchLeads(actor.ctx, params)).rows.map((r) => r.id);

beforeAll(async () => {
  A = await seedOrg('ListA');
  B = await seedOrg('ListB');
  for (const k of ['owner', 'admin', 'manager', 'exec1', 'exec2', 'hr'] as const)
    a[k] = await actorIn(A.users[k], A.orgId);
  ownerB = await actorIn(B.users.owner, B.orgId);
  teamId = (await teams.createTeam(a.owner.ctx, { name: 'List Team' })).id;
  await teams.addTeamMember(a.owner.ctx, {
    teamId,
    membershipId: A.membership.manager!,
    teamRole: 'LEAD',
  });
  await teams.addTeamMember(a.owner.ctx, { teamId, membershipId: A.membership.exec1! });
  sourceId = (
    await migrator().leadSource.create({
      data: { orgId: A.orgId, name: 'Portal X', channel: 'PORTAL' },
    })
  ).id;

  // 32 exec1 leads sharing one name (ties across pages for the name sort).
  for (let i = 0; i < 32; i++) await make(a.exec1, `tie${i}`, { fullName: 'Tie Name' });
  await make(a.exec1, 'rohanPune', {
    fullName: 'Rohan Searchable',
    email: 'rohan.pune@example.test',
    preferredCity: 'Pune',
    intent: 'HOT',
    propertyType: 'APARTMENT',
    budgetMin: '80 L',
    budgetMax: '1 Cr',
    sourceId,
  });
  await make(a.exec1, 'rohanMumbai', {
    fullName: 'Rohan Searchable',
    preferredCity: 'Mumbai',
    intent: 'HOT',
    propertyType: 'APARTMENT',
    budgetMax: '90 L',
  });
  await make(a.exec1, 'rohanCold', {
    fullName: 'rohan searchable',
    preferredCity: 'pune',
    intent: 'COLD',
    propertyType: 'VILLA',
    budgetMin: '3 Cr',
  });
  await make(a.exec1, 'phoneLead', { fullName: 'Phone Person', primaryPhone: '98123 45678' });
  await make(a.exec2, 'exec2Rohan', { fullName: 'Rohan Searchable', preferredCity: 'Pune' });
  await make(ownerB, 'bRohan', { fullName: 'Rohan Searchable', preferredCity: 'Pune' });
  await leads.changeStage(a.exec1.ctx, ids.rohanPune!, { toStage: 'CONTACTED', version: '1' });
  // An unassigned lead (assignment is M3; written directly for the owner=none filter).
  const unassigned = await migrator().lead.create({
    data: {
      orgId: A.orgId,
      fullName: 'Queue Lead',
      primaryPhoneE164: '+919700000001',
      primaryPhoneRaw: '9700000001',
      phoneLast10: '9700000001',
      sourceId,
      stage: 'NEW',
    },
  });
  ids.unassigned = unassigned.id;
});

describe('cursor pagination', () => {
  it.each(['newest', 'oldest', 'name'])(
    'sort=%s: every in-scope lead exactly once, in order, bounded pages, final page ends',
    async (sort) => {
      const { seen, sizes } = await walk(a.exec1, { sort });
      const expected = await migrator().lead.findMany({
        where: { orgId: A.orgId, ownerUserId: A.users.exec1.id },
        select: { id: true, fullName: true },
      });
      expect(new Set(seen).size).toBe(seen.length); // no repeats
      expect([...seen].sort()).toEqual(expected.map((e) => e.id).sort()); // no skips
      expect(sizes.every((s) => s <= leads.LEAD_PAGE_SIZE)).toBe(true);
      expect(sizes.length).toBeGreaterThan(1);
      if (sort === 'newest') expect(seen).toEqual([...seen].sort().reverse());
      if (sort === 'oldest') expect(seen).toEqual([...seen].sort());
      if (sort === 'name') {
        // 32 equal names straddle the page boundary; ties are ordered by id.
        const byId = new Map(expected.map((e) => [e.id, e.fullName]));
        const ties = seen.filter((id) => byId.get(id) === 'Tie Name');
        expect(ties).toHaveLength(32);
        expect(ties).toEqual([...ties].sort());
      }
    },
  );

  it('rows created after the first page do not cause repeats on the next page (newest)', async () => {
    const first = await leads.searchLeads(a.exec1.ctx, {});
    await make(a.exec1, 'late', { fullName: 'Late Arrival' });
    const second = await leads.searchLeads(a.exec1.ctx, { cursor: first.nextCursor! });
    const firstIds = new Set(first.rows.map((r) => r.id));
    expect(second.rows.some((r) => firstIds.has(r.id))).toBe(false);
    expect(second.rows.map((r) => r.id)).not.toContain(ids.late);
  });

  it('empty result and a single final page have no next cursor', async () => {
    expect(await leads.searchLeads(a.exec1.ctx, { q: 'zz-no-such-lead' })).toMatchObject({
      rows: [],
      nextCursor: null,
      errors: {},
    });
    const one = await leads.searchLeads(a.exec1.ctx, { q: 'Phone Person' });
    expect(one.rows.map((r) => r.id)).toEqual([ids.phoneLead]);
    expect(one.nextCursor).toBeNull();
  });
});

describe('search and filters', () => {
  it('search combined with several filters narrows to the matching lead', async () => {
    expect(
      await idsOf(a.exec1, {
        q: 'ROHAN search',
        city: 'PUNE',
        intent: 'HOT',
        propertyType: 'APARTMENT',
        budgetFrom: '90 L',
        budgetTo: '95 L',
        stage: ['CONTACTED', 'QUALIFIED'],
        source: sourceId,
      }),
    ).toEqual([ids.rohanPune]);
  });

  it('each filter on its own', async () => {
    const e = a.exec1;
    expect(new Set(await idsOf(e, { q: 'rohan', city: 'pune' }))).toEqual(
      new Set([ids.rohanPune, ids.rohanCold]),
    );
    expect(await idsOf(e, { q: 'rohan', intent: 'COLD' })).toEqual([ids.rohanCold]);
    expect(await idsOf(e, { q: 'rohan', propertyType: 'VILLA' })).toEqual([ids.rohanCold]);
    expect(await idsOf(e, { stage: 'CONTACTED' })).toEqual([ids.rohanPune]);
    expect(await idsOf(e, { source: sourceId })).toEqual([ids.rohanPune]);
    // Budget overlap: [80 L, 1 Cr] and [–, 90 L] overlap 85–95 L; [3 Cr, –] does not.
    expect(new Set(await idsOf(e, { q: 'rohan', budgetFrom: '85 L', budgetTo: '95 L' }))).toEqual(
      new Set([ids.rohanPune, ids.rohanMumbai]),
    );
    expect(await idsOf(e, { q: 'rohan', budgetFrom: '2.5 Cr' })).toEqual([ids.rohanCold]);
    const today = new Date(Date.now() + 5.5 * 36e5).toISOString().slice(0, 10);
    expect((await idsOf(e, { createdFrom: today, createdTo: today, q: 'rohan' })).length).toBe(3);
    expect(await idsOf(e, { createdTo: '2020-01-01' })).toEqual([]);
    expect(await idsOf(e, { team: teamId, q: 'Phone' })).toEqual([ids.phoneLead]);
  });

  it('phone fragments, full numbers in another format, and email', async () => {
    const e = a.exec1;
    expect(await idsOf(e, { q: '23456' })).toEqual([ids.phoneLead]);
    expect(await idsOf(e, { q: '+91-9812345678' })).toEqual([ids.phoneLead]);
    expect(await idsOf(e, { q: '098123 45678' })).toEqual([ids.phoneLead]);
    expect(await idsOf(e, { q: 'rohan.pune@EXAMPLE' })).toEqual([ids.rohanPune]);
  });

  it('search text is data: wildcards and SQL fragments match literally', async () => {
    for (const q of ['%%', '__', "' OR 1=1 --", 'Tie%', '\\'])
      expect(await idsOf(a.exec1, { q }), q).toEqual([]);
    const odd = await make(a.exec1, 'odd', { fullName: 'Deal 50%_off \\ Co' });
    for (const q of ['50%', '%_o', '\\ co', '0%_OFF'])
      expect(await idsOf(a.exec1, { q }), q).toEqual([odd]);
  });

  it('owner filter, including unassigned, for org-wide users', async () => {
    expect(new Set(await idsOf(a.admin, { owner: A.users.exec2.id }))).toEqual(
      new Set([ids.exec2Rohan]),
    );
    expect(await idsOf(a.admin, { owner: 'none' })).toEqual([ids.unassigned]);
  });

  it('invalid parameters return errors and no rows', async () => {
    for (const sp of [
      { stage: 'BOGUS' },
      { owner: 'not-a-uuid' },
      { budgetFrom: 'lots' },
      { createdFrom: '2026-13-01' },
      { sort: 'phone' },
      { q: 'x' },
      { cursor: 'forged' },
    ] as SearchParams[]) {
      const page = await leads.searchLeads(a.admin.ctx, sp);
      expect(Object.keys(page.errors).length, JSON.stringify(sp)).toBeGreaterThan(0);
      expect(page.rows).toEqual([]);
      expect(page.nextCursor).toBeNull();
    }
  });
});

describe('scope is applied before filters and cursors', () => {
  it('an executive never sees another executive’s lead, whatever the filters', async () => {
    const e2 = await idsOf(a.exec2, { q: 'rohan' });
    expect(e2).toEqual([ids.exec2Rohan]);
    expect(await idsOf(a.exec2, { owner: A.users.exec1.id })).toEqual([]);
    expect(await idsOf(a.exec2, { team: teamId })).toEqual([]);
    expect((await walk(a.exec2, {})).seen).toEqual([ids.exec2Rohan]);
  });

  it('a manager sees the led team’s leads only', async () => {
    const seen = new Set((await walk(a.manager, { q: 'rohan' })).seen);
    expect(seen.has(ids.rohanPune!)).toBe(true);
    expect(seen.has(ids.exec2Rohan!)).toBe(false);
    expect(seen.has(ids.unassigned!)).toBe(false);
    expect(await idsOf(a.manager, { owner: A.users.exec2.id })).toEqual([]);
  });

  it('owner/admin see the whole org; HR is refused', async () => {
    expect((await idsOf(a.owner, { q: 'rohan' })).length).toBe(4);
    await expect(leads.searchLeads(a.hr.ctx, {})).rejects.toBeInstanceOf(DomainError);
  });

  it('org B never sees org A rows, even with org A ids in filters or a forged cursor', async () => {
    expect(await idsOf(ownerB, { q: 'rohan' })).toEqual([ids.bRohan]);
    expect(await idsOf(ownerB, { owner: A.users.exec1.id })).toEqual([]);
    expect(await idsOf(ownerB, { team: teamId })).toEqual([]);
    expect(await idsOf(ownerB, { source: sourceId })).toEqual([]);
    // A cursor naming an org A lead (or any id) only sets a position inside B's own rows.
    for (const sort of ['newest', 'oldest', 'name'] as const) {
      const forged = Buffer.from(JSON.stringify({ s: sort, id: ids.rohanPune, k: 'A' })).toString(
        'base64url',
      );
      const page = await leads.searchLeads(ownerB.ctx, { sort, cursor: forged });
      expect(page.errors).toEqual({});
      const orgs = await migrator().lead.findMany({
        where: { id: { in: page.rows.map((r) => r.id) } },
        select: { orgId: true },
      });
      expect(orgs.every((o) => o.orgId === B.orgId)).toBe(true);
    }
  });

  it('a cursor from a manager’s page gives an executive nothing extra', async () => {
    const m = await leads.searchLeads(a.manager.ctx, {});
    const page = await leads.searchLeads(a.exec2.ctx, { cursor: m.nextCursor! });
    expect(page.rows.every((r) => r.id === ids.exec2Rohan)).toBe(true);
  });
});
