// Phase 3 slice 2 (migration 0013, ADR-0010): open follow-ups follow lead ownership changes
// (workflow G) and leave deactivated members (FR-077); Won/Lost leads keep none. Collisions with
// the one-open-follow-up-per-lead-and-person rule (FR-108), history preservation, atomicity,
// next_follow_up_at after each operation, other orgs and unauthorized callers, and the database
// backstops as crm_app. Synthetic data only.
import { beforeAll, describe, expect, it } from 'vitest';
import * as leads from '@/modules/leads';
import * as members from '@/modules/members';
import * as tasks from '@/modules/tasks';
import * as teams from '@/modules/teams';
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
const phone = () => `92${String(40_000_000 + ++seq * 6_917 + (process.pid % 1000)).slice(-8)}`;
async function created(by: Actor): Promise<string> {
  const r = await leads.createLead(by.ctx, {
    fullName: 'Synthetic Lifecycle',
    primaryPhone: phone(),
  });
  if (r.status !== 'created') throw new Error('fixture lead');
  return r.leadId;
}
const leadRow = (id: string) => migrator().lead.findUniqueOrThrow({ where: { id } });
const taskRow = (id: string) => migrator().task.findUniqueOrThrow({ where: { id } });
const versionOf = async (id: string) => (await leadRow(id)).version;
const schedule = async (by: Actor, leadId: string, minutes: number) =>
  (await tasks.scheduleFollowUp(by.ctx, leadId, { dueAt: local(minutes) })).id;
const reassign = async (by: Actor, leadId: string, target: string) =>
  leads.assignLead(by.ctx, leadId, {
    target,
    version: await versionOf(leadId),
    reason: 'Synthetic: rebalancing',
  });
const openOn = (leadId: string) =>
  migrator().task.findMany({
    where: { leadId, status: 'OPEN' },
    orderBy: { dueAt: 'asc' },
    select: { id: true, assigneeUserId: true, dueAt: true },
  });

/** An org with a West team led by the manager (exec1 a member) and actors for every role. */
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
  A = await setup('LifeA');
  B = await setup('LifeB');
});

describe('reassignment (workflow G)', () => {
  it("moves the previous owner's open follow-up to the new owner; others' stay; history kept", async () => {
    const { a, org } = A;
    const l = await created(a.exec1);
    const execTask = await schedule(a.exec1, l, 60);
    const adminTask = await schedule(a.admin, l, 30);
    const done = await schedule(a.manager, l, 90);
    await tasks.completeFollowUp(a.manager.ctx, done, { version: 1 });
    const doneBefore = await taskRow(done);
    const nextBefore = (await leadRow(l)).nextFollowUpAt;

    await reassign(a.admin, l, `user:${org.users.exec2.id}`);

    expect(await taskRow(execTask)).toMatchObject({
      assigneeUserId: org.users.exec2.id,
      status: 'OPEN',
      version: 2,
      createdBy: org.users.exec1.id,
    });
    expect(await taskRow(adminTask)).toMatchObject({
      assigneeUserId: org.users.admin.id,
      version: 1,
    });
    expect(await taskRow(done)).toEqual(doneBefore);
    expect((await leadRow(l)).nextFollowUpAt).toEqual(nextBefore);
    const entry = await migrator().leadActivity.findFirstOrThrow({
      where: { refId: execTask, summary: { path: ['action'], equals: 'handed_over' } },
    });
    expect(entry.summary).toMatchObject({
      fromUserId: org.users.exec1.id,
      toUserId: org.users.exec2.id,
      cause: 'REASSIGNED',
    });
    expect(
      await migrator().auditLog.findFirstOrThrow({
        where: { action: 'task.handed_over', entityId: l },
      }),
    ).toMatchObject({ actorUserId: org.users.admin.id });
    // The new owner can now work the follow-up; the previous owner no longer sees the lead.
    await tasks.rescheduleFollowUp(a.exec2.ctx, execTask, { dueAt: local(120), version: 2 });
    expect(await codeOf(tasks.followUpsForLead(a.exec1.ctx, l))).toBe('NOT_FOUND');
  });

  it('cancels the previous owner’s follow-up with a reason when the lead goes to a queue', async () => {
    const { a, west } = A;
    const l = await created(a.exec1);
    const execTask = await schedule(a.exec1, l, 20);
    const adminTask = await schedule(a.admin, l, 80);
    await reassign(a.admin, l, `team:${west}`);
    expect(await taskRow(execTask)).toMatchObject({
      status: 'CANCELLED',
      cancelReason: 'Lead moved to a queue without an owner',
    });
    expect((await leadRow(l)).nextFollowUpAt).toEqual((await taskRow(adminTask)).dueAt);
    expect((await openOn(l)).map((t) => t.id)).toEqual([adminTask]);
  });

  it('keeps the new owner’s own follow-up on a collision and cancels the incoming one', async () => {
    const { a, org } = A;
    const l = await created(a.exec1); // team West: the manager can work it
    const execTask = await schedule(a.exec1, l, 40);
    const managerTask = await schedule(a.manager, l, 100);
    await reassign(a.admin, l, `user:${org.users.manager.id}`);
    expect(await taskRow(managerTask)).toMatchObject({ status: 'OPEN', version: 1 });
    expect(await taskRow(execTask)).toMatchObject({
      status: 'CANCELLED',
      cancelReason: 'Lead reassigned: the new owner already had an open follow-up',
    });
    const open = await openOn(l);
    expect(open.map((t) => t.assigneeUserId)).toEqual([org.users.manager.id]);
    expect((await leadRow(l)).nextFollowUpAt).toEqual((await taskRow(managerTask)).dueAt);
  });

  it('applies to bulk assignment; a team change that keeps the owner leaves follow-ups alone', async () => {
    const { a, org, west } = A;
    const l1 = await created(a.exec1);
    const l2 = await created(a.exec1);
    const t1 = await schedule(a.exec1, l1, 60);
    const t2 = await schedule(a.exec1, l2, 70);
    await leads.bulkChangeTeam(a.admin.ctx, { leadIds: [l1], teamId: west });
    expect(await taskRow(t1)).toMatchObject({ assigneeUserId: org.users.exec1.id, version: 1 });
    await leads.bulkAssign(a.admin.ctx, {
      leadIds: [l1, l2],
      target: `user:${org.users.exec2.id}`,
      reason: 'Synthetic: bulk',
    });
    for (const t of [t1, t2])
      expect(await taskRow(t)).toMatchObject({
        assigneeUserId: org.users.exec2.id,
        status: 'OPEN',
      });
  });

  it('changes nothing when the reassignment fails or is not allowed', async () => {
    const { a, org } = A;
    const l = await created(a.exec1);
    const t = await schedule(a.exec1, l, 60);
    const stale = (await versionOf(l)) + 5;
    expect(
      await codeOf(
        leads.assignLead(a.admin.ctx, l, {
          target: `user:${org.users.exec2.id}`,
          version: stale,
          reason: 'Synthetic',
        }),
      ),
    ).toBe('CONFLICT');
    expect(await codeOf(reassign(a.exec1, l, `user:${org.users.exec2.id}`))).toBe('FORBIDDEN');
    expect(await codeOf(reassign(B.a.owner, l, `user:${B.org.users.exec2.id}`))).toBe('NOT_FOUND');
    expect(await codeOf(reassign(a.admin, l, `user:${B.org.users.exec2.id}`))).not.toBe('OK');
    expect(await taskRow(t)).toMatchObject({ assigneeUserId: org.users.exec1.id, version: 1 });
    expect((await leadRow(l)).ownerUserId).toBe(org.users.exec1.id);
  });
});

describe('deactivation (FR-077)', () => {
  it('hands every open follow-up of the departing member over, then deactivates', async () => {
    const D = await setup('LifeDeact');
    const { a, org, west } = D;
    const u = org.users;
    // The manager owns one lead, works exec1's leads (team West) and a queued West lead.
    const managersLead = await created(a.manager);
    const onOwn = await schedule(a.manager, managersLead, 30);
    const execsLead = await created(a.exec1);
    const history = await schedule(a.manager, execsLead, 10);
    await tasks.completeFollowUp(a.manager.ctx, history, { version: 1 });
    const historyBefore = await taskRow(history);
    const onExecs = await schedule(a.manager, execsLead, 50);
    const collideLead = await created(a.exec1);
    const execOwn = await schedule(a.exec1, collideLead, 70);
    const collides = await schedule(a.manager, collideLead, 20);
    const queued = await created(a.exec1);
    await reassign(a.admin, queued, `team:${west}`);
    const onQueued = await schedule(a.manager, queued, 90);

    await members.deactivateMember(a.owner.ctx, org.membership.manager!, `user:${u.exec2.id}`);

    expect(await taskRow(onOwn)).toMatchObject({ assigneeUserId: u.exec2.id, status: 'OPEN' });
    expect((await leadRow(managersLead)).ownerUserId).toBe(u.exec2.id);
    expect(await taskRow(onExecs)).toMatchObject({ assigneeUserId: u.exec1.id, status: 'OPEN' });
    expect(await taskRow(collides)).toMatchObject({
      status: 'CANCELLED',
      cancelReason: 'Assignee deactivated: the lead owner already had an open follow-up',
    });
    expect(await taskRow(execOwn)).toMatchObject({ status: 'OPEN', version: 1 });
    expect(await taskRow(onQueued)).toMatchObject({
      status: 'CANCELLED',
      cancelReason: 'Assignee deactivated and the lead has no active owner',
    });
    expect(await taskRow(history)).toEqual(historyBefore);
    expect(
      await migrator().task.count({ where: { assigneeUserId: u.manager.id, status: 'OPEN' } }),
    ).toBe(0);
    expect(
      (await migrator().member.findUniqueOrThrow({ where: { id: org.membership.manager! } }))
        .status,
    ).toBe('DEACTIVATED');
    expect((await leadRow(collideLead)).nextFollowUpAt).toEqual((await taskRow(execOwn)).dueAt);
    expect((await leadRow(execsLead)).nextFollowUpAt).toEqual((await taskRow(onExecs)).dueAt);
    expect((await leadRow(queued)).nextFollowUpAt).toBeNull();

    // A follow-up cannot be handed to the deactivated member afterwards (database rule).
    expect(
      await sqlState(
        asApp(
          org,
          u.owner.id,
          'UPDATE task SET assignee_user_id = $2, version = version + 1 WHERE id = $1',
          [execOwn, u.manager.id],
        ),
      ),
    ).toBe('23514');
  });

  it('hands over follow-ups of a member who owns no open leads, without a handover choice', async () => {
    const D = await setup('LifeDeact2');
    const { a, org } = D;
    const l = await created(a.exec1);
    const adminTask = await schedule(a.admin, l, 45);
    await members.deactivateMember(a.owner.ctx, org.membership.admin!);
    expect(await taskRow(adminTask)).toMatchObject({
      assigneeUserId: org.users.exec1.id,
      status: 'OPEN',
    });
  });

  it('changes nothing when the deactivation is refused or not allowed', async () => {
    const D = await setup('LifeDeact3');
    const { a, org } = D;
    const l = await created(a.exec1);
    const t = await schedule(a.exec1, l, 60);
    // Owns an open lead and no handover was chosen.
    expect(await codeOf(members.deactivateMember(a.owner.ctx, org.membership.exec1!))).toBe(
      'RULE_VIOLATION',
    );
    expect(
      await codeOf(
        members.deactivateMember(
          a.manager.ctx,
          org.membership.exec1!,
          `user:${org.users.exec2.id}`,
        ),
      ),
    ).toBe('FORBIDDEN');
    expect(
      await codeOf(
        members.deactivateMember(
          B.a.owner.ctx,
          org.membership.exec1!,
          `user:${B.org.users.exec2.id}`,
        ),
      ),
    ).toBe('NOT_FOUND');
    expect(await taskRow(t)).toMatchObject({ assigneeUserId: org.users.exec1.id, version: 1 });
    expect(
      (await migrator().member.findUniqueOrThrow({ where: { id: org.membership.exec1! } })).status,
    ).toBe('ACTIVE');
    // The database refuses a deactivation that would leave open tasks behind.
    expect(
      await sqlState(
        asApp(
          org,
          org.users.owner.id,
          `UPDATE organization_membership SET status = 'DEACTIVATED' WHERE id = $1`,
          [org.membership.exec1!],
        ),
      ),
    ).toBe('23514');
  });
});

describe('Won and Lost', () => {
  it('cancels every open follow-up when a lead is lost, keeping closed history', async () => {
    const { a } = A;
    const l = await created(a.exec1);
    const mine = await schedule(a.exec1, l, 60);
    const admins = await schedule(a.admin, l, 30);
    const managers = await schedule(a.manager, l, 90);
    await tasks.cancelFollowUp(a.manager.ctx, managers, {
      reason: 'Synthetic: earlier',
      version: 1,
    });
    const managers2 = await schedule(a.manager, l, 120);
    await tasks.completeFollowUp(a.manager.ctx, managers2, { version: 1 });
    const closedBefore = [await taskRow(managers), await taskRow(managers2)];

    await leads.changeStage(a.exec1.ctx, l, {
      toStage: 'LOST',
      version: String(await versionOf(l)),
      reasonCode: 'NOT_INTERESTED',
    });

    expect((await leadRow(l)).stage).toBe('LOST');
    for (const t of [mine, admins])
      expect(await taskRow(t)).toMatchObject({
        status: 'CANCELLED',
        cancelReason: 'Lead marked as Lost',
      });
    expect([await taskRow(managers), await taskRow(managers2)]).toEqual(closedBefore);
    expect((await leadRow(l)).nextFollowUpAt).toBeNull();
    expect(
      await migrator().leadActivity.count({
        where: { leadId: l, summary: { path: ['reason'], equals: 'Lead marked as Lost' } },
      }),
    ).toBe(2);
    expect(
      await migrator().auditLog.findFirstOrThrow({
        where: { action: 'task.cancelled', entityId: l },
      }),
    ).toMatchObject({ metadata: { cancelled: 2, cause: 'LEAD_LOST' } });

    // Reopening does not revive them; a new follow-up can be scheduled.
    await leads.changeStage(a.manager.ctx, l, {
      toStage: 'CONTACTED',
      version: String(await versionOf(l)),
      reasonText: 'Synthetic: customer called back',
    });
    expect(await taskRow(mine)).toMatchObject({ status: 'CANCELLED' });
    await schedule(a.exec1, l, 60);
  });

  it('cancels a handed-over follow-up when an Admin marks the lead lost', async () => {
    const { a, org } = A;
    const l = await created(a.admin);
    await reassign(a.admin, l, `user:${org.users.admin.id}`); // unchanged owner: a no-op
    const t = await schedule(a.admin, l, 60);
    await reassign(a.admin, l, `user:${org.users.exec2.id}`);
    expect(await taskRow(t)).toMatchObject({ assigneeUserId: org.users.exec2.id, status: 'OPEN' });
    await leads.changeStage(a.admin.ctx, l, {
      toStage: 'LOST',
      version: String(await versionOf(l)),
      reasonCode: 'NOT_INTERESTED',
    });
    expect(await taskRow(t)).toMatchObject({
      status: 'CANCELLED',
      cancelReason: 'Lead marked as Lost',
    });
    expect((await leadRow(l)).stage).toBe('LOST');
  });

  it('cancels the open follow-up when a lead is won', async () => {
    const { a } = A;
    const l = await created(a.exec1);
    await migrator().lead.update({ where: { id: l }, data: { stage: 'NEGOTIATION' } });
    const t = await schedule(a.exec1, l, 60);
    await leads.changeStage(a.exec1.ctx, l, {
      toStage: 'WON',
      version: String(await versionOf(l)),
    });
    expect(await taskRow(t)).toMatchObject({
      status: 'CANCELLED',
      cancelReason: 'Lead marked as Won',
    });
    expect((await leadRow(l)).nextFollowUpAt).toBeNull();
    expect(await codeOf(schedule(a.exec1, l, 60))).toBe('RULE_VIOLATION');
  });

  it('changes nothing when the stage change fails', async () => {
    const { a } = A;
    const l = await created(a.exec1);
    const t = await schedule(a.exec1, l, 60);
    const v = await versionOf(l);
    const lost = (by: Actor, version: number, reasonCode?: string) =>
      leads.changeStage(by.ctx, l, {
        toStage: 'LOST',
        version: String(version),
        ...(reasonCode ? { reasonCode } : {}),
      });
    expect(await codeOf(lost(a.exec1, v + 5, 'NOT_INTERESTED'))).toBe('CONFLICT');
    expect(await codeOf(lost(a.exec1, v))).toBe('VALIDATION_FAILED'); // no lost reason
    expect(await codeOf(lost(a.exec2, v, 'NOT_INTERESTED'))).toBe('NOT_FOUND');
    expect(await codeOf(lost(B.a.owner, v, 'NOT_INTERESTED'))).toBe('NOT_FOUND');
    expect(await taskRow(t)).toMatchObject({ status: 'OPEN', version: 1 });
    expect((await leadRow(l)).stage).toBe('ASSIGNED');
    expect((await leadRow(l)).nextFollowUpAt).toEqual((await taskRow(t)).dueAt);
  });

  it('is enforced by the database: no Won/Lost lead with an open follow-up', async () => {
    const { a, org } = A;
    const l = await created(a.exec1);
    await schedule(a.exec1, l, 60);
    expect(
      await sqlState(
        asApp(
          org,
          org.users.owner.id,
          `UPDATE lead SET stage = 'LOST', version = version + 1 WHERE id = $1`,
          [l],
        ),
      ),
    ).toBe('23514');
    const lost = await created(a.exec1);
    await leads.changeStage(a.exec1.ctx, lost, {
      toStage: 'LOST',
      version: String(await versionOf(lost)),
      reasonCode: 'NOT_INTERESTED',
    });
    expect(
      await sqlState(
        asApp(
          org,
          org.users.owner.id,
          `INSERT INTO task (org_id, lead_id, assignee_user_id, created_by, due_at)
           VALUES ($1, $2, $3, $3, now() + interval '1 day')`,
          [org.orgId, lost, org.users.owner.id],
        ),
      ),
    ).toBe('23514');
  });
});
