// Phase 3 first slice (migration 0012): lead follow-ups. FR-100 (task base), FR-102 (complete,
// cancel with reason, reschedule with a reason after two reschedules or when overdue), FR-108
// (one open follow-up per lead and assignee; lead.next_follow_up_at = earliest open follow-up,
// in the same transaction). Scope per user-personas-and-roles §4.3, other orgs, invalid input and
// transitions, the database guards as crm_app, and merge moving open follow-ups.
// Synthetic data only.
import { beforeAll, describe, expect, it } from 'vitest';
import * as leads from '@/modules/leads';
import * as tasks from '@/modules/tasks';
import * as teams from '@/modules/teams';
import { DomainError } from '@/platform/errors';
import { migrator, withRole } from '../support/db';
import { actorIn, seedOrg, type Actor } from '../support/factory';

const APP = process.env.TEST_DATABASE_URL!;
type Org = Awaited<ReturnType<typeof seedOrg>>;
let A: Org;
let B: Org;
const a = {} as Record<'owner' | 'admin' | 'manager' | 'exec1' | 'exec2' | 'hr', Actor>;
let ownerB: Actor;

async function failure(p: Promise<unknown>): Promise<{ code: string; fields: string[] }> {
  try {
    await p;
  } catch (e) {
    if (e instanceof DomainError)
      return { code: e.code, fields: Object.keys(e.fieldErrors ?? {}).sort() };
    if (e instanceof Error && e.name === 'ZodError') {
      const issues = (e as unknown as { issues: { path: PropertyKey[] }[] }).issues;
      return {
        code: 'VALIDATION_FAILED',
        fields: [...new Set(issues.map((i) => i.path.join('.')))].sort(),
      };
    }
    throw e;
  }
  return { code: 'OK', fields: [] };
}
const codeOf = async (p: Promise<unknown>) => (await failure(p)).code;

/** SQLSTATE of a failure as crm_app, or 'OK'. */
async function sqlState(p: Promise<unknown>): Promise<string> {
  try {
    await p;
    return 'OK';
  } catch (e) {
    return (e as { code?: string }).code ?? 'ERR';
  }
}

/** One statement as crm_app in a tenant transaction, the way withTenant() connects. */
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

/** "YYYY-MM-DDTHH:MM" in Asia/Kolkata (the org's time zone) `minutes` from now. */
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
/** The instant a local() string stands for (IST is UTC+05:30, no DST). */
const instant = (s: string) => new Date(`${s}:00+05:30`);

let seq = 0;
const phone = () => `93${String(30_000_000 + ++seq * 7_919 + (process.pid % 1000)).slice(-8)}`;
async function created(by: Actor, name = 'Synthetic Follow'): Promise<string> {
  const r = await leads.createLead(by.ctx, { fullName: name, primaryPhone: phone() });
  if (r.status !== 'created') throw new Error('fixture lead');
  return r.leadId;
}
const leadRow = (id: string) => migrator().lead.findUniqueOrThrow({ where: { id } });
const taskRow = (id: string) => migrator().task.findUniqueOrThrow({ where: { id } });
const nextOf = async (id: string) => (await leadRow(id)).nextFollowUpAt;
const schedule = (by: Actor, leadId: string, minutes: number, extra: object = {}) =>
  tasks.scheduleFollowUp(by.ctx, leadId, { dueAt: local(minutes), ...extra });

beforeAll(async () => {
  A = await seedOrg('FollowA');
  B = await seedOrg('FollowB');
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
});

describe('scheduling and viewing', () => {
  it('schedules a follow-up on the right lead, sets its next follow-up, timeline and audit', async () => {
    const l1 = await created(a.exec1);
    const other = await created(a.exec1);
    const due = local(60);
    const { id } = await tasks.scheduleFollowUp(a.exec1.ctx, l1, {
      dueAt: due,
      title: '  Call back   about the 2 BHK  ',
      priority: 'HIGH',
    });
    const t = await taskRow(id);
    expect(t).toMatchObject({
      orgId: A.orgId,
      leadId: l1,
      type: 'FOLLOW_UP',
      status: 'OPEN',
      assigneeUserId: A.users.exec1.id,
      createdBy: A.users.exec1.id,
      title: 'Call back about the 2 BHK',
      priority: 'HIGH',
      rescheduleCount: 0,
      version: 1,
    });
    expect(t.dueAt).toEqual(instant(due));
    expect(await nextOf(l1)).toEqual(instant(due));
    expect(await nextOf(other)).toBeNull();

    const view = await tasks.followUpsForLead(a.exec1.ctx, l1);
    expect(view.nextFollowUpAt).toEqual(instant(due));
    expect(view.open.map((f) => f.id)).toEqual([id]);
    expect(view.open[0]).toMatchObject({ canUpdate: true, overdue: false });
    expect(view).toMatchObject({ canSchedule: false, hasOwnOpen: true });
    expect((await tasks.followUpsForLead(a.exec1.ctx, other)).open).toEqual([]);

    const activity = await migrator().leadActivity.findFirstOrThrow({
      where: { leadId: l1, type: 'TASK' },
    });
    expect(activity).toMatchObject({ actorId: A.users.exec1.id, refType: 'task', refId: id });
    expect(activity.summary).toMatchObject({ action: 'scheduled', priority: 'HIGH' });
    expect(
      await migrator().auditLog.count({ where: { action: 'task.scheduled', entityId: id } }),
    ).toBe(1);
  });

  it('allows one open follow-up per lead and assignee (FR-108 primary)', async () => {
    const l = await created(a.exec1);
    await schedule(a.exec1, l, 60);
    expect(await codeOf(schedule(a.exec1, l, 120))).toBe('CONFLICT');
    // Another person may have their own open follow-up on the same lead.
    await schedule(a.admin, l, 90);
    expect(await migrator().task.count({ where: { leadId: l, status: 'OPEN' } })).toBe(2);
  });

  it('ignores an org or creator supplied with the input; an executive names no other assignee', async () => {
    const l = await created(a.exec1);
    // FR-103 (ADR-0016): only task.assign holders (Owner, Admin, Sales Manager) may name someone else.
    expect(
      await failure(
        tasks.scheduleFollowUp(a.exec1.ctx, l, {
          dueAt: local(45),
          assigneeUserId: A.users.exec2.id,
        }),
      ),
    ).toMatchObject({ code: 'FORBIDDEN' });
    const { id } = await tasks.scheduleFollowUp(a.exec1.ctx, l, {
      dueAt: local(45),
      orgId: B.orgId,
      createdBy: A.users.owner.id,
    });
    expect(await taskRow(id)).toMatchObject({
      orgId: A.orgId,
      assigneeUserId: A.users.exec1.id,
      createdBy: A.users.exec1.id,
    });
  });

  it('refuses invalid date and time input', async () => {
    const l = await created(a.exec1);
    for (const dueAt of ['', 'tomorrow', '2026-02-30T10:00', '2026-13-01T10:00', local(-30)])
      expect(await failure(tasks.scheduleFollowUp(a.exec1.ctx, l, { dueAt }))).toEqual({
        code: 'VALIDATION_FAILED',
        fields: ['dueAt'],
      });
    expect(await failure(schedule(a.exec1, l, 60 * 24 * 800))).toEqual({
      code: 'VALIDATION_FAILED',
      fields: ['dueAt'],
    });
    expect(await codeOf(schedule(a.exec1, l, 60, { priority: 'CRITICAL' }))).toBe(
      'VALIDATION_FAILED',
    );
    expect(await migrator().task.count({ where: { leadId: l } })).toBe(0);
  });
});

describe('next follow-up (FR-108)', () => {
  it('is the earliest open follow-up of any assignee, recomputed on every change', async () => {
    const l = await created(a.exec1); // exec1-owned, team West
    const mine = await schedule(a.exec1, l, 60);
    const admins = await schedule(a.admin, l, 30);
    const managers = await schedule(a.manager, l, 90);
    expect(await nextOf(l)).toEqual((await taskRow(admins.id)).dueAt);

    await tasks.completeFollowUp(a.admin.ctx, admins.id, { version: 1 });
    expect(await nextOf(l)).toEqual((await taskRow(mine.id)).dueAt);

    await tasks.rescheduleFollowUp(a.exec1.ctx, mine.id, { dueAt: local(200), version: 1 });
    expect(await nextOf(l)).toEqual((await taskRow(managers.id)).dueAt);

    await tasks.cancelFollowUp(a.manager.ctx, managers.id, {
      reason: 'Synthetic: covered by the exec',
      version: 1,
    });
    expect(await nextOf(l)).toEqual(instant(local(200)));

    await tasks.completeFollowUp(a.exec1.ctx, mine.id, { version: 2 });
    expect(await nextOf(l)).toBeNull();
    const view = await tasks.followUpsForLead(a.owner.ctx, l);
    expect(view.open).toEqual([]);
    expect(view.recentClosed.map((t) => t.status).sort()).toEqual(['CANCELLED', 'DONE', 'DONE']);
  });

  it('includes an overdue follow-up', async () => {
    const l = await created(a.exec2);
    await overdueFor(a.exec2, l, 120);
    await schedule(a.admin, l, 60);
    const next = await nextOf(l);
    expect(next!.getTime()).toBeLessThan(Date.now());
    const view = await tasks.followUpsForLead(a.exec2.ctx, l);
    expect(view.open.find((t) => t.assigneeUserId === A.users.exec2.id)).toMatchObject({
      overdue: true,
      rescheduleNeedsReason: true,
    });
  });
});

/** An open follow-up already `minutesAgo` overdue (inserted as the schema owner). */
async function overdueFor(by: Actor, leadId: string, minutesAgo: number): Promise<string> {
  const t = await migrator().task.create({
    data: {
      orgId: A.orgId,
      type: 'FOLLOW_UP',
      leadId,
      assigneeUserId: by.user.id,
      createdBy: by.user.id,
      dueAt: new Date(Date.now() - minutesAgo * 60_000),
    },
  });
  return t.id;
}

describe('reschedule, complete and cancel (FR-102)', () => {
  it('needs a reason from the third reschedule on, and counts reschedules', async () => {
    const l = await created(a.exec1);
    const { id } = await schedule(a.exec1, l, 60);
    await tasks.rescheduleFollowUp(a.exec1.ctx, id, { dueAt: local(70), version: 1 });
    await tasks.rescheduleFollowUp(a.exec1.ctx, id, { dueAt: local(80), version: 2 });
    expect(
      await failure(tasks.rescheduleFollowUp(a.exec1.ctx, id, { dueAt: local(90), version: 3 })),
    ).toEqual({ code: 'VALIDATION_FAILED', fields: ['reason'] });
    await tasks.rescheduleFollowUp(a.exec1.ctx, id, {
      dueAt: local(90),
      reason: 'Synthetic: customer travelling',
      version: 3,
    });
    expect(await taskRow(id)).toMatchObject({ rescheduleCount: 3, version: 4, status: 'OPEN' });
    const last = await migrator().leadActivity.findFirstOrThrow({
      where: { refId: id, type: 'TASK' },
      orderBy: { occurredAt: 'desc' },
    });
    expect(last.summary).toMatchObject({
      action: 'rescheduled',
      rescheduleCount: 3,
      reason: 'Synthetic: customer travelling',
    });
  });

  it('needs a reason to reschedule an overdue follow-up', async () => {
    const l = await created(a.exec2);
    const id = await overdueFor(a.exec2, l, 30);
    expect(
      await failure(tasks.rescheduleFollowUp(a.exec2.ctx, id, { dueAt: local(60), version: 1 })),
    ).toEqual({ code: 'VALIDATION_FAILED', fields: ['reason'] });
    await tasks.rescheduleFollowUp(a.exec2.ctx, id, {
      dueAt: local(60),
      reason: 'Synthetic: missed, calling tomorrow',
      version: 1,
    });
    expect(await nextOf(l)).toEqual(instant(local(60)));
  });

  it('refuses the same time, a past time and an invalid time', async () => {
    const l = await created(a.exec1);
    const due = local(60);
    const { id } = await tasks.scheduleFollowUp(a.exec1.ctx, l, { dueAt: due });
    for (const dueAt of [due, local(-10), 'soon'])
      expect(
        await failure(tasks.rescheduleFollowUp(a.exec1.ctx, id, { dueAt, version: 1 })),
      ).toEqual({ code: 'VALIDATION_FAILED', fields: ['dueAt'] });
    expect(await taskRow(id)).toMatchObject({ rescheduleCount: 0, version: 1 });
  });

  it('refuses changes to a closed follow-up and stale versions', async () => {
    const l = await created(a.exec1);
    const done = await schedule(a.exec1, l, 60);
    expect(await codeOf(tasks.completeFollowUp(a.exec1.ctx, done.id, { version: 2 }))).toBe(
      'CONFLICT',
    );
    await tasks.completeFollowUp(a.exec1.ctx, done.id, { version: 1 });
    expect(await taskRow(done.id)).toMatchObject({ status: 'DONE', version: 2 });
    expect((await taskRow(done.id)).completedAt).not.toBeNull();
    // One at a time: each call starts only when the previous one was awaited (no unhandled
    // rejections from calls running in parallel).
    for (const attempt of [
      () => tasks.completeFollowUp(a.exec1.ctx, done.id, { version: 2 }),
      () => tasks.cancelFollowUp(a.exec1.ctx, done.id, { reason: 'Synthetic', version: 2 }),
      () => tasks.rescheduleFollowUp(a.exec1.ctx, done.id, { dueAt: local(90), version: 2 }),
    ])
      expect(await codeOf(attempt())).toBe('RULE_VIOLATION');

    const open = await schedule(a.exec1, l, 60);
    expect(
      await failure(tasks.cancelFollowUp(a.exec1.ctx, open.id, { reason: '   ', version: 1 })),
    ).toEqual({ code: 'VALIDATION_FAILED', fields: ['reason'] });
    await tasks.cancelFollowUp(a.exec1.ctx, open.id, {
      reason: 'Synthetic: lead asked not to call',
      version: 1,
    });
    expect(await taskRow(open.id)).toMatchObject({
      status: 'CANCELLED',
      cancelReason: 'Synthetic: lead asked not to call',
      completedAt: null,
    });
    expect(await codeOf(tasks.completeFollowUp(a.exec1.ctx, open.id, { version: 2 }))).toBe(
      'RULE_VIOLATION',
    );
    // A new follow-up may be scheduled once the old one is closed.
    await schedule(a.exec1, l, 120);
  });

  it('refuses follow-ups on archived and closed leads', async () => {
    const archived = await created(a.exec1);
    const open = await schedule(a.exec1, archived, 60);
    await leads.archiveLead(a.admin.ctx, archived, {
      version: (await leadRow(archived)).version,
    });
    expect(await codeOf(schedule(a.admin, archived, 60))).toBe('RULE_VIOLATION');
    // Archived leads are read-only (FR-061): their follow-ups wait for a restore.
    for (const who of [a.exec1, a.admin])
      expect(await codeOf(tasks.completeFollowUp(who.ctx, open.id, { version: 1 }))).toBe(
        'RULE_VIOLATION',
      );
    expect((await tasks.followUpsForLead(a.exec1.ctx, archived)).open[0]?.canUpdate).toBe(false);

    const lost = await created(a.exec1);
    await leads.changeStage(a.exec1.ctx, lost, {
      toStage: 'LOST',
      version: String((await leadRow(lost)).version),
      reasonCode: 'NOT_INTERESTED',
    });
    expect(await codeOf(schedule(a.exec1, lost, 60))).toBe('RULE_VIOLATION');
    expect((await tasks.followUpsForLead(a.exec1.ctx, lost)).scheduleBlockedReason).toMatch(
      /closed/,
    );
  });
});

describe('authorization and isolation (§4.3)', () => {
  let l1: string; // exec1's lead, team West
  let execTask: string;
  let adminTask: string;
  beforeAll(async () => {
    l1 = await created(a.exec1);
    execTask = (await schedule(a.exec1, l1, 60)).id;
    adminTask = (await schedule(a.admin, l1, 30)).id;
  });

  it('keeps another executive out of the lead and its follow-ups', async () => {
    expect(await codeOf(tasks.followUpsForLead(a.exec2.ctx, l1))).toBe('NOT_FOUND');
    expect(await codeOf(schedule(a.exec2, l1, 60))).toBe('NOT_FOUND');
    for (const attempt of [
      () => tasks.completeFollowUp(a.exec2.ctx, execTask, { version: 1 }),
      () => tasks.cancelFollowUp(a.exec2.ctx, execTask, { reason: 'x', version: 1 }),
      () => tasks.rescheduleFollowUp(a.exec2.ctx, execTask, { dueAt: local(99), version: 1 }),
    ])
      expect(await codeOf(attempt())).toBe('NOT_FOUND');
  });

  it("shows an executive only their own follow-ups, but the lead's next date from all", async () => {
    const view = await tasks.followUpsForLead(a.exec1.ctx, l1);
    expect(view.open.map((t) => t.id)).toEqual([execTask]);
    expect(view.nextFollowUpAt).toEqual((await taskRow(adminTask)).dueAt);
    expect(await codeOf(tasks.completeFollowUp(a.exec1.ctx, adminTask, { version: 1 }))).toBe(
      'NOT_FOUND',
    );
  });

  it("lets a team lead see and update follow-ups on the team's leads; Owner/Admin see all", async () => {
    const view = await tasks.followUpsForLead(a.manager.ctx, l1);
    expect(view.open.map((t) => t.id).sort()).toEqual([execTask, adminTask].sort());
    expect(view.open.every((t) => t.canUpdate)).toBe(true);
    const own = await created(a.exec2); // exec2 is not in West
    await schedule(a.exec2, own, 60);
    expect(await codeOf(tasks.followUpsForLead(a.manager.ctx, own))).toBe('NOT_FOUND');
    expect((await tasks.followUpsForLead(a.owner.ctx, own)).open).toHaveLength(1);
    await tasks.rescheduleFollowUp(a.manager.ctx, execTask, { dueAt: local(75), version: 1 });
    expect(await taskRow(execTask)).toMatchObject({ version: 2, rescheduleCount: 1 });
  });

  it('gives HR no follow-ups', async () => {
    // HR has no lead grants. Since FR-100's no-lead tasks (ADR-0015) they hold task grants for
    // their own tasks only, so someone else's follow-up is simply not found.
    expect(await codeOf(tasks.followUpsForLead(a.hr.ctx, l1))).toBe('FORBIDDEN');
    expect(await codeOf(schedule(a.hr, l1, 60))).toBe('FORBIDDEN');
    expect(await codeOf(tasks.completeFollowUp(a.hr.ctx, execTask, { version: 2 }))).toBe(
      'NOT_FOUND',
    );
  });

  it("keeps another organisation out of this org's leads and follow-ups", async () => {
    expect(await codeOf(tasks.followUpsForLead(ownerB.ctx, l1))).toBe('NOT_FOUND');
    expect(await codeOf(schedule(ownerB, l1, 60))).toBe('NOT_FOUND');
    expect(await codeOf(tasks.completeFollowUp(ownerB.ctx, adminTask, { version: 1 }))).toBe(
      'NOT_FOUND',
    );
    expect(await codeOf(tasks.completeFollowUp(a.owner.ctx, 'not-a-uuid', { version: 1 }))).toBe(
      'NOT_FOUND',
    );
  });
});

describe('database rules (as crm_app)', () => {
  it('derives next_follow_up_at: a direct update is refused', async () => {
    const l = await created(a.exec1);
    expect(
      await sqlState(
        asApp(A, A.users.owner.id, 'UPDATE lead SET next_follow_up_at = now() WHERE id = $1', [l]),
      ),
    ).toBe('23514');
  });

  it('inserts only the session user’s own open follow-up, not due in the past', async () => {
    const l = await created(a.exec1);
    const insert = `INSERT INTO task (org_id, lead_id, assignee_user_id, created_by, due_at)
      VALUES ($1, $2, $3, $4, $5)`;
    const soon = new Date(Date.now() + 3_600_000);
    const owner = A.users.owner.id;
    // An executive cannot insert a task for someone else (0021 keeps 0012's rule for them).
    const exec = A.users.exec1.id;
    expect(await sqlState(asApp(A, exec, insert, [A.orgId, l, A.users.exec2.id, exec, soon]))).toBe(
      '42501',
    );
    expect(
      await sqlState(
        asApp(A, owner, insert, [A.orgId, l, owner, owner, new Date(Date.now() - 3_600_000)]),
      ),
    ).toBe('42501');
    expect(
      await sqlState(
        asApp(B, B.users.owner.id, insert, [A.orgId, l, B.users.owner.id, B.users.owner.id, soon]),
      ),
    ).toBe('23514'); // 0013: task_lead_open_guard cannot see another org's lead (before RLS)
    expect(await sqlState(asApp(A, owner, insert, [A.orgId, l, owner, owner, soon]))).toBe('OK');
    expect(await nextOf(l)).toEqual(soon);
  });

  it('keeps closed follow-ups, types and assignees unchangeable', async () => {
    const l = await created(a.exec1);
    const { id } = await schedule(a.exec1, l, 60);
    const me = A.users.exec1.id;
    expect(
      await sqlState(
        asApp(A, me, 'UPDATE task SET assignee_user_id = $2 WHERE id = $1', [id, A.users.owner.id]),
      ),
    ).toBe('23514'); // 0013 grants the assignee (handover); task_guard still needs a new version
    expect(
      await sqlState(
        asApp(
          A,
          me,
          `UPDATE task SET status = 'DONE', completed_at = now() - interval '1 hour', version = 2 WHERE id = $1`,
          [id],
        ),
      ),
    ).toBe('23514');
    expect(
      await sqlState(
        asApp(A, me, `UPDATE task SET status = 'DONE', version = 2 WHERE id = $1`, [id]),
      ),
    ).toBe('23514'); // task_status: DONE needs completed_at
    await tasks.completeFollowUp(a.exec1.ctx, id, { version: 1 });
    expect(
      await sqlState(
        asApp(
          A,
          me,
          `UPDATE task SET due_at = now() + interval '1 day', version = 3 WHERE id = $1`,
          [id],
        ),
      ),
    ).toBe('23514');
    // Another org sees and changes nothing.
    const seen = await asApp(B, B.users.owner.id, 'SELECT id FROM task WHERE id = $1', [id]);
    expect(seen.rowCount).toBe(0);
  });
});

describe('merge (FR-062: tasks moved)', () => {
  it('moves open follow-ups to the survivor, cancels a duplicate per assignee, keeps history', async () => {
    // Same name: only the phone differs, so the merge needs no field resolutions.
    const survivor = await created(a.admin, 'Synthetic Merge Pair');
    const merged = await created(a.admin, 'Synthetic Merge Pair');
    const ownersOnSurvivor = await schedule(a.owner, survivor, 100);
    const ownersOnMerged = await schedule(a.owner, merged, 50);
    const closedOnMerged = await schedule(a.admin, merged, 200);
    await tasks.completeFollowUp(a.admin.ctx, closedOnMerged.id, { version: 1 });
    const adminsOnMerged = await schedule(a.admin, merged, 40);

    await leads.mergeLeads(a.owner.ctx, {
      survivorId: survivor,
      mergedId: merged,
      survivorVersion: (await leadRow(survivor)).version,
      mergedVersion: (await leadRow(merged)).version,
    });

    expect(await taskRow(adminsOnMerged.id)).toMatchObject({ leadId: survivor, status: 'OPEN' });
    expect(await taskRow(ownersOnSurvivor.id)).toMatchObject({ leadId: survivor, status: 'OPEN' });
    expect(await taskRow(ownersOnMerged.id)).toMatchObject({ leadId: merged, status: 'CANCELLED' });
    expect((await taskRow(ownersOnMerged.id)).cancelReason).toMatch(/Lead merged/);
    expect(await taskRow(closedOnMerged.id)).toMatchObject({ leadId: merged, status: 'DONE' });
    expect(await nextOf(survivor)).toEqual((await taskRow(adminsOnMerged.id)).dueAt);
    expect(await nextOf(merged)).toBeNull();
    const audit = await migrator().auditLog.findFirstOrThrow({
      where: { action: 'lead.merged', entityId: survivor },
    });
    expect(audit.metadata).toMatchObject({ followUpsMoved: 1, followUpsCancelled: 1 });
  });
});
