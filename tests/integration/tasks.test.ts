// FR-100 task types (migration 0020, ADR-0015): Call, Meeting, Document and Other tasks for
// oneself, on a lead or with no lead. Validation, scope, HR's own non-lead tasks, the
// Do-Not-Contact rule for Call tasks (app and database), the follow-up lifecycle applied to every
// lead task (reassignment, Won/Lost, deactivation), no-lead tasks cancelled on deactivation, My Day
// and other orgs. The FR-108 follow-up rules are unchanged. Synthetic data only.
import { beforeAll, describe, expect, it } from 'vitest';
import * as leads from '@/modules/leads';
import * as members from '@/modules/members';
import * as tasks from '@/modules/tasks';
import { DomainError } from '@/platform/errors';
import { migrator, withRole } from '../support/db';
import { actorIn, seedOrg, type Actor } from '../support/factory';

const APP = process.env.TEST_DATABASE_URL!;
type Org = Awaited<ReturnType<typeof seedOrg>>;
type Role = 'owner' | 'admin' | 'manager' | 'exec1' | 'exec2' | 'hr';

async function codeOf(p: Promise<unknown>): Promise<string> {
  try {
    await p;
  } catch (e) {
    if (e instanceof DomainError) return e.code;
    if (e instanceof Error && e.name === 'ZodError') return 'VALIDATION_FAILED';
    throw e;
  }
  return 'OK';
}
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

function local(minutes: number): string {
  const d = new Date(Date.now() + minutes * 60_000);
  const p = Object.fromEntries(
    new Intl.DateTimeFormat('en-GB', {
      timeZone: 'Asia/Kolkata',
      year: 'numeric',
      month: '2-digit',
      day: '2-digit',
      hour: '2-digit',
      minute: '2-digit',
      hourCycle: 'h23',
    })
      .formatToParts(d)
      .map((x) => [x.type, x.value]),
  );
  return `${p.year}-${p.month}-${p.day}T${p.hour}:${p.minute}`;
}

let seq = 0;
const phone = () => `93${String(30_000_000 + ++seq * 7_219 + (process.pid % 1000)).slice(-8)}`;
async function created(by: Actor): Promise<string> {
  const r = await leads.createLead(by.ctx, {
    fullName: 'Synthetic Task Lead',
    primaryPhone: phone(),
  });
  if (r.status !== 'created') throw new Error('fixture lead');
  return r.leadId;
}
const leadRow = (id: string) => migrator().lead.findUniqueOrThrow({ where: { id } });
const taskRow = (id: string) => migrator().task.findUniqueOrThrow({ where: { id } });
const versionOf = async (id: string) => (await leadRow(id)).version;
const add = async (
  by: Actor,
  leadId: string | null,
  type: string,
  minutes = 60,
  title = `Synthetic ${type.toLowerCase()}`,
) =>
  (
    await tasks.createTask(by.ctx, leadId, {
      type,
      title,
      dueAt: local(minutes),
      // FR-104 (ADR-0017): a meeting needs an end time.
      ...(type === 'MEETING' ? { endAt: local(minutes + 30) } : {}),
    })
  ).id;
const dnc = async (by: Actor, id: string) =>
  leads.changeContactStatus(by.ctx, id, {
    toStatus: 'DO_NOT_CONTACT',
    version: await versionOf(id),
    method: 'VERBAL',
    reason: 'Synthetic: asked not to be called',
  });

let A: Org;
let B: Org;
const a = {} as Record<Role, Actor>;
let ownerB: Actor;
beforeAll(async () => {
  A = await seedOrg('TaskA');
  B = await seedOrg('TaskB');
  for (const k of ['owner', 'admin', 'manager', 'exec1', 'exec2', 'hr'] as const)
    a[k] = await actorIn(A.users[k], A.orgId);
  ownerB = await actorIn(B.users.owner, B.orgId);
});

describe('creating tasks (FR-100)', () => {
  it('adds each type on a lead for oneself, with timeline and audit, without touching the next follow-up', async () => {
    const l = await created(a.exec1);
    const ids: string[] = [];
    for (const type of ['CALL', 'MEETING', 'DOCUMENT', 'OTHER'])
      ids.push(await add(a.exec1, l, type));
    // Any number may be open (the FR-108 limit is for follow-ups): a second Call task is fine.
    ids.push(await add(a.exec1, l, 'CALL', 90, 'Synthetic second call'));
    for (const id of ids)
      expect(await taskRow(id)).toMatchObject({
        leadId: l,
        assigneeUserId: A.users.exec1.id,
        createdBy: A.users.exec1.id,
        status: 'OPEN',
        priority: 'NORMAL',
      });
    expect((await leadRow(l)).nextFollowUpAt).toBeNull();
    const activity = await migrator().leadActivity.findFirstOrThrow({
      where: { leadId: l, type: 'TASK', refId: ids[0]! },
    });
    expect(activity.summary).toMatchObject({ action: 'scheduled', taskType: 'CALL' });
    expect(
      await migrator().auditLog.count({ where: { action: 'task.scheduled', entityId: ids[1]! } }),
    ).toBe(1);

    // The lead page lists them apart from follow-ups; a follow-up can still be scheduled.
    await tasks.scheduleFollowUp(a.exec1.ctx, l, { dueAt: local(30) });
    const page = await tasks.followUpsForLead(a.exec1.ctx, l);
    expect(page.open.map((t) => t.type)).toEqual(['FOLLOW_UP']);
    expect(page.tasks.map((t) => t.id).sort()).toEqual([...ids].sort());
    expect(page.tasks.every((t) => t.canUpdate)).toBe(true);
    expect(page.canAddTask).toBe(true);
    expect(page.callBlockedReason).toBeNull();
  });

  it('adds a task with no lead for any member, HR included', async () => {
    for (const r of ['exec1', 'manager', 'hr'] as const) {
      const id = await add(a[r], null, 'DOCUMENT');
      expect(await taskRow(id)).toMatchObject({ leadId: null, assigneeUserId: A.users[r].id });
      expect(await migrator().leadActivity.count({ where: { refId: id } })).toBe(0);
      expect(
        await migrator().auditLog.count({ where: { action: 'task.scheduled', entityId: id } }),
      ).toBe(1);
    }
  });

  it('validates the type, title and time; an executive cannot name another assignee', async () => {
    const l = await created(a.exec1);
    const make = (raw: Record<string, unknown>) =>
      codeOf(
        tasks.createTask(a.exec1.ctx, l, {
          type: 'CALL',
          title: 'Synthetic',
          dueAt: local(60),
          ...raw,
        }),
      );
    expect(await make({ type: 'VISIT' })).toBe('VALIDATION_FAILED');
    expect(await make({ title: '   ' })).toBe('VALIDATION_FAILED');
    expect(await make({ title: 'x'.repeat(201) })).toBe('VALIDATION_FAILED');
    expect(await make({ dueAt: local(-30) })).toBe('VALIDATION_FAILED');
    expect(await make({ dueAt: 'not a date' })).toBe('VALIDATION_FAILED');
    expect(await make({ priority: 'CRITICAL' })).toBe('VALIDATION_FAILED');
    // FR-103: Sales Executives assign nobody (role matrix §4.3); naming oneself is fine.
    expect(await make({ assigneeUserId: A.users.exec2.id })).toBe('FORBIDDEN');
    const id = (
      await tasks.createTask(a.exec1.ctx, l, {
        type: 'OTHER',
        title: 'Synthetic',
        dueAt: local(60),
        priority: 'URGENT',
        assigneeUserId: A.users.exec1.id,
      })
    ).id;
    expect(await taskRow(id)).toMatchObject({
      assigneeUserId: A.users.exec1.id,
      priority: 'URGENT',
    });
  });

  it('refuses a lead the caller cannot change, a closed lead, HR on a lead, and other orgs', async () => {
    const l = await created(a.exec1);
    expect(await codeOf(add(a.exec2, l, 'CALL'))).toBe('NOT_FOUND');
    expect(await codeOf(add(a.hr, l, 'OTHER'))).toBe('FORBIDDEN');
    expect(await codeOf(add(ownerB, l, 'OTHER'))).toBe('NOT_FOUND');
    await leads.archiveLead(a.admin.ctx, l, { version: await versionOf(l), reason: 'Synthetic' });
    expect(await codeOf(add(a.exec1, l, 'OTHER'))).not.toBe('OK');
    const won = await created(a.exec1);
    await leads.changeStage(a.exec1.ctx, won, {
      toStage: 'LOST',
      version: String(await versionOf(won)),
      reasonCode: 'NOT_INTERESTED',
    });
    expect(await codeOf(add(a.exec1, won, 'MEETING'))).toBe('RULE_VIOLATION');
    expect(await migrator().task.count({ where: { leadId: { in: [l, won] } } })).toBe(0);
  });

  it('refuses a new Call task on a Do-Not-Contact lead (app and database), not other types', async () => {
    const l = await created(a.exec1);
    const before = await add(a.exec1, l, 'CALL');
    await dnc(a.exec1, l);
    expect(await codeOf(add(a.exec1, l, 'CALL'))).toBe('RULE_VIOLATION');
    expect(await codeOf(add(a.exec1, l, 'MEETING'))).toBe('OK');
    // Existing tasks are unchanged by the status change.
    expect(await taskRow(before)).toMatchObject({ status: 'OPEN', version: 1 });
    const page = await tasks.followUpsForLead(a.exec1.ctx, l);
    expect(page.callBlockedReason).toMatch(/Do not contact/);
    expect(page.canAddTask).toBe(true);
    expect(
      await sqlState(
        asApp(
          A,
          A.users.exec1.id,
          `INSERT INTO task (org_id, type, title, lead_id, assignee_user_id, created_by, due_at)
           VALUES ($1, 'CALL', 'Synthetic', $2, $3, $3, now() + interval '1 hour')`,
          [A.orgId, l, A.users.exec1.id],
        ),
      ),
    ).toBe('23514');
  });

  it('the database requires a title on every type but a follow-up', async () => {
    expect(
      await sqlState(
        asApp(
          A,
          A.users.exec1.id,
          `INSERT INTO task (org_id, type, assignee_user_id, created_by, due_at)
           VALUES ($1, 'OTHER', $2, $2, now() + interval '1 hour')`,
          [A.orgId, A.users.exec1.id],
        ),
      ),
    ).toBe('23514');
  });
});

describe('changing tasks (FR-102 for every type)', () => {
  it('reschedules, completes and cancels a lead task and a no-lead task, with the reason rules', async () => {
    const l = await created(a.exec1);
    const onLead = await add(a.exec1, l, 'MEETING');
    await tasks.rescheduleFollowUp(a.exec1.ctx, onLead, { dueAt: local(120), version: 1 });
    await tasks.completeFollowUp(a.exec1.ctx, onLead, { version: 2 });
    expect(await taskRow(onLead)).toMatchObject({ status: 'DONE', rescheduleCount: 1 });
    const kinds = (
      await migrator().leadActivity.findMany({
        where: { refId: onLead },
        orderBy: [{ occurredAt: 'asc' }, { id: 'asc' }],
      })
    ).map((x) => x.summary as { action: string; taskType: string });
    expect(kinds.map((k) => k.action)).toEqual(['scheduled', 'rescheduled', 'completed']);
    expect(kinds.every((k) => k.taskType === 'MEETING')).toBe(true);
    expect(await codeOf(tasks.completeFollowUp(a.exec1.ctx, onLead, { version: 3 }))).toBe(
      'RULE_VIOLATION',
    );

    const hrs = await add(a.hr, null, 'OTHER');
    await tasks.rescheduleFollowUp(a.hr.ctx, hrs, { dueAt: local(200), version: 1 });
    await tasks.rescheduleFollowUp(a.hr.ctx, hrs, { dueAt: local(300), version: 2 });
    expect(
      await codeOf(tasks.rescheduleFollowUp(a.hr.ctx, hrs, { dueAt: local(400), version: 3 })),
    ).toBe('VALIDATION_FAILED');
    expect(await codeOf(tasks.cancelFollowUp(a.hr.ctx, hrs, { reason: '', version: 3 }))).toBe(
      'VALIDATION_FAILED',
    );
    expect(await codeOf(tasks.completeFollowUp(a.hr.ctx, hrs, { version: 1 }))).toBe('CONFLICT');
    await tasks.cancelFollowUp(a.hr.ctx, hrs, { reason: 'Synthetic: not needed', version: 3 });
    expect(await taskRow(hrs)).toMatchObject({
      status: 'CANCELLED',
      cancelReason: 'Synthetic: not needed',
    });
    expect(await migrator().auditLog.count({ where: { entityId: hrs } })).toBe(4);
  });

  it('keeps a no-lead task to its assignee: others, managers, Owner of another org see nothing', async () => {
    const mine = await add(a.exec1, null, 'CALL');
    for (const who of [a.exec2, a.manager, a.hr, ownerB])
      expect(await codeOf(tasks.completeFollowUp(who.ctx, mine, { version: 1 }))).toBe('NOT_FOUND');
    // Owner and Admin have ORG task scope, as for follow-ups.
    expect(await codeOf(tasks.completeFollowUp(a.admin.ctx, mine, { version: 1 }))).toBe('OK');
    expect(await taskRow(mine)).toMatchObject({ status: 'DONE' });
  });
});

describe('lifecycle of lead tasks (owner decision: same as follow-ups)', () => {
  it('moves open lead tasks to the new owner, cancels them on a queue and on Won/Lost', async () => {
    const l = await created(a.exec1);
    const call = await add(a.exec1, l, 'CALL');
    const doc = await add(a.exec1, l, 'DOCUMENT');
    await tasks.completeFollowUp(a.exec1.ctx, doc, { version: 1 });
    await leads.assignLead(a.admin.ctx, l, {
      target: `user:${A.users.exec2.id}`,
      version: await versionOf(l),
      reason: 'Synthetic: rebalancing',
    });
    expect(await taskRow(call)).toMatchObject({ assigneeUserId: A.users.exec2.id, status: 'OPEN' });
    expect(await taskRow(doc)).toMatchObject({ assigneeUserId: A.users.exec1.id, status: 'DONE' });

    const meeting = await add(a.exec2, l, 'MEETING');
    await leads.changeStage(a.exec2.ctx, l, {
      toStage: 'LOST',
      version: String(await versionOf(l)),
      reasonCode: 'NOT_INTERESTED',
    });
    for (const id of [call, meeting])
      expect(await taskRow(id)).toMatchObject({
        status: 'CANCELLED',
        cancelReason: 'Lead marked as Lost',
      });
    const auto = await migrator().leadActivity.findFirstOrThrow({
      where: { refId: meeting, summary: { path: ['action'], equals: 'cancelled' } },
    });
    expect(auto.summary).toMatchObject({ automatic: true, taskType: 'MEETING' });
  });

  it('the database refuses Won/Lost while any task on the lead is open', async () => {
    const l = await created(a.exec1);
    await add(a.exec1, l, 'OTHER');
    expect(
      await sqlState(
        asApp(
          A,
          A.users.owner.id,
          `UPDATE lead SET stage = 'LOST', version = version + 1 WHERE id = $1`,
          [l],
        ),
      ),
    ).toBe('23514');
  });

  it('on deactivation: lead tasks go to the lead owner, no-lead tasks are cancelled', async () => {
    const org = await seedOrg('TaskDeact');
    const o = {} as Record<Role, Actor>;
    for (const k of ['owner', 'admin', 'manager', 'exec1', 'exec2', 'hr'] as const)
      o[k] = await actorIn(org.users[k], org.orgId);
    const l = await created(o.exec1);
    // The manager works on exec1's lead and has a personal task.
    await leads.assignLead(o.admin.ctx, l, {
      target: `user:${org.users.manager.id}`,
      version: await versionOf(l),
      reason: 'Synthetic: cover',
    });
    const onLead = await add(o.manager, l, 'CALL');
    await leads.assignLead(o.admin.ctx, l, {
      target: `user:${org.users.exec1.id}`,
      version: await versionOf(l),
      reason: 'Synthetic: back',
    });
    // The reassignment moved it to exec1 (workflow G).
    expect(await taskRow(onLead)).toMatchObject({ assigneeUserId: org.users.exec1.id });
    const personal = await add(o.manager, null, 'MEETING');
    const done = await add(o.manager, null, 'OTHER');
    await tasks.completeFollowUp(o.manager.ctx, done, { version: 1 });
    const hrs = await add(o.hr, null, 'DOCUMENT');

    await members.deactivateMember(o.owner.ctx, org.membership.manager!);
    expect(await taskRow(personal)).toMatchObject({
      status: 'CANCELLED',
      cancelReason: 'Assignee deactivated',
    });
    expect(await taskRow(done)).toMatchObject({ status: 'DONE' });
    expect(
      await migrator().auditLog.findFirstOrThrow({
        where: { action: 'task.cancelled', entityId: org.users.manager.id },
      }),
    ).toMatchObject({ metadata: { cancelled: 1, cause: 'DEACTIVATED', noLead: true } });

    await members.deactivateMember(o.owner.ctx, org.membership.hr!);
    expect(await taskRow(hrs)).toMatchObject({ status: 'CANCELLED' });
    expect(
      await migrator().task.count({
        where: {
          orgId: org.orgId,
          status: 'OPEN',
          assigneeUserId: { in: [org.users.manager.id, org.users.hr.id] },
        },
      }),
    ).toBe(0);
  });
});

describe('My Day with every task type', () => {
  it('lists own tasks of every type, marks no-lead ones changeable here, and later ones apart', async () => {
    const org = await seedOrg('TaskDay');
    const exec = await actorIn(org.users.exec1, org.orgId);
    const other = await actorIn(org.users.exec2, org.orgId);
    const hr = await actorIn(org.users.hr, org.orgId);
    const l = await created(exec);
    const fu = (await tasks.scheduleFollowUp(exec.ctx, l, { dueAt: local(60) })).id;
    const call = await add(exec, l, 'CALL', 90);
    const own = await add(exec, null, 'DOCUMENT', 30);
    const far = await add(exec, null, 'OTHER', 60 * 24 * 20);
    await add(other, null, 'OTHER', 30);

    const day = await tasks.myDay(exec.ctx);
    const soon = [...day.overdue, ...day.today, ...day.upcoming];
    expect(soon.map((t) => t.id).sort()).toEqual([fu, call, own].sort());
    const byId = Object.fromEntries(soon.map((t) => [t.id, t]));
    expect(byId[own]).toMatchObject({
      type: 'DOCUMENT',
      onLead: false,
      lead: null,
      canUpdate: true,
    });
    expect(byId[call]).toMatchObject({ type: 'CALL', onLead: true, canUpdate: false });
    expect(byId[call]!.lead?.id).toBe(l);
    expect(day.later.map((t) => t.id)).toEqual([far]);

    const hrsOwn = await add(hr, null, 'MEETING', 45);
    const hrDay = await tasks.myDay(hr.ctx);
    expect([...hrDay.today, ...hrDay.upcoming, ...hrDay.overdue].map((t) => t.id)).toEqual([
      hrsOwn,
    ]);
  });
});
