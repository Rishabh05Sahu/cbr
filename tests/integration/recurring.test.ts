// FR-107 recurring tasks (migration 0024, ADR-0020). Owner rules 2026-10-30: no-lead Call /
// Meeting / Document / Other only; created by Owner, Admin or Sales Manager for themselves; daily
// or weekly at an org-local time; the next occurrence on completion or cancellation, strictly after
// that moment (missed dates skipped); inclusive end date; stop vs cancel; edits apply to future
// occurrences; meetings keep length, location and attendees; each occurrence an ordinary task with
// its own reminder. Permissions, concurrency, deactivation, other orgs and the database backstop.
// Synthetic data only.
import { beforeAll, describe, expect, it } from 'vitest';
import { parseOrgLocal } from '@/modules/leads';
import * as members from '@/modules/members';
import * as tasks from '@/modules/tasks';
import { claimDueReminders } from '@/modules/tasks/reminders';
import { DomainError } from '@/platform/errors';
import { migrator, withRole } from '../support/db';
import { actorIn, seedOrg, type Actor } from '../support/factory';

const APP = process.env.TEST_DATABASE_URL!;
const TZ = 'Asia/Kolkata';
type Org = Awaited<ReturnType<typeof seedOrg>>;
type Role = 'owner' | 'admin' | 'manager' | 'exec1' | 'exec2' | 'hr';

async function failure(p: Promise<unknown>): Promise<{ code: string; fields: string[] }> {
  try {
    await p;
  } catch (e) {
    if (e instanceof DomainError)
      return { code: e.code, fields: Object.keys(e.fieldErrors ?? {}).sort() };
    if (e instanceof Error && e.name === 'ZodError')
      return { code: 'VALIDATION_FAILED', fields: [] };
    throw e;
  }
  return { code: 'OK', fields: [] };
}
const codeOf = async (p: Promise<unknown>) => (await failure(p)).code;
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

/** HH:MM in India time, `minutes` from now. */
const timeIn = (minutes: number) =>
  tasks.orgLocalInput(new Date(Date.now() + minutes * 60_000), TZ).slice(11, 16);
const today = () => tasks.orgLocalInput(new Date(), TZ).slice(0, 10);
const expectedNext = (rule: tasks.SeriesRule, after = new Date()) =>
  tasks.nextOccurrence(rule, after, TZ, (v) => parseOrgLocal(v, TZ));
const daily = (extra: Record<string, unknown> = {}) => ({
  type: 'OTHER',
  title: `Synthetic daily ${Math.random().toString(36).slice(2, 7)}`,
  frequency: 'DAILY',
  localTime: timeIn(120),
  ...extra,
});
const occurrences = (seriesId: string) =>
  migrator().task.findMany({ where: { seriesId }, orderBy: [{ createdAt: 'asc' }, { id: 'asc' }] });
const openOf = async (seriesId: string) =>
  (await occurrences(seriesId)).filter((t) => t.status === 'OPEN');
const seriesRow = (id: string) => migrator().taskSeries.findUniqueOrThrow({ where: { id } });

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
  A = await setup('RecA');
  B = await setup('RecB');
});

describe('creating a series', () => {
  it('Owner, Admin and Sales Manager create one; its first occurrence is theirs, no lead', async () => {
    const { a, org } = A;
    for (const who of [a.owner, a.admin, a.manager]) {
      const input = daily();
      const s = await tasks.createSeries(who.ctx, input);
      const [first] = await occurrences(s.id);
      expect(first).toMatchObject({
        id: s.taskId,
        seriesId: s.id,
        leadId: null,
        type: 'OTHER',
        status: 'OPEN',
        assigneeUserId: who.user.id,
        createdBy: who.user.id,
      });
      const rule = {
        frequency: 'DAILY',
        weekday: null,
        localTime: input.localTime,
        endDate: null,
      } as const;
      // Created a moment ago: the first date strictly after creation.
      expect(first!.dueAt.getTime()).toBe(
        expectedNext(rule, new Date(first!.createdAt.getTime() - 1))!.getTime(),
      );
      expect((await seriesRow(s.id)).ownerUserId).toBe(who.user.id);
    }
    expect(
      await migrator().auditLog.count({
        where: { action: 'task_series.created', actorUserId: org.users.manager.id },
      }),
    ).toBe(1);
  });

  it('Sales Executives, HR and other orgs cannot', async () => {
    const { a } = A;
    expect(await codeOf(tasks.createSeries(a.exec1.ctx, daily()))).toBe('FORBIDDEN');
    expect(await codeOf(tasks.createSeries(a.hr.ctx, daily()))).toBe('FORBIDDEN');
    expect(await tasks.listMySeries(a.exec1.ctx)).toEqual([]);
  });

  it('validates the template', async () => {
    const { a, org } = A;
    const bad = (extra: Record<string, unknown>) =>
      failure(tasks.createSeries(a.manager.ctx, daily(extra)));
    expect((await bad({ type: 'FOLLOW_UP' })).code).toBe('VALIDATION_FAILED');
    expect(await bad({ localTime: '25:00' })).toEqual({
      code: 'VALIDATION_FAILED',
      fields: ['localTime'],
    });
    expect(await bad({ frequency: 'WEEKLY', weekday: '9' })).toEqual({
      code: 'VALIDATION_FAILED',
      fields: ['weekday'],
    });
    expect(await bad({ endDate: '2020-01-01' })).toEqual({
      code: 'VALIDATION_FAILED',
      fields: ['endDate'],
    });
    expect(await bad({ endDate: '2026-02-30' })).toEqual({
      code: 'VALIDATION_FAILED',
      fields: ['endDate'],
    });
    expect(await bad({ durationMinutes: '30', location: 'Room' })).toEqual({
      code: 'VALIDATION_FAILED',
      fields: ['durationMinutes', 'location'],
    });
    expect(await bad({ type: 'MEETING' })).toEqual({
      code: 'VALIDATION_FAILED',
      fields: ['durationMinutes'],
    });
    expect(
      await bad({
        type: 'MEETING',
        durationMinutes: '30',
        attendeeUserIds: [org.users.manager.id],
      }),
    ).toEqual({ code: 'VALIDATION_FAILED', fields: ['attendeeUserIds'] }); // its own owner
    // Today as the end date, with the time already passed today: no date left.
    expect(
      await bad({
        endDate: today(),
        localTime: timeIn(-120).localeCompare(timeIn(0)) < 0 ? timeIn(-120) : '00:00',
      }),
    ).toEqual({
      code: 'VALIDATION_FAILED',
      fields: ['endDate'],
    });
  });
});

describe('advancing', () => {
  it('completion and cancellation each create the next occurrence; the series goes on', async () => {
    const { a } = A;
    const s = await tasks.createSeries(a.manager.ctx, daily());
    await tasks.completeFollowUp(a.manager.ctx, s.taskId, { version: 1 });
    let open = await openOf(s.id);
    expect(open).toHaveLength(1);
    expect(open[0]!.id).not.toBe(s.taskId);
    // Completed before its time: the next is the following day at the same time, never the same
    // date again (India has no daylight saving: exactly 24 hours later).
    const first = await migrator().task.findUniqueOrThrow({ where: { id: s.taskId } });
    expect(open[0]!.dueAt.getTime() - first.dueAt.getTime()).toBe(86_400_000);
    await tasks.cancelFollowUp(a.manager.ctx, open[0]!.id, {
      reason: 'Synthetic: skip one',
      version: 1,
    });
    open = await openOf(s.id);
    expect(open).toHaveLength(1);
    expect((await occurrences(s.id)).map((t) => t.status)).toEqual(['DONE', 'CANCELLED', 'OPEN']);
    expect((await seriesRow(s.id)).stoppedAt).toBeNull();
  });

  it('skips missed dates: the next is strictly after now, with no backlog', async () => {
    const { a, org } = A;
    const input = daily();
    const s = await tasks.createSeries(a.manager.ctx, input);
    // Simulate an occurrence three days overdue (schema owner), then complete it now.
    await migrator()
      .$executeRaw`UPDATE task SET status = 'DONE', completed_at = now(), version = version + 1 WHERE id = ${s.taskId}::uuid`;
    const late = await migrator().task.create({
      data: {
        orgId: org.orgId,
        type: 'OTHER',
        title: input.title,
        assigneeUserId: org.users.manager.id,
        createdBy: org.users.manager.id,
        dueAt: new Date(Date.now() - 3 * 86_400_000),
        seriesId: s.id,
      },
    });
    const before = new Date();
    await tasks.completeFollowUp(a.manager.ctx, late.id, { version: 1 });
    const all = await occurrences(s.id);
    expect(all).toHaveLength(3);
    const next = all.find((t) => t.status === 'OPEN')!;
    expect(next.dueAt.getTime()).toBeGreaterThan(before.getTime());
    const rule = {
      frequency: 'DAILY',
      weekday: null,
      localTime: input.localTime,
      endDate: null,
    } as const;
    expect(next.dueAt.getTime()).toBe(expectedNext(rule, before)!.getTime());
  });

  it('concurrent completions create exactly one next occurrence', async () => {
    const { a } = A;
    const s = await tasks.createSeries(a.manager.ctx, daily());
    const results = await Promise.allSettled([
      tasks.completeFollowUp(a.manager.ctx, s.taskId, { version: 1 }),
      tasks.completeFollowUp(a.manager.ctx, s.taskId, { version: 1 }),
      tasks.cancelFollowUp(a.manager.ctx, s.taskId, { reason: 'Synthetic', version: 1 }),
    ]);
    expect(results.filter((r) => r.status === 'fulfilled')).toHaveLength(1);
    expect(await openOf(s.id)).toHaveLength(1);
    expect(await occurrences(s.id)).toHaveLength(2);
  });

  it('respects the inclusive end date (weekly)', async () => {
    const { a } = A;
    // Weekly on today's weekday, two hours from now, ending today: one occurrence only.
    const weekday = (new Date(`${today()}T00:00:00Z`).getUTCDay() + 6) % 7;
    const s = await tasks.createSeries(
      a.manager.ctx,
      daily({ frequency: 'WEEKLY', weekday: String(weekday), endDate: today() }),
    );
    await tasks.completeFollowUp(a.manager.ctx, s.taskId, { version: 1 });
    expect(await openOf(s.id)).toHaveLength(0);
    expect(await occurrences(s.id)).toHaveLength(1);
  });
});

describe('stopping and editing', () => {
  it('stop leaves the current task; no further occurrences; a stopped series cannot change', async () => {
    const { a } = A;
    const s = await tasks.createSeries(a.manager.ctx, daily());
    expect(await codeOf(tasks.stopSeries(a.manager.ctx, s.id, { version: 2 }))).toBe('CONFLICT');
    await tasks.stopSeries(a.manager.ctx, s.id, { version: 1 });
    expect((await migrator().task.findUniqueOrThrow({ where: { id: s.taskId } })).status).toBe(
      'OPEN',
    );
    await tasks.completeFollowUp(a.manager.ctx, s.taskId, { version: 1 });
    expect(await openOf(s.id)).toHaveLength(0);
    expect(await codeOf(tasks.stopSeries(a.manager.ctx, s.id, { version: 2 }))).toBe(
      'RULE_VIOLATION',
    );
    expect(await codeOf(tasks.updateSeries(a.manager.ctx, s.id, { ...daily(), version: 2 }))).toBe(
      'RULE_VIOLATION',
    );
    expect((await tasks.listMySeries(a.manager.ctx)).map((x) => x.id)).not.toContain(s.id);
  });

  it('edits change future occurrences only', async () => {
    const { a } = A;
    const s = await tasks.createSeries(a.manager.ctx, daily({ title: 'Synthetic before' }));
    const first = await migrator().task.findUniqueOrThrow({ where: { id: s.taskId } });
    const newTime = timeIn(180);
    await tasks.updateSeries(a.manager.ctx, s.id, {
      title: 'Synthetic after',
      frequency: 'DAILY',
      localTime: newTime,
      priority: 'HIGH',
      version: 1,
    });
    expect(await migrator().task.findUniqueOrThrow({ where: { id: s.taskId } })).toMatchObject({
      title: 'Synthetic before',
      dueAt: first.dueAt,
      priority: 'NORMAL',
    });
    await tasks.completeFollowUp(a.manager.ctx, s.taskId, { version: 1 });
    const [next] = await openOf(s.id);
    expect(next).toMatchObject({ title: 'Synthetic after', priority: 'HIGH' });
    expect(tasks.orgLocalInput(next!.dueAt, TZ).slice(11, 16)).toBe(newTime);
    expect(await codeOf(tasks.updateSeries(a.manager.ctx, s.id, { ...daily(), version: 1 }))).toBe(
      'CONFLICT',
    );
  });
});

describe('meetings, reminders and visibility', () => {
  it('a recurring meeting keeps length, location and attendees; invitations per occurrence', async () => {
    const { a, org } = A;
    const s = await tasks.createSeries(
      a.manager.ctx,
      daily({
        type: 'MEETING',
        durationMinutes: '45',
        location: 'Synthetic room 7',
        attendeeUserIds: [org.users.exec1.id, org.users.hr.id],
      }),
    );
    const check = async (taskId: string) => {
      const t = await migrator().task.findUniqueOrThrow({ where: { id: taskId } });
      expect(t.endAt!.getTime() - t.dueAt.getTime()).toBe(45 * 60_000);
      expect(t.location).toBe('Synthetic room 7');
      const att = await migrator().taskAttendee.findMany({ where: { taskId, removedAt: null } });
      expect(att.map((x) => x.userId).sort()).toEqual([org.users.exec1.id, org.users.hr.id].sort());
      expect(
        await migrator().outboxEvent.count({
          where: { type: 'meeting.invited', payload: { path: ['taskId'], equals: taskId } },
        }),
      ).toBe(1);
    };
    await check(s.taskId);
    // The attendee sees it read-only on My Day; the occurrence stays private otherwise.
    const day = await tasks.myDay(a.exec1.ctx);
    const seen = [...day.today, ...day.upcoming, ...day.later].find((t) => t.id === s.taskId);
    expect(seen).toMatchObject({ attending: true, canUpdate: false, seriesId: s.id });
    await tasks.completeFollowUp(a.manager.ctx, s.taskId, { version: 1 });
    const [next] = await openOf(s.id);
    await check(next!.id);
  });

  it('a deactivated attendee is left out of the next occurrence', async () => {
    const t = await setup('RecAtt');
    const s = await tasks.createSeries(
      t.a.manager.ctx,
      daily({
        type: 'MEETING',
        durationMinutes: '30',
        attendeeUserIds: [t.org.users.exec1.id, t.org.users.exec2.id],
      }),
    );
    await members.deactivateMember(t.a.owner.ctx, t.org.membership.exec2!);
    await tasks.completeFollowUp(t.a.manager.ctx, s.taskId, { version: 1 });
    const [next] = await openOf(s.id);
    const att = await migrator().taskAttendee.findMany({
      where: { taskId: next!.id, removedAt: null },
    });
    expect(att.map((x) => x.userId)).toEqual([t.org.users.exec1.id]);
  });

  it('each occurrence gets its own FR-106 reminder', async () => {
    const { a } = A;
    const s = await tasks.createSeries(a.manager.ctx, daily({ localTime: timeIn(10) }));
    await claimDueReminders();
    const first = await migrator().task.findUniqueOrThrow({ where: { id: s.taskId } });
    if (first.dueAt.getTime() - Date.now() <= 15 * 60_000)
      expect(await migrator().taskReminder.count({ where: { taskId: s.taskId } })).toBe(1);
    await tasks.completeFollowUp(a.manager.ctx, s.taskId, { version: 1 });
    const [next] = await openOf(s.id);
    await claimDueReminders();
    // The next one is a day later: not due for a reminder yet, and it has its own key.
    expect(await migrator().taskReminder.count({ where: { taskId: next!.id } })).toBe(0);
  });

  it('occurrences are private no-lead tasks: not a team member, not another org', async () => {
    const { a, org } = A;
    const s = await tasks.createSeries(a.manager.ctx, daily());
    for (const who of [a.exec1, a.hr, B.a.owner])
      expect(await codeOf(tasks.completeFollowUp(who.ctx, s.taskId, { version: 1 }))).toBe(
        'NOT_FOUND',
      );
    for (const who of [a.exec1, B.a.owner, B.a.manager]) {
      expect(await codeOf(tasks.stopSeries(who.ctx, s.id, { version: 1 }))).not.toBe('OK');
      expect(await codeOf(tasks.updateSeries(who.ctx, s.id, { ...daily(), version: 1 }))).not.toBe(
        'OK',
      );
    }
    expect(await codeOf(tasks.stopSeries(B.a.owner.ctx, s.id, { version: 1 }))).toBe('NOT_FOUND');
    expect((await seriesRow(s.id)).stoppedAt).toBeNull();
    // An Owner (ORG task scope) may complete it; the next occurrence is still the series owner's.
    await tasks.completeFollowUp(a.owner.ctx, s.taskId, { version: 1 });
    const [next] = await openOf(s.id);
    expect(next!.assigneeUserId).toBe(org.users.manager.id);
  });

  it('deactivating the owner stops the series and creates nothing', async () => {
    const t = await setup('RecGone');
    const s = await tasks.createSeries(t.a.manager.ctx, daily());
    await members.deactivateMember(t.a.owner.ctx, t.org.membership.manager!);
    expect((await seriesRow(s.id)).stoppedAt).not.toBeNull();
    expect(await openOf(s.id)).toHaveLength(0);
    expect((await occurrences(s.id))[0]).toMatchObject({
      status: 'CANCELLED',
      cancelReason: 'Assignee deactivated',
    });
  });
});

describe('database backstop (crm_app, migration 0024)', () => {
  it('only Owner/Admin/Sales Manager insert series for themselves; occurrences no lead, one open', async () => {
    const { org } = A;
    const u = org.users;
    const series = (as: string, owner = as) =>
      sqlState(
        asApp(
          org,
          as,
          `INSERT INTO task_series (org_id, owner_user_id, created_by, type, title, frequency, local_time)
           VALUES ($1, $2, $3, 'OTHER', 'Synthetic', 'DAILY', '09:00')`,
          [org.orgId, owner, as],
        ),
      );
    expect(await series(u.exec1.id)).toBe('42501');
    expect(await series(u.hr.id)).toBe('42501');
    expect(await series(u.manager.id, u.exec1.id)).toBe('42501');
    expect(await series(u.manager.id)).toBe('OK');

    const s = await tasks.createSeries(A.a.manager.ctx, daily());
    const occ = (extra: string) =>
      sqlState(
        asApp(
          org,
          u.manager.id,
          `INSERT INTO task (org_id, type, title, assignee_user_id, created_by, due_at, series_id${extra ? ', lead_id' : ''})
           VALUES ($1, 'OTHER', 'Synthetic', $2, $2, now() + interval '3 hours', $3${extra ? ', $4' : ''})`,
          extra ? [org.orgId, u.manager.id, s.id, extra] : [org.orgId, u.manager.id, s.id],
        ),
      );
    expect(await occ('')).toBe('23505'); // a second open occurrence
    const anyLead = await migrator()
      .lead.findFirstOrThrow({ where: { orgId: org.orgId } })
      .catch(() => null);
    if (anyLead) expect(await occ(anyLead.id)).not.toBe('OK');
    expect(
      await sqlState(
        asApp(org, u.manager.id, `UPDATE task_series SET owner_user_id = $2 WHERE id = $1`, [
          s.id,
          u.exec1.id,
        ]),
      ),
    ).toBe('42501');
  });
});
