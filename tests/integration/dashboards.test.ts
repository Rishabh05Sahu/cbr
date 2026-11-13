// FR-130–133 dashboards (ADR-0023): report.read scopes (Owner/Admin organisation, Manager teams
// led, Executive own, HR none, other orgs isolated), filters refused outside scope, period
// boundaries in the org's time zone, exclusions (test, deleted, merged-away leads), activity vs
// cohort lenses, Invalid-number leads outside conversion denominators, low sample, unavailable
// KPIs, task / interaction / site-visit KPIs, and tile = drill-down count equality for every
// definition. Synthetic data only. Each test isolates its records with its own lead source.
import { randomUUID } from 'node:crypto';
import { beforeAll, describe, expect, it } from 'vitest';
import * as interactions from '@/modules/interactions';
import * as leads from '@/modules/leads';
import * as reporting from '@/modules/reporting';
import { BUILDERS } from '@/modules/reporting/queries';
import * as tasks from '@/modules/tasks';
import * as teams from '@/modules/teams';
import * as visits from '@/modules/visits';
import { DomainError } from '@/platform/errors';
import { migrator } from '../support/db';
import { actorIn, seedOrg, type Actor } from '../support/factory';

type Org = Awaited<ReturnType<typeof seedOrg>>;
type Role = 'owner' | 'admin' | 'manager' | 'exec1' | 'exec2' | 'hr';

async function codeOf(p: Promise<unknown>): Promise<string> {
  try {
    await p;
    return 'OK';
  } catch (e) {
    if (e instanceof DomainError) return e.code;
    throw e;
  }
}

const DAY = 86_400_000;
/** The org-local (India) day key `days` from now. */
const dayKey = (days = 0) =>
  new Date(Date.now() + days * DAY + 330 * 60_000).toISOString().slice(0, 10);
/** A datetime-local value `minutes` from now in India time. */
const local = (minutes: number) =>
  new Date(Date.now() + minutes * 60_000 + 330 * 60_000).toISOString().slice(0, 16);
const around = (back = 2, ahead = 1) => ({
  period: 'custom',
  from: dayKey(-back),
  to: dayKey(ahead),
});

let seq = 0;
const phone = () => `97${String(10_000_000 + ++seq * 7_919 + (process.pid % 1000)).slice(-8)}`;
const QUALIFIABLE = {
  transactionType: 'BUY',
  propertyType: 'APARTMENT',
  preferredCity: 'Pune',
  budgetMax: '1 Cr',
};

async function lead(by: Actor, sourceId: string): Promise<string> {
  const r = await leads.createLead(by.ctx, {
    fullName: 'Synthetic Report Lead',
    primaryPhone: phone(),
    ...QUALIFIABLE,
  });
  if (r.status !== 'created') throw new Error('fixture lead');
  // The test's own source on the lead (first touch) and its enquiry.
  await migrator()
    .$executeRaw`UPDATE lead SET source_id = ${sourceId}::uuid WHERE id = ${r.leadId}::uuid`;
  await migrator()
    .$executeRaw`UPDATE lead_enquiry SET source_id = ${sourceId}::uuid WHERE lead_id = ${r.leadId}::uuid`;
  return r.leadId;
}
async function source(org: Org) {
  return (
    await migrator().leadSource.create({
      data: { orgId: org.orgId, name: `Synthetic source ${randomUUID().slice(0, 8)}` },
    })
  ).id;
}
const version = async (id: string) =>
  (await migrator().lead.findUniqueOrThrow({ where: { id } })).version;
async function call(by: Actor, leadId: string, outcome: string) {
  return interactions.logInteraction(by.ctx, {
    leadId,
    idempotencyKey: randomUUID(),
    version: await version(leadId),
    channel: 'PHONE_NATIVE',
    direction: 'OUTBOUND',
    outcome,
    occurredAt: local(-5),
  });
}
async function tile(by: Actor, id: string, raw: reporting.RawFilters) {
  const d = await reporting.dashboard(by.ctx, raw);
  return [...d.kpis, ...d.operational].find((t) => t.id === id) ?? null;
}

async function setup(name: string) {
  const org = await seedOrg(name);
  const a = {} as Record<Role, Actor>;
  for (const k of ['owner', 'admin', 'manager', 'exec1', 'exec2', 'hr'] as const)
    a[k] = await actorIn(org.users[k], org.orgId);
  const west = (await teams.createTeam(a.owner.ctx, { name: 'West' })).id;
  await teams.addTeamMember(a.owner.ctx, {
    teamId: west,
    membershipId: org.membership.manager!,
    teamRole: 'LEAD',
  });
  await teams.addTeamMember(a.owner.ctx, {
    teamId: west,
    membershipId: org.membership.exec1!,
    teamRole: 'MEMBER',
  });
  // Members since yesterday, so calls logged a few minutes back fall inside their membership.
  await migrator()
    .$executeRaw`UPDATE team_membership SET started_at = now() - interval '1 day' WHERE team_id = ${west}::uuid`;
  return { org, a, west };
}
let A: Awaited<ReturnType<typeof setup>>;
let B: Awaited<ReturnType<typeof setup>>;
beforeAll(async () => {
  A = await setup('ReportA');
  B = await setup('ReportB');
});

describe('report.read scopes', () => {
  it('Owner and Admin see the organisation, the Manager their team, an Executive themselves', async () => {
    const { a, org } = A;
    const s = await source(org);
    const e1 = await lead(a.exec1, s);
    const e2 = await lead(a.exec2, s);
    await call(a.exec1, e1, 'CONNECTED_INTERESTED');
    await call(a.exec1, e1, 'NO_ANSWER');
    await call(a.exec2, e2, 'CONNECTED_CALL_BACK');
    const f = { ...around(), source: s };
    const k05 = async (by: Actor, extra: reporting.RawFilters = {}) =>
      (await tile(by, 'k05', { ...f, ...extra }))!.count;
    expect(await k05(a.owner)).toBe(3);
    expect(await k05(a.admin)).toBe(3);
    expect(await k05(a.manager)).toBe(2);
    expect(await k05(a.exec1)).toBe(2);
    expect(await k05(a.exec2)).toBe(1);
    expect((await tile(a.owner, 'k07', f))!.count).toBe(2);
    expect((await tile(a.manager, 'k07', f))!.count).toBe(1);
    // Filters: team at the time, person.
    expect(await k05(a.owner, { team: A.west })).toBe(2);
    expect(await k05(a.owner, { user: org.users.exec2.id })).toBe(1);
    expect(await k05(a.manager, { user: org.users.exec1.id })).toBe(2);
    // K08 self-reported: 1 of 2, low sample (and hidden on the tile, K08's own rule).
    expect((await tile(a.exec1, 'k08', f))!.ratio).toMatchObject({
      numerator: 1,
      denominator: 2,
      lowSample: true,
    });
    const d = await reporting.dashboard(a.exec1.ctx, f);
    expect(d.scope).toBe('OWN');
    expect(d.members).toBeNull();
    expect(d.kpis.some((t) => t.id === 'k03')).toBe(false);
    expect((await reporting.dashboard(a.manager.ctx, f)).scope).toBe('TEAM');
    expect((await reporting.dashboard(a.owner.ctx, f)).scope).toBe('ORG');
  });

  it('drill-downs refuse a person outside the scope, and an unknown person the same way', async () => {
    const { a, org } = A;
    const s = await source(org);
    await call(a.exec1, await lead(a.exec1, s), 'NO_ANSWER');
    await call(a.exec2, await lead(a.exec2, s), 'NO_ANSWER');
    const f = { ...around(), source: s };
    const unknown = randomUUID();
    for (const by of [a.manager, a.exec1])
      for (const user of [org.users.exec2.id, unknown]) {
        expect(await codeOf(reporting.dashboard(by.ctx, { ...f, user }))).toBe('FORBIDDEN');
        for (const id of ['k05', 'k01-new', 'open-by-stage'])
          expect(await codeOf(reporting.drillDown(by.ctx, id, { ...f, user })), id).toBe(
            'FORBIDDEN',
          );
      }
    expect(
      await codeOf(reporting.drillDown(a.exec1.ctx, 'k05', { ...f, user: org.users.manager.id })),
    ).toBe('FORBIDDEN');
    // In-scope filters still work, and only the filtered person's records come back.
    const mine = await reporting.drillDown(a.manager.ctx, 'k05', {
      ...f,
      user: org.users.exec1.id,
    });
    expect(mine.tile.count).toBe(1);
    expect(mine.rows.map((r) => r.userName)).toEqual([org.users.exec1.name]);
    const own = await reporting.drillDown(a.exec1.ctx, 'k05', { ...f, user: org.users.exec1.id });
    expect(own.tile.count).toBe(1);
    // Another organisation's person is refused too.
    expect(
      await codeOf(reporting.drillDown(a.manager.ctx, 'k05', { ...f, user: B.org.users.exec1.id })),
    ).toBe('FORBIDDEN');
  });

  it('malformed and missing filters are told apart from refusals and from an unknown report', async () => {
    const { a, org } = A;
    const s = await source(org);
    await call(a.exec1, await lead(a.exec1, s), 'NO_ANSWER');
    const otherOrgSource = await source(B.org);
    const errorOf = async (p: Promise<unknown>) => {
      try {
        await p;
        return null;
      } catch (e) {
        if (!(e instanceof DomainError)) throw e;
        return { code: e.code, fields: Object.keys(e.fieldErrors ?? {}) };
      }
    };
    for (const by of [a.manager, a.exec1])
      for (const run of [
        (f: reporting.RawFilters) => reporting.dashboard(by.ctx, f),
        (f: reporting.RawFilters) => reporting.drillDown(by.ctx, 'k05', f),
      ]) {
        // Malformed: VALIDATION_FAILED naming the filter.
        expect(await errorOf(run({ user: 'abc' }))).toEqual({
          code: 'VALIDATION_FAILED',
          fields: ['user'],
        });
        expect(await errorOf(run({ team: 'abc' }))).toEqual({
          code: 'VALIDATION_FAILED',
          fields: ['team'],
        });
        expect(await errorOf(run({ source: 'abc' }))).toEqual({
          code: 'VALIDATION_FAILED',
          fields: ['source'],
        });
        expect(await errorOf(run({ user: 'x'.repeat(41) }))).toEqual({
          code: 'VALIDATION_FAILED',
          fields: ['user'],
        });
        // Missing source (unknown, or another organisation's): NOT_FOUND naming the filter.
        for (const source of [randomUUID(), otherOrgSource])
          expect(await errorOf(run({ source }))).toEqual({ code: 'NOT_FOUND', fields: ['source'] });
        // Unknown team: refused like one outside the scope (no existence signal).
        expect(await errorOf(run({ team: randomUUID() }))).toEqual({
          code: 'FORBIDDEN',
          fields: [],
        });
        // A valid source still filters.
        expect(await errorOf(run({ ...around(), source: s }))).toBeNull();
      }
    expect(await errorOf(reporting.drillDown(a.exec1.ctx, 'k99', { source: 'abc' }))).toEqual({
      code: 'NOT_FOUND',
      fields: [],
    });
    expect((await tile(a.exec1, 'k05', { ...around(), source: s }))!.count).toBe(1);
  });

  it('a lead reassigned out of scope leaves that dashboard; its history stays credited', async () => {
    const { a, org } = A;
    const s = await source(org);
    const id = await lead(a.exec1, s);
    await call(a.exec1, id, 'CONNECTED_INTERESTED');
    await call(a.exec1, id, 'NO_ANSWER');
    const f = { ...around(), source: s };
    const k05 = async (by: Actor, extra: reporting.RawFilters = {}) =>
      (await reporting.drillDown(by.ctx, 'k05', { ...f, ...extra })).tile.count;
    expect(await k05(a.exec1)).toBe(2);
    expect(await k05(a.manager)).toBe(2);
    // Reassigned to exec2, outside exec1's ownership and the West team.
    await leads.assignLead(a.owner.ctx, id, {
      target: `user:${org.users.exec2.id}`,
      version: await version(id),
      reason: 'synthetic reassignment',
    });
    const mine = await reporting.drillDown(a.exec1.ctx, 'k05', f);
    expect(mine.tile.count).toBe(0);
    expect(mine.rows).toEqual([]);
    expect(await k05(a.manager)).toBe(0);
    // exec2 can open the lead now, but the calls stay credited to exec1, who is outside OWN.
    expect(await k05(a.exec2)).toBe(0);
    // The organisation view still credits exec1; the interaction records are unchanged.
    expect(await k05(a.owner, { user: org.users.exec1.id })).toBe(2);
    expect(await migrator().interaction.count({ where: { leadId: id } })).toBe(2);
  });

  it('refuses HR, filters outside the scope, and other organisations', async () => {
    const { a, org } = A;
    expect(await codeOf(reporting.dashboard(a.hr.ctx, {}))).toBe('FORBIDDEN');
    expect(await codeOf(reporting.drillDown(a.hr.ctx, 'k05', {}))).toBe('FORBIDDEN');
    expect(await codeOf(reporting.dashboard(a.manager.ctx, { user: org.users.exec2.id }))).toBe(
      'FORBIDDEN',
    );
    expect(await codeOf(reporting.dashboard(a.exec1.ctx, { team: A.west }))).toBe('FORBIDDEN');
    expect(await codeOf(reporting.dashboard(a.exec1.ctx, { user: org.users.exec2.id }))).toBe(
      'FORBIDDEN',
    );
    expect(await codeOf(reporting.dashboard(a.exec1.ctx, { user: 'not-a-uuid' }))).toBe(
      'VALIDATION_FAILED',
    );
    expect(await codeOf(reporting.drillDown(a.exec1.ctx, 'k03', {}))).toBe('NOT_FOUND');
    expect(await codeOf(reporting.drillDown(a.owner.ctx, 'k99', {}))).toBe('NOT_FOUND');
    // Org B: A's team, people and sources do not exist there; A's records never appear.
    const sA = await source(org);
    await call(a.exec1, await lead(a.exec1, sA), 'NO_ANSWER');
    expect(await codeOf(reporting.dashboard(B.a.owner.ctx, { team: A.west }))).toBe('FORBIDDEN');
    expect(await codeOf(reporting.dashboard(B.a.owner.ctx, { user: org.users.exec1.id }))).toBe(
      'FORBIDDEN',
    );
    expect(await codeOf(reporting.dashboard(B.a.owner.ctx, { source: sA }))).toBe('NOT_FOUND');
    const drill = await reporting.drillDown(B.a.owner.ctx, 'k05', around());
    expect(drill.tile.count).toBe(0);
    expect(drill.rows).toEqual([]);
  });
});

describe('periods, exclusions and lenses', () => {
  it('counts days in the org time zone (23:59 vs 00:01 IST)', async () => {
    const { a, org } = A;
    const s = await source(org);
    const before = await lead(a.exec1, s);
    const after = await lead(a.exec1, s);
    await migrator()
      .$executeRaw`UPDATE lead SET created_at = '2026-10-29T18:29:00Z' WHERE id = ${before}::uuid`;
    await migrator()
      .$executeRaw`UPDATE lead SET created_at = '2026-10-29T18:31:00Z' WHERE id = ${after}::uuid`;
    const day = { period: 'custom', from: '2026-10-30', to: '2026-10-30', source: s };
    const drill = await reporting.drillDown(a.owner.ctx, 'k01-new', day);
    expect(drill.tile.count).toBe(1);
    expect(drill.rows.map((r) => r.leadId)).toEqual([after]);
    const prev = await reporting.drillDown(a.owner.ctx, 'k01-new', {
      ...day,
      from: '2026-10-29',
      to: '2026-10-29',
    });
    expect(prev.rows.map((r) => r.leadId)).toEqual([before]);
  });

  it('excludes test, deleted and merged-away leads; a merged lead counts on the survivor', async () => {
    const { a, org } = A;
    const s = await source(org);
    const [kept, test, gone, merged] = [
      await lead(a.exec1, s),
      await lead(a.exec1, s),
      await lead(a.exec1, s),
      await lead(a.exec1, s),
    ];
    await migrator().$executeRaw`UPDATE lead SET is_test = TRUE WHERE id = ${test}::uuid`;
    await migrator().$executeRaw`UPDATE lead SET deleted_at = now() WHERE id = ${gone}::uuid`;
    await migrator()
      .$executeRaw`UPDATE lead SET merged_into_lead_id = ${kept}::uuid WHERE id = ${merged}::uuid`;
    const f = { ...around(), source: s };
    expect((await tile(a.owner, 'k01-new', f))!.count).toBe(1);
    // K01 counts enquiries: the merged-away lead's enquiry counts once, on the surviving lead.
    const k01 = await reporting.drillDown(a.owner.ctx, 'k01', f);
    expect(k01.tile.count).toBe(2);
    expect(new Set(k01.rows.map((r) => r.leadId))).toEqual(new Set([kept]));
    expect((await tile(a.exec1, 'k01-new', f))!.count).toBe(1);
  });

  it('cohorts: matured entries only, Invalid numbers outside the ratio, separate from activity', async () => {
    const { a, org } = A;
    const s = await source(org);
    const ids = [] as string[];
    for (let i = 0; i < 5; i++) ids.push(await lead(a.exec1, s));
    const [hit, late, never, invalid, recent] = ids as [string, string, string, string, string];
    await leads.changeContactStatus(a.exec1.ctx, invalid, {
      toStatus: 'INVALID',
      version: await version(invalid),
      reason: 'Synthetic: number does not exist',
    });
    const back = (d: number) => new Date(Date.now() - d * DAY);
    for (const id of [hit, late, never, invalid]) {
      await migrator().$executeRaw`UPDATE lead SET created_at = ${back(40)} WHERE id = ${id}::uuid`;
      await migrator()
        .$executeRaw`UPDATE lead_assignment_history SET started_at = ${back(40)} WHERE lead_id = ${id}::uuid`;
    }
    await migrator()
      .$executeRaw`UPDATE lead SET created_at = ${back(5)} WHERE id = ${recent}::uuid`;
    await migrator()
      .$executeRaw`UPDATE lead_assignment_history SET started_at = ${back(5)} WHERE lead_id = ${recent}::uuid`;
    await migrator()
      .$executeRaw`UPDATE lead SET first_visit_completed_at = ${back(30)} WHERE id = ${hit}::uuid`;
    await migrator()
      .$executeRaw`UPDATE lead SET first_visit_completed_at = ${back(4)} WHERE id = ${late}::uuid`;
    await migrator()
      .$executeRaw`UPDATE lead SET first_visit_completed_at = ${back(30)} WHERE id = ${invalid}::uuid`;
    const f = { period: 'custom', from: dayKey(-45), to: dayKey(0), source: s };
    const want = { numerator: 1, denominator: 3, inProgress: 1, invalid: 1, lowSample: true };
    // Organisation view (lead creation) and the executive's own spells give the same cohort here.
    expect((await tile(a.owner, 'k13', f))!.ratio).toMatchObject(want);
    expect((await tile(a.exec1, 'k13', f))!.ratio).toMatchObject(want);
    expect((await tile(a.manager, 'k13', f))!.ratio).toMatchObject(want);
    expect((await tile(a.exec2, 'k13', f))!.ratio).toMatchObject({ numerator: 0, denominator: 0 });
    // Activity lens: no site visit was attended in the period, whatever the milestones say.
    expect((await tile(a.owner, 'k12', f))!.count).toBe(0);
    const drill = await reporting.drillDown(a.owner.ctx, 'k13', f);
    expect(drill.rows.find((r) => r.leadId === recent)!.bucket).toBe('in_progress');
    expect(drill.rows.find((r) => r.leadId === invalid)!.bucket).toBe('invalid');
    expect(drill.rows.find((r) => r.leadId === hit)!.num).toBe(true);
    expect(drill.rows.find((r) => r.leadId === late)!.num).toBe(false);
  });

  it('shows unavailable KPIs as "—" with the reason, never as zero', async () => {
    const d = await reporting.dashboard(A.a.owner.ctx, around());
    for (const id of [
      'k06',
      'k07-provider',
      'k08-provider',
      'k09b',
      'k12b',
      'k19',
    ]) {
      const t = d.kpis.find((k) => k.id === id)!;
      expect(t.unavailable, id).toBeTruthy();
      expect(t.count, id).toBeNull();
      expect(t.ratio, id).toBeNull();
    }
    const drill = await reporting.drillDown(A.a.owner.ctx, 'k19', {});
    expect(drill.rows).toEqual([]);
    expect(drill.tile.unavailable).toMatch(/leave/);
  });
});

describe('tasks and site visits', () => {
  it('K18 follow-ups due, K19b timeliness, K20 completion without "No longer relevant"', async () => {
    const { a, org } = A;
    const s = await source(org);
    const [l1, l2, l3] = [await lead(a.exec1, s), await lead(a.exec1, s), await lead(a.exec1, s)];
    const fu = async (l: string) =>
      (await tasks.createTask(a.exec1.ctx, l, { type: 'FOLLOW_UP', title: '', dueAt: local(60) }))
        .id;
    const done = await fu(l1);
    const dropped = await fu(l2);
    await fu(l3);
    await tasks.completeFollowUp(a.exec1.ctx, done, { version: 1 });
    await tasks.cancelFollowUp(a.exec1.ctx, dropped, { version: 1, reason: 'No longer relevant' });
    const f = { ...around(1, 2), source: s };
    expect((await tile(a.exec1, 'k18', f))!.count).toBe(2);
    expect((await tile(a.exec1, 'k19b', f))!.ratio).toMatchObject({ numerator: 1, denominator: 2 });
    expect((await tile(a.exec1, 'k20', f))!.ratio).toMatchObject({ numerator: 1, denominator: 2 });
    expect((await tile(a.manager, 'k18', f))!.count).toBe(2);
    expect((await tile(a.exec2, 'k18', f))!.count).toBe(0);
  });

  it('K11 credits who scheduled, K12 the assigned salesperson; upcoming visits by scope', async () => {
    const { a, org } = A;
    const s = await source(org);
    const l = await lead(a.exec1, s);
    await visits.scheduleVisit(a.exec1.ctx, l, {
      scheduledFor: local(24 * 60),
      location: 'Synthetic office',
    });
    const past = await migrator().siteVisit.create({
      data: {
        orgId: org.orgId,
        leadId: l,
        assignedUserId: org.users.exec1.id,
        scheduledBy: org.users.manager.id,
        scheduledFor: new Date(Date.now() - 30 * 60_000),
        locationText: 'Synthetic office',
      },
    });
    await visits.updateVisit(a.exec1.ctx, past.id, {
      action: 'attended',
      version: '1',
      interestLevel: 'HIGH',
      nextAction: 'Synthetic: send brochure',
    });
    const f = { ...around(), source: s };
    expect((await tile(a.owner, 'k11', f))!.count).toBe(2);
    expect((await tile(a.exec1, 'k11', f))!.count).toBe(1);
    expect((await tile(a.manager, 'k11', { ...f, user: org.users.manager.id }))!.count).toBe(1);
    expect((await tile(a.exec1, 'k12', f))!.count).toBe(1);
    expect((await tile(a.manager, 'visits-upcoming', f))!.count).toBe(1);
    expect(
      (await tile(a.owner, 'visits-upcoming', { ...f, user: org.users.exec2.id }))!.count,
    ).toBe(0);
  });
});

describe('FR-133 drill-down count equality', () => {
  it('every definition: the tile count equals the drill-down rows, per role, filter and view', async () => {
    const { a, org } = A;
    const ids = Object.keys(BUILDERS);
    const base = { period: 'custom', from: dayKey(-45), to: dayKey(2) };
    const cases: [Actor, Record<string, string>][] = [
      [a.owner, {}],
      [a.admin, { team: A.west }],
      [a.owner, { user: org.users.exec1.id }],
      [a.owner, { member: '1' }],
      [a.manager, {}],
      [a.manager, { member: '1' }],
      [a.manager, { team: A.west, user: org.users.exec1.id }],
      [a.exec1, {}],
      [a.exec2, {}],
      [B.a.owner, {}],
    ];
    let checked = 0;
    for (const [by, extra] of cases)
      for (const id of ids) {
        if (id === 'k03' && by === a.exec1) continue;
        if (id === 'k03' && by === a.exec2) continue;
        const r = await reporting.countPair(by.ctx, id, { ...base, ...extra });
        expect(r.listed, `${id} ${JSON.stringify(extra)}`).toBe(r.tile);
        expect(r.listedHits, `${id} hits`).toBe(r.tileHits);
        checked++;
      }
    // Per-stage drill-downs add up to the open-leads total.
    const stages = (await reporting.dashboard(a.manager.ctx, base)).stages;
    const all = await reporting.countPair(a.manager.ctx, 'open-by-stage', base);
    expect(stages.reduce((n, s) => n + s.count, 0)).toBe(all.tile);
    for (const st of stages)
      expect(
        (await reporting.countPair(a.manager.ctx, 'open-by-stage', { ...base, stage: st.stage }))
          .listed,
      ).toBe(st.count);
    // Per-member table cells equal their drill-downs.
    const d = await reporting.dashboard(a.owner.ctx, base);
    for (const m of d.members!)
      for (const id of reporting.MEMBER_COUNTS)
        expect(
          (await reporting.countPair(a.owner.ctx, id, { ...base, user: m.userId, member: '1' }))
            .listed,
          `${id} ${m.name}`,
        ).toBe(m.counts[id] ?? 0);
    expect(checked).toBeGreaterThan(150);
  });
});

describe('K04 / K05 split / K08b: Call and WhatsApp taps (FR-080/081, ADR-0025)', () => {
  const tap = (by: Actor, leadId: string, channel: 'PHONE_NATIVE' | 'WHATSAPP_APP') =>
    interactions.recordCallIntent(by.ctx, { leadId, channel });
  async function message(by: Actor, leadId: string) {
    return interactions.logInteraction(by.ctx, {
      leadId,
      idempotencyKey: randomUUID(),
      version: await version(leadId),
      channel: 'WHATSAPP_APP_MESSAGE',
      direction: 'OUTBOUND',
      outcome: 'MESSAGE_SENT',
      occurredAt: local(0),
    });
  }

  it('counts taps per person and channel, in scope, and the logging rate', async () => {
    const { a, org, west } = A;
    const s = await source(org);
    const e1 = await lead(a.exec1, s);
    const e2 = await lead(a.exec2, s);
    // exec1: 3 Call taps and 2 WhatsApp taps; logs one call and one WhatsApp message afterwards.
    for (let i = 0; i < 3; i++) await tap(a.exec1, e1, 'PHONE_NATIVE');
    for (let i = 0; i < 2; i++) await tap(a.exec1, e1, 'WHATSAPP_APP');
    await call(a.exec1, e1, 'NO_ANSWER');
    await message(a.exec1, e1);
    // exec2 (no team): 1 Call tap, nothing logged.
    await tap(a.exec2, e2, 'PHONE_NATIVE');
    const f = { ...around(), source: s };
    const count = async (by: Actor, id: string, extra: reporting.RawFilters = {}) =>
      (await tile(by, id, { ...f, ...extra }))!.count;

    expect(await count(a.owner, 'k04')).toBe(4);
    expect(await count(a.owner, 'k04-whatsapp')).toBe(2);
    expect(await count(a.owner, 'k04', { user: org.users.exec1.id })).toBe(3);
    expect(await count(a.owner, 'k04', { team: west })).toBe(3);
    // Manager: their team (exec1) only; Executives: themselves.
    expect(await count(a.manager, 'k04')).toBe(3);
    expect(await count(a.exec1, 'k04')).toBe(3);
    expect(await count(a.exec2, 'k04')).toBe(1);
    expect(await count(a.exec2, 'k04-whatsapp')).toBe(0);
    // Logged contacts by channel: a tap is never a logged call.
    expect(await count(a.owner, 'k05-phone')).toBe(1);
    expect(await count(a.owner, 'k05-whatsapp')).toBe(1);
    expect(await count(a.owner, 'k05')).toBe(1);
    // K08b: exec1's 5 taps were each followed by a logged interaction within 2 h; exec2's was not.
    const k08b = (await tile(a.owner, 'k08b', f))!.ratio!;
    expect([k08b.numerator, k08b.denominator]).toEqual([5, 6]);
    expect((await tile(a.exec2, 'k08b', f))!.ratio).toMatchObject({ numerator: 0, denominator: 1 });

    // The per-member table shows the same figures, and every cell equals its drill-down.
    const d = await reporting.dashboard(a.owner.ctx, f);
    const row = (id: string) => d.members!.find((m) => m.userId === id)!;
    expect(row(org.users.exec1.id).counts).toMatchObject({
      k04: 3,
      'k04-whatsapp': 2,
      'k05-phone': 1,
      'k05-whatsapp': 1,
    });
    expect(row(org.users.exec1.id).ratios.k08b).toMatchObject({ numerator: 5, denominator: 5 });
    expect(row(org.users.exec2.id).counts.k04).toBe(1);
    for (const id of ['k04', 'k04-whatsapp', 'k05-phone', 'k05-whatsapp', 'k08b']) {
      const p = await reporting.countPair(a.owner.ctx, id, f);
      expect([p.listed, p.listedHits], id).toEqual([p.tile, p.tileHits]);
    }
    const drill = await reporting.drillDown(a.owner.ctx, 'k04-whatsapp', f);
    expect(drill.rows.map((r) => [r.leadId, r.extra])).toEqual([
      [e1, 'WHATSAPP_BUTTON'],
      [e1, 'WHATSAPP_BUTTON'],
    ]);
  });

  it('HR sees no taps, and another org never sees them', async () => {
    const { a, org } = A;
    const s = await source(org);
    const e1 = await lead(a.exec1, s);
    await tap(a.exec1, e1, 'PHONE_NATIVE');
    const f = { ...around(), source: s };
    expect(await codeOf(reporting.dashboard(a.hr.ctx, f))).not.toBe('OK');
    expect((await tile(B.a.owner, 'k04', around()))!.count).toBe(0);
  });
});
