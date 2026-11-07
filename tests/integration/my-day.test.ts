// FR-101 My Day (Phase 3 slice 4): the signed-in member's own open follow-ups, overdue / due today
// / next 7 days in the org's time zone (FR-056's windows), ordered by priority, lead intent (Hot
// first), due time. Closed follow-ups, other people's and other orgs' work never appear; Won/Lost
// and reassignment change what appears; a lead that left the caller's scope is not disclosed.
// Follow-ups are inserted with exact due times by the schema owner. Synthetic data only.
import { beforeAll, describe, expect, it } from 'vitest';
import * as leads from '@/modules/leads';
import * as tasks from '@/modules/tasks';
import * as teams from '@/modules/teams';
import { migrator } from '../support/db';
import { actorIn, seedOrg, type Actor } from '../support/factory';

type Org = Awaited<ReturnType<typeof seedOrg>>;
type Role = 'owner' | 'admin' | 'manager' | 'exec1' | 'exec2' | 'hr';
let A: Org;
let B: Org;
const a = {} as Record<Role, Actor>;
let ownerB: Actor;

let seq = 0;
const phone = () => `90${String(60_000_000 + ++seq * 4_441 + (process.pid % 1000)).slice(-8)}`;
async function created(by: Actor, name: string, intent: string | null = null): Promise<string> {
  const r = await leads.createLead(by.ctx, { fullName: name, primaryPhone: phone() });
  if (r.status !== 'created') throw new Error('fixture lead');
  if (intent) await migrator().lead.update({ where: { id: r.leadId }, data: { intent } });
  return r.leadId;
}
async function followUp(
  org: Org,
  by: Actor,
  leadId: string,
  dueAt: Date,
  extra: { priority?: string; status?: 'DONE' | 'CANCELLED'; title?: string } = {},
): Promise<string> {
  const closed =
    extra.status === 'DONE'
      ? { status: 'DONE', completedAt: new Date() }
      : extra.status === 'CANCELLED'
        ? { status: 'CANCELLED', cancelledAt: new Date(), cancelReason: 'Synthetic' }
        : {};
  const t = await migrator().task.create({
    data: {
      orgId: org.orgId,
      leadId,
      assigneeUserId: by.user.id,
      createdBy: by.user.id,
      dueAt,
      priority: extra.priority ?? 'NORMAL',
      title: extra.title ?? null,
      ...closed,
    },
  });
  return t.id;
}
const idsOf = (day: tasks.MyDay) => ({
  overdue: day.overdue.map((t) => t.id),
  today: day.today.map((t) => t.id),
  upcoming: day.upcoming.map((t) => t.id),
});

const now = new Date();
let tomorrow: Date;
let end: Date;
const T = {} as Record<string, string>;

beforeAll(async () => {
  A = await seedOrg('DayA');
  B = await seedOrg('DayB');
  for (const k of ['owner', 'admin', 'manager', 'exec1', 'exec2', 'hr'] as const)
    a[k] = await actorIn(A.users[k], A.orgId);
  ownerB = await actorIn(B.users.owner, B.orgId);
  const west = (await teams.createTeam(a.owner.ctx, { name: 'West' })).id;
  await teams.addTeamMember(a.owner.ctx, {
    teamId: west,
    membershipId: A.membership.manager!,
    teamRole: 'LEAD',
  });
  await teams.addTeamMember(a.owner.ctx, {
    teamId: west,
    membershipId: A.membership.exec1!,
    teamRole: 'MEMBER',
  });

  tomorrow = (leads.followUpDueRange('today', 'Asia/Kolkata', now) as { lt: Date }).lt;
  end = (leads.followUpDueRange('next7', 'Asia/Kolkata', now) as { lt: Date }).lt;
  const laterToday = (min: number) =>
    new Date(now.getTime() + Math.min(min * 60_000, (tomorrow.getTime() - now.getTime()) / 2));
  const e1 = a.exec1;
  T.o1 = await followUp(
    A,
    e1,
    await created(e1, 'Day o1', 'HOT'),
    new Date(now.getTime() - 3_600_000),
  );
  T.o2 = await followUp(
    A,
    e1,
    await created(e1, 'Day o2'),
    new Date(now.getTime() - 3 * 3_600_000),
    {
      priority: 'URGENT',
    },
  );
  T.t1 = await followUp(A, e1, await created(e1, 'Day t1', 'WARM'), laterToday(30), {
    priority: 'HIGH',
  });
  T.t2 = await followUp(A, e1, await created(e1, 'Day t2', 'HOT'), laterToday(40));
  T.t3 = await followUp(A, e1, await created(e1, 'Day t3', 'COLD'), laterToday(20), {
    title: 'Synthetic: confirm budget',
  });
  T.u1 = await followUp(A, e1, await created(e1, 'Day u1'), tomorrow);
  T.u2 = await followUp(A, e1, await created(e1, 'Day u2'), new Date(end.getTime() - 60_000), {
    priority: 'LOW',
  });
  T.beyond = await followUp(A, e1, await created(e1, 'Day beyond'), end);
  T.done = await followUp(A, e1, await created(e1, 'Day done'), new Date(now.getTime() - 600_000), {
    status: 'DONE',
  });
  T.cancelled = await followUp(A, e1, await created(e1, 'Day cancelled'), laterToday(10), {
    status: 'CANCELLED',
  });
  // Someone else's follow-up on one of exec1's leads.
  T.admins = await followUp(A, a.admin, await created(e1, 'Day admins'), laterToday(15));
});

describe('My Day contents and order (FR-101)', () => {
  it("lists the member's own open follow-ups by section, in the documented order", async () => {
    const day = await tasks.myDay(a.exec1.ctx, now);
    expect(idsOf(day)).toEqual({
      overdue: [T.o2, T.o1], // Urgent before Normal (even though o1 is Hot and later)
      today: [T.t1, T.t2, T.t3], // High; then Normal Hot before Normal Cold
      upcoming: [T.u1, T.u2], // Normal at the next local midnight; then Low
    });
    expect(day.truncated).toBe(false);
    const t3 = day.today.find((t) => t.id === T.t3)!;
    expect(t3).toMatchObject({
      title: 'Synthetic: confirm budget',
      priority: 'NORMAL',
      lead: { fullName: 'Day t3', intent: 'COLD', stage: 'ASSIGNED', archived: false },
    });
  });

  it('leaves out closed follow-ups, ones beyond 7 days, and other people’s', async () => {
    const all = Object.values(idsOf(await tasks.myDay(a.exec1.ctx, now))).flat();
    for (const k of ['beyond', 'done', 'cancelled', 'admins']) expect(all).not.toContain(T[k]);
    expect(idsOf(await tasks.myDay(a.admin.ctx, now)).today).toEqual([T.admins]);
  });

  it('is empty for a member with no follow-ups, and other orgs see none of it', async () => {
    expect(idsOf(await tasks.myDay(a.exec2.ctx, now))).toEqual({
      overdue: [],
      today: [],
      upcoming: [],
    });
    const bLead = await created(ownerB, 'Day B');
    const bTask = await followUp(B, ownerB, bLead, new Date(now.getTime() + 60_000));
    expect(Object.values(idsOf(await tasks.myDay(ownerB.ctx, now))).flat()).toEqual([bTask]);
    expect(Object.values(idsOf(await tasks.myDay(a.owner.ctx, now))).flat()).not.toContain(bTask);
  });

  it('shows HR only their own tasks: none of the sales follow-ups (ADR-0015)', async () => {
    const day = await tasks.myDay(a.hr.ctx, now);
    expect([...day.overdue, ...day.today, ...day.upcoming, ...day.later]).toEqual([]);
  });
});

describe('lifecycle and scope', () => {
  it('drops a follow-up when its lead is lost', async () => {
    const l = await created(a.exec1, 'Day lost');
    const t = await followUp(A, a.exec1, l, new Date(now.getTime() - 60_000));
    expect(idsOf(await tasks.myDay(a.exec1.ctx, now)).overdue).toContain(t);
    await leads.changeStage(a.exec1.ctx, l, {
      toStage: 'LOST',
      version: String((await migrator().lead.findUniqueOrThrow({ where: { id: l } })).version),
      reasonCode: 'NOT_INTERESTED',
    });
    expect(idsOf(await tasks.myDay(a.exec1.ctx, now)).overdue).not.toContain(t);
  });

  it("moves to the new owner's My Day when the lead is reassigned", async () => {
    const l = await created(a.exec1, 'Day moved');
    const t = await followUp(A, a.exec1, l, tomorrow);
    await leads.assignLead(a.admin.ctx, l, {
      target: `user:${A.users.exec2.id}`,
      version: (await migrator().lead.findUniqueOrThrow({ where: { id: l } })).version,
      reason: 'Synthetic: rebalancing',
    });
    expect(idsOf(await tasks.myDay(a.exec1.ctx, now)).upcoming).not.toContain(t);
    expect(idsOf(await tasks.myDay(a.exec2.ctx, now)).upcoming).toContain(t);
  });

  it('keeps an own follow-up whose lead left the caller’s scope, without disclosing the lead', async () => {
    const l = await created(a.exec1, 'Day out of scope'); // team West: the manager can see it
    const t = await followUp(A, a.manager, l, tomorrow);
    expect(
      (await tasks.myDay(a.manager.ctx, now)).upcoming.find((i) => i.id === t)?.lead,
    ).toMatchObject({ fullName: 'Day out of scope' });
    await leads.assignLead(a.admin.ctx, l, {
      target: `user:${A.users.exec2.id}`, // exec2 is not in West
      version: (await migrator().lead.findUniqueOrThrow({ where: { id: l } })).version,
      reason: 'Synthetic: out of the team',
    });
    const item = (await tasks.myDay(a.manager.ctx, now)).upcoming.find((i) => i.id === t);
    expect(item).toBeDefined();
    expect(item!.lead).toBeNull();
  });

  it('marks follow-ups on archived leads', async () => {
    const l = await created(a.exec1, 'Day archived');
    const t = await followUp(A, a.exec1, l, tomorrow);
    await leads.archiveLead(a.admin.ctx, l, {
      version: (await migrator().lead.findUniqueOrThrow({ where: { id: l } })).version,
    });
    const item = (await tasks.myDay(a.exec1.ctx, now)).upcoming.find((i) => i.id === t);
    expect(item?.lead).toMatchObject({ archived: true });
  });
});

describe('time zone', () => {
  it("uses the org's time zone for today and the 7-day window", async () => {
    await migrator().organization.update({
      where: { id: B.orgId },
      data: { timeZone: 'America/New_York' },
    });
    const nyTomorrow = (leads.followUpDueRange('today', 'America/New_York', now) as { lt: Date })
      .lt;
    const nyEnd = (leads.followUpDueRange('next7', 'America/New_York', now) as { lt: Date }).lt;
    const before = await followUp(
      B,
      ownerB,
      await created(ownerB, 'NY today'),
      new Date(nyTomorrow.getTime() - 60_000),
    );
    const at = await followUp(B, ownerB, await created(ownerB, 'NY tomorrow'), nyTomorrow);
    const last = await followUp(B, ownerB, await created(ownerB, 'NY last'), nyEnd);
    const day = idsOf(await tasks.myDay(ownerB.ctx, now));
    expect(day.today).toContain(before);
    expect(day.upcoming).toContain(at);
    expect([...day.today, ...day.upcoming, ...day.overdue]).not.toContain(last);
  });
});
