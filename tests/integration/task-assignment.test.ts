// FR-103 tasks for other people (migration 0021, ADR-0016). Role matrix §4.3 "task.create for
// others": Owner O, Admin O, Sales Manager T (members of the teams they lead), Executive and HR
// none. The assignee must be an active member who could work on the task (lead access for a lead
// task); the assignee is notified in the app. Every task type, follow-up rules (FR-108), DNC and
// Won/Lost rules, the lifecycle (reassignment, deactivation), the privacy of no-lead tasks
// (owner decision 2026-10-30), other orgs and the database backstop as crm_app. Synthetic data.
import { beforeAll, describe, expect, it } from 'vitest';
import * as leads from '@/modules/leads';
import * as members from '@/modules/members';
import { listNotifications, notifyForEvent } from '@/modules/notifications';
import * as tasks from '@/modules/tasks';
import * as teams from '@/modules/teams';
import { DomainError } from '@/platform/errors';
import { migrator, withRole } from '../support/db';
import { actorIn, seedOrg, type Actor } from '../support/factory';

const APP = process.env.TEST_DATABASE_URL!;
type Org = Awaited<ReturnType<typeof seedOrg>>;
type Role = 'owner' | 'admin' | 'manager' | 'exec1' | 'exec2' | 'hr';

async function failure(p: Promise<unknown>): Promise<{ code: string; fields: string[] }> {
  try {
    await p;
  } catch (e) {
    if (e instanceof DomainError) return { code: e.code, fields: Object.keys(e.fieldErrors ?? {}) };
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
const phone = () => `94${String(20_000_000 + ++seq * 5_573 + (process.pid % 1000)).slice(-8)}`;
async function created(by: Actor): Promise<string> {
  const r = await leads.createLead(by.ctx, {
    fullName: 'Synthetic Assign Lead',
    primaryPhone: phone(),
  });
  if (r.status !== 'created') throw new Error('fixture lead');
  return r.leadId;
}
const leadRow = (id: string) => migrator().lead.findUniqueOrThrow({ where: { id } });
const taskRow = (id: string) => migrator().task.findUniqueOrThrow({ where: { id } });
const versionOf = async (id: string) => (await leadRow(id)).version;
const give = (
  by: Actor,
  to: string,
  leadId: string | null,
  type = 'OTHER',
  extra: Record<string, unknown> = {},
) =>
  tasks.createTask(by.ctx, leadId, {
    type,
    title: `Synthetic ${type.toLowerCase()} for someone`,
    dueAt: local(90),
    // FR-104 (ADR-0017): a meeting needs an end time.
    ...(type === 'MEETING' ? { endAt: local(120) } : {}),
    assigneeUserId: to,
    ...extra,
  });
const events = (taskId: string) =>
  migrator().outboxEvent.findMany({
    where: { type: 'task.assigned', payload: { path: ['taskId'], equals: taskId } },
  });
/** Runs the worker step for a task's assignment event (as the worker would). */
async function deliver(org: Org, taskId: string) {
  for (const e of await events(taskId))
    await notifyForEvent({ eventId: e.id, orgId: org.orgId, type: e.type, payload: e.payload });
}

/** An org with a West team led by the manager, exec1 a member; exec2 and HR in no team. */
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
  return { org, a, west };
}
let A: Awaited<ReturnType<typeof setup>>;
let B: Awaited<ReturnType<typeof setup>>;
beforeAll(async () => {
  A = await setup('AssignA');
  B = await setup('AssignB');
});

describe('who may assign (role matrix §4.3)', () => {
  it('Owner and Admin give each task type to another member, who is notified once', async () => {
    const { a, org } = A;
    const l = await created(a.exec1);
    const ids: string[] = [];
    for (const [by, type, lead] of [
      [a.owner, 'CALL', l],
      [a.admin, 'MEETING', l],
      [a.admin, 'DOCUMENT', null],
      [a.owner, 'OTHER', null],
      [a.admin, 'FOLLOW_UP', l],
    ] as const)
      ids.push((await give(by, org.users.exec1.id, lead, type)).id);
    for (const id of ids) {
      const t = await taskRow(id);
      expect(t.assigneeUserId).toBe(org.users.exec1.id);
      expect([org.users.owner.id, org.users.admin.id]).toContain(t.createdBy);
      expect(await events(id)).toHaveLength(1);
      await deliver(org, id);
      await deliver(org, id); // redelivery is a no-op
    }
    expect((await leadRow(l)).nextFollowUpAt).toEqual((await taskRow(ids[4]!)).dueAt);
    const mine = (await listNotifications(a.exec1.ctx)).rows.filter(
      (n) => n.type === 'TASK_ASSIGNED',
    );
    expect(mine).toHaveLength(5);
    expect(mine.map((n) => n.title)).toContain('Follow-up assigned to you');
    const doc = mine.find((n) => n.body.startsWith('Document:'))!;
    expect(doc.link).toBe('/app/my-day');
    // The timeline and audit name the assignee; the assignee's My Day names who assigned it.
    const act = await migrator().leadActivity.findFirstOrThrow({ where: { refId: ids[0]! } });
    expect(act.summary).toMatchObject({ assigneeUserId: org.users.exec1.id, taskType: 'CALL' });
    const day = await tasks.myDay(a.exec1.ctx);
    const item = [...day.overdue, ...day.today, ...day.upcoming].find((t) => t.id === ids[2]);
    expect(item).toMatchObject({ assignedByName: expect.any(String), canUpdate: true });
  });

  it('Executives and HR cannot assign; nobody is notified for their own task', async () => {
    const { a, org } = A;
    const l = await created(a.exec1);
    expect(await codeOf(give(a.exec1, org.users.exec2.id, null))).toBe('FORBIDDEN');
    expect(await codeOf(give(a.exec1, org.users.manager.id, l, 'CALL'))).toBe('FORBIDDEN');
    expect(await codeOf(give(a.hr, org.users.exec1.id, null))).toBe('FORBIDDEN');
    const own = (await give(a.exec1, org.users.exec1.id, l, 'CALL')).id;
    expect(await events(own)).toHaveLength(0);
    expect(await tasks.assigneeOptions(a.exec1.ctx, null)).toEqual([]);
  });

  it('a Sales Manager assigns only to members of the teams they lead', async () => {
    const { a, org, west } = A;
    const teamLead = await created(a.exec1);
    const t = (await give(a.manager, org.users.exec1.id, teamLead, 'CALL')).id;
    expect(await taskRow(t)).toMatchObject({
      assigneeUserId: org.users.exec1.id,
      createdBy: org.users.manager.id,
    });
    expect((await give(a.manager, org.users.exec1.id, null, 'DOCUMENT')).id).toBeTruthy();
    for (const to of [org.users.exec2.id, org.users.hr.id, org.users.admin.id])
      expect(await failure(give(a.manager, to, null))).toEqual({
        code: 'VALIDATION_FAILED',
        fields: ['assigneeUserId'],
      });
    expect((await tasks.assigneeOptions(a.manager.ctx, null)).map((p) => p.userId)).toEqual([
      org.users.exec1.id,
    ]);
    // After leaving the team, exec1 can no longer be given tasks by the manager; existing tasks
    // stay with them (what should happen to them is not specified).
    const spell = await migrator().teamMembership.findFirstOrThrow({
      where: { teamId: west, membershipId: org.membership.exec1!, endedAt: null },
    });
    await teams.removeTeamMember(a.owner.ctx, spell.id);
    expect(await codeOf(give(a.manager, org.users.exec1.id, null))).toBe('VALIDATION_FAILED');
    expect(await taskRow(t)).toMatchObject({ assigneeUserId: org.users.exec1.id, status: 'OPEN' });
    await teams.addTeamMember(a.owner.ctx, {
      teamId: west,
      membershipId: org.membership.exec1!,
      teamRole: 'MEMBER',
    });
  });
});

describe('who may be given a task', () => {
  it('only an active member of the org who could work on it', async () => {
    const { a, org } = A;
    const l = await created(a.exec1);
    const refused = async (to: string, lead: string | null, type = 'OTHER') =>
      expect(await failure(give(a.admin, to, lead, type))).toEqual({
        code: 'VALIDATION_FAILED',
        fields: ['assigneeUserId'],
      });
    // A lead task needs someone who can work on that lead: not exec2 (not theirs), not HR.
    await refused(org.users.exec2.id, l, 'CALL');
    await refused(org.users.hr.id, l, 'MEETING');
    // HR may be given a no-lead task (their own tasks, ADR-0015).
    expect(await codeOf(give(a.admin, org.users.hr.id, null))).toBe('OK');
    // Another org's member, garbage, an unknown id.
    await refused(B.org.users.exec1.id, null);
    await refused('not-a-uuid', null);
    await refused('01a18433-0000-7000-8000-000000000000', null);
    // The lead page offers only people who can work on the lead.
    const offered = (await tasks.assigneeOptions(a.admin.ctx, l)).map((p) => p.userId);
    expect(offered).toContain(org.users.exec1.id);
    expect(offered).toContain(org.users.owner.id);
    expect(offered).not.toContain(org.users.exec2.id);
    expect(offered).not.toContain(org.users.hr.id);
    expect(offered).not.toContain(org.users.admin.id); // the caller is "Me"
  });

  it('never a suspended or deactivated member', async () => {
    const org = await seedOrg('AssignGone');
    const owner = await actorIn(org.users.owner, org.orgId);
    await members.suspendMember(owner.ctx, org.membership.exec1!);
    await members.deactivateMember(owner.ctx, org.membership.exec2!);
    for (const to of [org.users.exec1.id, org.users.exec2.id])
      expect(await codeOf(give(owner, to, null))).toBe('VALIDATION_FAILED');
  });

  it('another org cannot assign into this one, or see the tasks', async () => {
    const { a, org } = A;
    const l = await created(a.exec1);
    expect(await codeOf(give(B.a.owner, org.users.exec1.id, null))).toBe('VALIDATION_FAILED');
    expect(await codeOf(give(B.a.owner, B.org.users.exec1.id, l, 'CALL'))).toBe('NOT_FOUND');
    const t = (await give(a.admin, org.users.exec1.id, null)).id;
    expect(await codeOf(tasks.completeFollowUp(B.a.owner.ctx, t, { version: 1 }))).toBe(
      'NOT_FOUND',
    );
  });
});

describe('existing rules still apply to assigned tasks', () => {
  it('FR-108: one open follow-up per lead and person', async () => {
    const { a, org } = A;
    const l = await created(a.exec1);
    await tasks.scheduleFollowUp(a.exec1.ctx, l, { dueAt: local(30) });
    const r = await failure(give(a.manager, org.users.exec1.id, l, 'FOLLOW_UP'));
    expect(r.code).toBe('CONFLICT');
    // The manager may still schedule their own.
    expect(await codeOf(give(a.manager, org.users.manager.id, l, 'FOLLOW_UP'))).toBe('OK');
    expect(await codeOf(give(a.admin, org.users.exec1.id, null, 'FOLLOW_UP'))).toBe(
      'VALIDATION_FAILED',
    );
  });

  it('Do-Not-Contact refuses a Call task for anyone; Won/Lost refuses every task', async () => {
    const { a, org } = A;
    const l = await created(a.exec1);
    await leads.changeContactStatus(a.exec1.ctx, l, {
      toStatus: 'DO_NOT_CONTACT',
      version: await versionOf(l),
      method: 'VERBAL',
      reason: 'Synthetic: asked not to be called',
    });
    expect(await codeOf(give(a.admin, org.users.exec1.id, l, 'CALL'))).toBe('RULE_VIOLATION');
    expect(await codeOf(give(a.admin, org.users.exec1.id, l, 'MEETING'))).toBe('OK');
    const lost = await created(a.exec1);
    await leads.changeStage(a.exec1.ctx, lost, {
      toStage: 'LOST',
      version: String(await versionOf(lost)),
      reasonCode: 'NOT_INTERESTED',
    });
    for (const type of ['OTHER', 'FOLLOW_UP'])
      expect(await codeOf(give(a.admin, org.users.exec1.id, lost, type))).toBe('RULE_VIOLATION');
  });

  it('assigned lead tasks follow the lead; the assignee works them; no-lead ones stay private', async () => {
    const { a, org } = A;
    const l = await created(a.exec1);
    const call = (await give(a.manager, org.users.exec1.id, l, 'CALL')).id;
    const own = (await give(a.manager, org.users.exec1.id, null, 'DOCUMENT')).id;
    // The assignee reschedules and completes; the manager (team scope) can change the lead task
    // but cannot see the no-lead task they created (owner decision 2026-10-30).
    await tasks.rescheduleFollowUp(a.exec1.ctx, own, { dueAt: local(200), version: 1 });
    expect(await codeOf(tasks.completeFollowUp(a.manager.ctx, own, { version: 2 }))).toBe(
      'NOT_FOUND',
    );
    const managerDay = await tasks.myDay(a.manager.ctx);
    expect(
      [...managerDay.today, ...managerDay.upcoming, ...managerDay.later].map((t) => t.id),
    ).not.toContain(own);
    expect(await codeOf(tasks.completeFollowUp(a.admin.ctx, own, { version: 2 }))).toBe('OK');
    // Reassigning the lead moves the open task to the new owner (ADR-0010).
    await leads.assignLead(a.admin.ctx, l, {
      target: `user:${org.users.exec2.id}`,
      version: await versionOf(l),
      reason: 'Synthetic: rebalancing',
    });
    expect(await taskRow(call)).toMatchObject({
      assigneeUserId: org.users.exec2.id,
      createdBy: org.users.manager.id,
    });
    // A notification for a task that is no longer the assignee's is skipped by the worker.
    await deliver(org, call);
    const notified = (await listNotifications(a.exec1.ctx)).rows.filter(
      (n) => n.type === 'TASK_ASSIGNED' && n.link === `/app/leads/${l}`,
    );
    expect(notified).toHaveLength(0);
  });

  it('deactivation: the assignee’s no-lead tasks are cancelled; the creator leaving changes nothing', async () => {
    const s = await setup('AssignDeact');
    const l = await created(s.a.exec1);
    const forExec = (await give(s.a.manager, s.org.users.exec1.id, null)).id;
    const onLead = (await give(s.a.manager, s.org.users.exec1.id, l, 'MEETING')).id;
    const forExec2 = (await give(s.a.admin, s.org.users.exec2.id, null)).id;
    await members.deactivateMember(s.a.owner.ctx, s.org.membership.manager!);
    for (const id of [forExec, onLead]) expect(await taskRow(id)).toMatchObject({ status: 'OPEN' });
    await members.deactivateMember(s.a.owner.ctx, s.org.membership.exec2!);
    expect(await taskRow(forExec2)).toMatchObject({
      status: 'CANCELLED',
      cancelReason: 'Assignee deactivated',
    });
  });
});

describe('database backstop (crm_app, migration 0021)', () => {
  const insert = (org: Org, as: string, assignee: string) =>
    sqlState(
      asApp(
        org,
        as,
        `INSERT INTO task (org_id, type, title, assignee_user_id, created_by, due_at)
         VALUES ($1, 'OTHER', 'Synthetic', $2, $3, now() + interval '1 hour')`,
        [org.orgId, assignee, as],
      ),
    );
  it('enforces the role rule for the assignee', async () => {
    const { org } = A;
    const u = org.users;
    expect(await insert(org, u.exec1.id, u.exec1.id)).toBe('OK');
    expect(await insert(org, u.exec1.id, u.exec2.id)).toBe('42501');
    expect(await insert(org, u.hr.id, u.exec1.id)).toBe('42501');
    expect(await insert(org, u.manager.id, u.exec1.id)).toBe('OK');
    expect(await insert(org, u.manager.id, u.exec2.id)).toBe('42501');
    expect(await insert(org, u.admin.id, u.exec2.id)).toBe('OK');
    expect(await insert(org, u.admin.id, B.org.users.exec1.id)).not.toBe('OK');
    // created_by must still be the session user.
    expect(
      await sqlState(
        asApp(
          org,
          u.admin.id,
          `INSERT INTO task (org_id, type, title, assignee_user_id, created_by, due_at)
           VALUES ($1, 'OTHER', 'Synthetic', $2, $2, now() + interval '1 hour')`,
          [org.orgId, u.exec2.id],
        ),
      ),
    ).toBe('42501');
  });
});
