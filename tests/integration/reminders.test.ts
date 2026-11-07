// FR-106 task reminders (migration 0023, ADR-0019): app.task_reminders_claim records each due
// reminder once (15 minutes before the due time) with an outbox event; the notification worker
// delivers it in-app to the current assignee after re-checking the task. The due-time window,
// idempotency (repeated and concurrent claims, redelivery), reschedule (stale key, new reminder),
// completion and cancellation, reassignment, Won/Lost, inactive assignees, attendees, and other
// orgs. Synthetic data only.
import { randomUUID } from 'node:crypto';
import { beforeAll, describe, expect, it } from 'vitest';
import * as leads from '@/modules/leads';
import * as members from '@/modules/members';
import { notifyForEvent } from '@/modules/notifications';
import * as tasks from '@/modules/tasks';
import { claimDueReminders, REMINDER_OFFSET_MINUTES } from '@/modules/tasks/reminders';
import { migrator, withRole } from '../support/db';
import { actorIn, seedOrg, type Actor } from '../support/factory';

const APP = process.env.TEST_DATABASE_URL!;
type Org = Awaited<ReturnType<typeof seedOrg>>;
type Role = 'owner' | 'admin' | 'manager' | 'exec1' | 'exec2' | 'hr';

async function sqlState(p: Promise<unknown>): Promise<string> {
  try {
    await p;
    return 'OK';
  } catch (e) {
    return (e as { code?: string }).code ?? 'ERR';
  }
}
async function asApp(org: Org, userId: string, sql: string, params: unknown[] = []) {
  return withRole(APP, async (c) => {
    await c.query('BEGIN');
    try {
      await c.query(
        `SELECT set_config('app.org_id', $1, true), set_config('app.user_id', $2, true)`,
        [org.orgId, userId],
      );
      const r = await c.query(sql, params);
      await c.query('COMMIT');
      return r;
    } catch (e) {
      await c.query('ROLLBACK');
      throw e;
    }
  });
}
const local = (minutes: number) =>
  tasks.orgLocalInput(new Date(Date.now() + minutes * 60_000), 'Asia/Kolkata');
/** Minutes from now, to the whole second (as a stored due time). */
const inMin = (minutes: number) =>
  new Date(Math.floor((Date.now() + minutes * 60_000) / 1000) * 1000);

let seq = 0;
async function task(
  org: Org,
  who: Actor,
  dueAt: Date,
  extra: { type?: string; leadId?: string; endAt?: Date; status?: 'DONE' | 'CANCELLED' } = {},
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
      title: `Synthetic reminder ${++seq}`,
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
const remindersOf = (taskId: string) =>
  migrator().taskReminder.findMany({ where: { taskId }, orderBy: { createdAt: 'asc' } });
const eventsOf = (taskId: string) =>
  migrator().outboxEvent.findMany({
    where: { type: 'task.reminder_due', payload: { path: ['taskId'], equals: taskId } },
    orderBy: { createdAt: 'asc' },
  });
async function deliver(taskId: string) {
  for (const e of await eventsOf(taskId))
    await notifyForEvent({ eventId: e.id, orgId: e.orgId, type: e.type, payload: e.payload });
}
const reminded = (taskId: string) =>
  migrator().notification.findMany({
    where: { type: 'TASK_REMINDER', data: { path: ['taskId'], equals: taskId } },
  });
let phoneSeq = 0;
const phone = () => `97${String(10_000_000 + ++phoneSeq * 8_123 + (process.pid % 1000)).slice(-8)}`;
async function created(by: Actor): Promise<string> {
  const r = await leads.createLead(by.ctx, {
    fullName: 'Synthetic Reminder Lead',
    primaryPhone: phone(),
  });
  if (r.status !== 'created') throw new Error('fixture lead');
  return r.leadId;
}
const versionOf = async (id: string) =>
  (await migrator().lead.findUniqueOrThrow({ where: { id } })).version;

async function setup(name: string) {
  const org = await seedOrg(name);
  const a = {} as Record<Role, Actor>;
  for (const k of ['owner', 'admin', 'manager', 'exec1', 'exec2', 'hr'] as const)
    a[k] = await actorIn(org.users[k], org.orgId);
  return { org, a };
}
let A: Awaited<ReturnType<typeof setup>>;
let B: Awaited<ReturnType<typeof setup>>;
beforeAll(async () => {
  A = await setup('RemA');
  B = await setup('RemB');
});

describe('which reminders are due (15 minutes before)', () => {
  it('records open tasks due within the next 15 minutes, once, with the fire time', async () => {
    const { org, a } = A;
    expect(REMINDER_OFFSET_MINUTES).toBe(15);
    const soon = await task(org, a.exec1, inMin(10));
    const edge = await task(org, a.exec1, inMin(14.5));
    const later = await task(org, a.exec1, inMin(16));
    const past = await task(org, a.exec1, inMin(-1));
    const done = await task(org, a.exec1, inMin(5), { status: 'DONE' });
    const cancelled = await task(org, a.exec1, inMin(5), { status: 'CANCELLED' });
    await claimDueReminders();
    for (const id of [soon, edge]) {
      const r = await remindersOf(id);
      expect(r).toHaveLength(1);
      const t = await migrator().task.findUniqueOrThrow({ where: { id } });
      expect(r[0]!).toMatchObject({ offsetMinutes: 15, orgId: org.orgId });
      expect(r[0]!.fireAt.getTime()).toBe(t.dueAt.getTime() - 15 * 60_000);
      expect(await eventsOf(id)).toHaveLength(1);
    }
    for (const id of [later, past, done, cancelled]) expect(await remindersOf(id)).toHaveLength(0);
  });

  it('is idempotent: repeated and concurrent claims, and redelivered events', async () => {
    const { org, a } = A;
    const id = await task(org, a.exec1, inMin(8));
    await Promise.all([claimDueReminders(), claimDueReminders(), claimDueReminders()]);
    await claimDueReminders();
    expect(await remindersOf(id)).toHaveLength(1);
    expect(await eventsOf(id)).toHaveLength(1);
    await deliver(id);
    await deliver(id);
    const n = await reminded(id);
    expect(n).toHaveLength(1);
    expect(n[0]).toMatchObject({ recipientUserId: org.users.exec1.id, link: '/app/my-day' });
    expect(n[0]!.title).toMatch(/^Reminder: other at /);
  });
});

describe('the task lifecycle', () => {
  it('a reschedule makes the old reminder stale and gets its own', async () => {
    const { a } = A;
    const { id } = await tasks.createTask(a.exec1.ctx, null, {
      type: 'DOCUMENT',
      title: 'Synthetic reschedule',
      dueAt: local(10),
    });
    await claimDueReminders();
    await tasks.rescheduleFollowUp(a.exec1.ctx, id, { dueAt: local(13), version: 1 });
    await claimDueReminders();
    const r = await remindersOf(id);
    expect(r).toHaveLength(2);
    expect(r[0]!.fireAt.getTime()).not.toBe(r[1]!.fireAt.getTime());
    await deliver(id); // the first event is stale (due time changed), the second is delivered
    const n = await reminded(id);
    expect(n).toHaveLength(1);
    expect(n[0]!.data).toMatchObject({ dueAt: r[1]!.dueAt.toISOString() });
    // Moved out of the window: nothing new.
    await tasks.rescheduleFollowUp(a.exec1.ctx, id, { dueAt: local(120), version: 2 });
    await claimDueReminders();
    expect(await remindersOf(id)).toHaveLength(2);
  });

  it('a task completed or cancelled before delivery is not reminded', async () => {
    const { a } = A;
    const done = (
      await tasks.createTask(a.exec1.ctx, null, {
        type: 'OTHER',
        title: 'Synthetic',
        dueAt: local(9),
      })
    ).id;
    const gone = (
      await tasks.createTask(a.exec1.ctx, null, {
        type: 'OTHER',
        title: 'Synthetic',
        dueAt: local(9),
      })
    ).id;
    await claimDueReminders();
    await tasks.completeFollowUp(a.exec1.ctx, done, { version: 1 });
    await tasks.cancelFollowUp(a.exec1.ctx, gone, { reason: 'Synthetic', version: 1 });
    await deliver(done);
    await deliver(gone);
    expect(await reminded(done)).toHaveLength(0);
    expect(await reminded(gone)).toHaveLength(0);
  });

  it('goes to the current assignee after a lead reassignment; Won/Lost leaves nothing to remind', async () => {
    const { org, a } = A;
    const l = await created(a.exec1);
    const call = await task(org, a.exec1, inMin(11), { type: 'CALL', leadId: l });
    await claimDueReminders();
    await leads.assignLead(a.admin.ctx, l, {
      target: `user:${org.users.exec2.id}`,
      version: await versionOf(l),
      reason: 'Synthetic: rebalancing',
    });
    await deliver(call);
    const n = await reminded(call);
    expect(n.map((x) => x.recipientUserId)).toEqual([org.users.exec2.id]);
    expect(n[0]!.link).toBe(`/app/leads/${l}`);

    const l2 = await created(a.exec1);
    const lost = await task(org, a.exec1, inMin(12), { leadId: l2 });
    await leads.changeStage(a.exec1.ctx, l2, {
      toStage: 'LOST',
      version: String(await versionOf(l2)),
      reasonCode: 'NOT_INTERESTED',
    });
    await claimDueReminders();
    expect(await remindersOf(lost)).toHaveLength(0);
  });

  it('nobody is reminded when the assignee is no longer active; attendees are not reminded', async () => {
    const s = await setup('RemGone');
    const t = await task(s.org, s.a.exec2, inMin(10));
    await claimDueReminders();
    await members.suspendMember(s.a.owner.ctx, s.org.membership.exec2!);
    await deliver(t);
    expect(await reminded(t)).toHaveLength(0);

    const m = await task(s.org, s.a.exec1, inMin(10), { type: 'MEETING', endAt: inMin(40) });
    await migrator().taskAttendee.create({
      data: {
        orgId: s.org.orgId,
        taskId: m,
        userId: s.org.users.hr.id,
        addedBy: s.org.users.exec1.id,
      },
    });
    await claimDueReminders();
    await deliver(m);
    expect((await reminded(m)).map((x) => x.recipientUserId)).toEqual([s.org.users.exec1.id]);
  });

  it('an event delivered after the due time is dropped', async () => {
    const { org, a } = A;
    const t = await task(org, a.exec1, inMin(-2));
    const due = (await migrator().task.findUniqueOrThrow({ where: { id: t } })).dueAt;
    await notifyForEvent({
      eventId: randomUUID(),
      orgId: org.orgId,
      type: 'task.reminder_due',
      payload: {
        taskId: t,
        offsetMinutes: 15,
        dueAt: due.toISOString(),
        fireAt: new Date(due.getTime() - 15 * 60_000).toISOString(),
      },
    });
    expect(await reminded(t)).toHaveLength(0);
  });
});

describe('organisations and the database', () => {
  it('each org gets its own reminders; another org sees none of them', async () => {
    const bt = await task(B.org, B.a.exec1, inMin(10));
    await claimDueReminders();
    const r = await remindersOf(bt);
    expect(r[0]!.orgId).toBe(B.org.orgId);
    expect((await eventsOf(bt))[0]!.orgId).toBe(B.org.orgId);
    await deliver(bt);
    expect((await reminded(bt)).map((n) => [n.orgId, n.recipientUserId])).toEqual([
      [B.org.orgId, B.org.users.exec1.id],
    ]);
    const seen = await asApp(
      A.org,
      A.org.users.owner.id,
      `SELECT count(*)::int AS n FROM task_reminder WHERE task_id = $1`,
      [bt],
    );
    expect(seen.rows[0].n).toBe(0);
  });

  it('crm_app cannot write reminders directly', async () => {
    const { org, a } = A;
    const t = await task(org, a.exec1, inMin(60));
    expect(
      await sqlState(
        asApp(
          org,
          org.users.exec1.id,
          `INSERT INTO task_reminder (org_id, task_id, offset_minutes, fire_at, due_at)
           SELECT org_id, id, 15, due_at - interval '15 minutes', due_at FROM task WHERE id = $1`,
          [t],
        ),
      ),
    ).toBe('42501');
  });
});
