// FR-105 calendar (ADR-0018): the signed-in member's own OPEN tasks and the OPEN meetings they are
// invited to, by org-local day. Date boundaries (India time; the week of Mon 8 – Sun 14 March 2027),
// a meeting running across the first midnight, closed tasks, other people's and other orgs' tasks,
// private no-lead tasks, invited meetings without lead access, reassignment and Won/Lost, HR, and
// the overlap flag. Tasks are inserted with exact times by the schema owner. Synthetic data only.
import { beforeAll, describe, expect, it } from 'vitest';
import * as leads from '@/modules/leads';
import * as tasks from '@/modules/tasks';
import { migrator } from '../support/db';
import { actorIn, seedOrg, type Actor } from '../support/factory';

type Org = Awaited<ReturnType<typeof seedOrg>>;
type Role = 'owner' | 'admin' | 'manager' | 'exec1' | 'exec2' | 'hr';

/** An instant given as India wall-clock time. */
const ist = (wall: string) => new Date(`${wall}:00+05:30`);

let seq = 0;
const phone = () => `96${String(10_000_000 + ++seq * 7_717 + (process.pid % 1000)).slice(-8)}`;
async function created(by: Actor): Promise<string> {
  const r = await leads.createLead(by.ctx, {
    fullName: 'Synthetic Calendar Lead',
    primaryPhone: phone(),
  });
  if (r.status !== 'created') throw new Error('fixture lead');
  return r.leadId;
}
async function task(
  org: Org,
  who: Actor,
  dueAt: Date,
  extra: {
    type?: string;
    endAt?: Date;
    leadId?: string;
    status?: 'DONE' | 'CANCELLED';
    title?: string;
  } = {},
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
      type: extra.type ?? 'OTHER',
      title: extra.title ?? `Synthetic ${++seq}`,
      assigneeUserId: who.user.id,
      createdBy: who.user.id,
      dueAt,
      leadId: extra.leadId ?? null,
      endAt: extra.endAt ?? null,
      ...closed,
    },
  });
  return t.id;
}
const invite = (org: Org, taskId: string, who: Actor, by: Actor) =>
  migrator().taskAttendee.create({
    data: { orgId: org.orgId, taskId, userId: who.user.id, addedBy: by.user.id },
  });
const WEEK = { view: 'week', date: '2027-03-10' };
const idsIn = (cal: tasks.Calendar) =>
  Object.values(cal.byDay)
    .flat()
    .map((t) => t.id);
const dayOf = (cal: tasks.Calendar, id: string) =>
  Object.entries(cal.byDay).find(([, l]) => l.some((t) => t.id === id))?.[0];

let A: Org;
let B: Org;
const a = {} as Record<Role, Actor>;
let ownerB: Actor;
beforeAll(async () => {
  A = await seedOrg('CalA');
  B = await seedOrg('CalB');
  for (const k of ['owner', 'admin', 'manager', 'exec1', 'exec2', 'hr'] as const)
    a[k] = await actorIn(A.users[k], A.orgId);
  ownerB = await actorIn(B.users.owner, B.orgId);
});

describe('periods and boundaries (org-local days)', () => {
  it('a week is Monday 00:00 to the next Monday 00:00, India time', async () => {
    const first = await task(A, a.exec1, ist('2027-03-08T00:00'));
    const last = await task(A, a.exec1, ist('2027-03-14T23:59'));
    const before = await task(A, a.exec1, ist('2027-03-07T23:59'));
    const after = await task(A, a.exec1, ist('2027-03-15T00:00'));
    const cal = await tasks.calendar(a.exec1.ctx, WEEK);
    expect(cal.period.days[0]).toBe('2027-03-08');
    expect(cal.period.days[6]).toBe('2027-03-14');
    expect(dayOf(cal, first)).toBe('2027-03-08');
    expect(dayOf(cal, last)).toBe('2027-03-14');
    expect(idsIn(cal)).not.toContain(before);
    expect(idsIn(cal)).not.toContain(after);

    const day = await tasks.calendar(a.exec1.ctx, { view: 'day', date: '2027-03-14' });
    expect(idsIn(day)).toContain(last);
    expect(idsIn(day)).not.toContain(first);

    // March 2027 shown as whole weeks: Mon 1 March to Sun 4 April.
    const month = await tasks.calendar(a.exec1.ctx, { view: 'month', date: '2027-03-20' });
    expect([month.period.first, month.period.end]).toEqual(['2027-03-01', '2027-04-05']);
    for (const id of [first, last, before, after]) expect(idsIn(month)).toContain(id);
  });

  it('a meeting running across the first midnight is listed on the first day', async () => {
    const m = await task(A, a.exec1, ist('2027-03-07T23:30'), {
      type: 'MEETING',
      endAt: ist('2027-03-08T00:30'),
    });
    const ended = await task(A, a.exec1, ist('2027-03-07T22:00'), {
      type: 'MEETING',
      endAt: ist('2027-03-08T00:00'),
    });
    const cal = await tasks.calendar(a.exec1.ctx, WEEK);
    expect(dayOf(cal, m)).toBe('2027-03-08');
    expect(idsIn(cal)).not.toContain(ended); // ends exactly at the start: not in this week
  });

  it('lists items of a day in time order, and an invalid query falls back to this week', async () => {
    const late = await task(A, a.exec1, ist('2027-03-09T18:00'));
    const early = await task(A, a.exec1, ist('2027-03-09T09:00'));
    const cal = await tasks.calendar(a.exec1.ctx, WEEK);
    const tue = cal.byDay['2027-03-09']!.map((t) => t.id);
    expect(tue.indexOf(early)).toBeLessThan(tue.indexOf(late));
    const fallback = await tasks.calendar(a.exec1.ctx, { view: 'year', date: '2027-02-30' });
    expect(fallback.period.view).toBe('week');
    expect(fallback.period.days).toContain(fallback.today);
  });
});

describe('what appears (same visibility as My Day)', () => {
  it('never closed tasks, others’ tasks or other orgs’ tasks; no-lead tasks stay private', async () => {
    const done = await task(A, a.exec1, ist('2027-03-10T10:00'), { status: 'DONE' });
    const cancelled = await task(A, a.exec1, ist('2027-03-10T11:00'), { status: 'CANCELLED' });
    const privateTask = await task(A, a.exec1, ist('2027-03-10T12:00'));
    const l = await created(a.exec1);
    const onLead = await task(A, a.exec1, ist('2027-03-10T13:00'), { type: 'CALL', leadId: l });
    const exec2s = await task(A, a.exec2, ist('2027-03-10T14:00'));
    const otherOrg = await task(B, ownerB, ist('2027-03-10T15:00'));

    const mine = idsIn(await tasks.calendar(a.exec1.ctx, WEEK));
    expect(mine).toEqual(expect.arrayContaining([privateTask, onLead]));
    for (const id of [done, cancelled, exec2s, otherOrg]) expect(mine).not.toContain(id);
    // A manager's, an Owner's and another org's calendars are their own.
    for (const who of [a.manager, a.owner, a.admin, ownerB]) {
      const theirs = idsIn(await tasks.calendar(who.ctx, WEEK));
      for (const id of [privateTask, onLead, exec2s]) expect(theirs).not.toContain(id);
    }
    expect(idsIn(await tasks.calendar(ownerB.ctx, WEEK))).toContain(otherOrg);
  });

  it('shows invited meetings read-only, without a lead the attendee cannot open', async () => {
    const l = await created(a.exec1);
    const m = await task(A, a.exec1, ist('2027-03-11T10:00'), {
      type: 'MEETING',
      endAt: ist('2027-03-11T11:00'),
      leadId: l,
    });
    const removed = await task(A, a.exec1, ist('2027-03-11T12:00'), {
      type: 'MEETING',
      endAt: ist('2027-03-11T13:00'),
    });
    const closedLater = await task(A, a.exec1, ist('2027-03-11T14:00'), {
      type: 'MEETING',
      endAt: ist('2027-03-11T15:00'),
    });
    await invite(A, m, a.exec2, a.exec1);
    const gone = await invite(A, removed, a.exec2, a.exec1);
    await migrator().taskAttendee.update({
      where: { id: gone.id },
      data: { removedAt: new Date(), removedBy: A.users.exec1.id },
    });
    await invite(A, closedLater, a.exec2, a.exec1);
    // task_guard: completion time is the transaction time exactly.
    await migrator()
      .$executeRaw`UPDATE task SET status = 'DONE', completed_at = now(), version = version + 1 WHERE id = ${closedLater}::uuid`;

    const cal = await tasks.calendar(a.exec2.ctx, WEEK);
    const item = cal.byDay['2027-03-11']!.find((t) => t.id === m)!;
    expect(item).toMatchObject({ attending: true, canUpdate: false, onLead: true, lead: null });
    expect(item.organiserName).toBeTruthy();
    expect(idsIn(cal)).not.toContain(removed);
    expect(idsIn(cal)).not.toContain(closedLater);
    // The organiser sees their own meeting with the lead.
    const own = (await tasks.calendar(a.exec1.ctx, WEEK)).byDay['2027-03-11']!.find(
      (t) => t.id === m,
    )!;
    expect(own).toMatchObject({ attending: false });
    expect(own.lead?.id).toBe(l);
  });

  it('follows reassignment and Won/Lost', async () => {
    const l = await created(a.exec1);
    const call = await task(A, a.exec1, ist('2027-03-12T10:00'), { type: 'CALL', leadId: l });
    await leads.assignLead(a.admin.ctx, l, {
      target: `user:${A.users.exec2.id}`,
      version: (await migrator().lead.findUniqueOrThrow({ where: { id: l } })).version,
      reason: 'Synthetic: rebalancing',
    });
    expect(idsIn(await tasks.calendar(a.exec1.ctx, WEEK))).not.toContain(call);
    expect(idsIn(await tasks.calendar(a.exec2.ctx, WEEK))).toContain(call);
    await leads.changeStage(a.exec2.ctx, l, {
      toStage: 'LOST',
      version: String((await migrator().lead.findUniqueOrThrow({ where: { id: l } })).version),
      reasonCode: 'NOT_INTERESTED',
    });
    expect(idsIn(await tasks.calendar(a.exec2.ctx, WEEK))).not.toContain(call);
  });

  it('HR sees their own no-lead tasks only', async () => {
    const hrs = await task(A, a.hr, ist('2027-03-13T10:00'), { type: 'DOCUMENT' });
    expect(idsIn(await tasks.calendar(a.hr.ctx, WEEK))).toEqual([hrs]);
  });

  it('flags meetings that overlap another of the caller’s meetings', async () => {
    const one = await task(A, a.manager, ist('2027-03-12T15:00'), {
      type: 'MEETING',
      endAt: ist('2027-03-12T16:00'),
    });
    const two = await task(A, a.manager, ist('2027-03-12T15:30'), {
      type: 'MEETING',
      endAt: ist('2027-03-12T16:30'),
    });
    const after = await task(A, a.manager, ist('2027-03-12T16:30'), {
      type: 'MEETING',
      endAt: ist('2027-03-12T17:00'),
    });
    const fri = (await tasks.calendar(a.manager.ctx, WEEK)).byDay['2027-03-12']!;
    const flag = (id: string) => fri.find((t) => t.id === id)!.overlaps;
    // Back to back (two ends at 16:30 when after starts) is not an overlap.
    expect([flag(one), flag(two), flag(after)]).toEqual([true, true, false]);
  });
});
