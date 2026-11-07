// FR-150–152 basic site visits (migration 0026, ADR-0022): scheduling with the automatic stage
// move, assignees by scope, validation, the status lifecycle (confirm, reschedule, cancel,
// no-show, attended with outcome), stage effects (Completed, back to Qualified), Won/Lost and
// reassignment, reminders for assignee and scheduler, history/timeline/audit, permissions, other
// orgs, and the database backstop as crm_app. Synthetic data only.
import { beforeAll, describe, expect, it } from 'vitest';
import * as leads from '@/modules/leads';
import { listNotifications, notifyForEvent } from '@/modules/notifications';
import * as teams from '@/modules/teams';
import * as visits from '@/modules/visits';
import { claimDueVisitReminders } from '@/modules/visits/reminders';
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

/** A datetime-local value `minutes` from now in India time. */
const local = (minutes: number) => {
  const d = new Date(Date.now() + minutes * 60_000 + 330 * 60_000);
  return d.toISOString().slice(0, 16);
};

let seq = 0;
const phone = () => `98${String(10_000_000 + ++seq * 9_311 + (process.pid % 1000)).slice(-8)}`;
const QUALIFIABLE = {
  transactionType: 'BUY',
  propertyType: 'APARTMENT',
  preferredCity: 'Pune',
  budgetMax: '1.2 Cr',
};
async function created(by: Actor, qualifiable = true): Promise<string> {
  const r = await leads.createLead(by.ctx, {
    fullName: 'Synthetic Visit Lead',
    primaryPhone: phone(),
    ...(qualifiable ? QUALIFIABLE : {}),
  });
  if (r.status !== 'created') throw new Error('fixture lead');
  return r.leadId;
}
const leadRow = (id: string) => migrator().lead.findUniqueOrThrow({ where: { id } });
const visitRow = (id: string) => migrator().siteVisit.findUniqueOrThrow({ where: { id } });
const versionOf = async (id: string) => (await leadRow(id)).version;
const schedule = (by: Actor, leadId: string, extra: Record<string, string> = {}) =>
  visits.scheduleVisit(by.ctx, leadId, {
    scheduledFor: local(24 * 60),
    location: 'Synthetic site office, Baner',
    ...extra,
  });
const act = (by: Actor, id: string, input: Record<string, string>) =>
  visits.updateVisit(by.ctx, id, input);
/** A visit whose time has come (earlier today, India time), inserted by the schema owner. */
async function pastVisit(org: Org, by: Actor, leadId: string, minutesAgo = 30) {
  const v = await migrator().siteVisit.create({
    data: {
      orgId: org.orgId,
      leadId,
      assignedUserId: by.user.id,
      scheduledBy: by.user.id,
      scheduledFor: new Date(Date.now() - minutesAgo * 60_000),
      locationText: 'Synthetic site office',
    },
  });
  return v.id;
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
  return { org, a };
}
let A: Awaited<ReturnType<typeof setup>>;
let B: Awaited<ReturnType<typeof setup>>;
beforeAll(async () => {
  A = await setup('VisitA');
  B = await setup('VisitB');
});

describe('scheduling (FR-150)', () => {
  it('creates the visit and moves the lead to Site Visit Scheduled in the same transaction', async () => {
    const { a, org } = A;
    const l = await created(a.exec1);
    const { id } = await schedule(a.exec1, l);
    expect(await visitRow(id)).toMatchObject({
      leadId: l,
      status: 'SCHEDULED',
      assignedUserId: org.users.exec1.id,
      scheduledBy: org.users.exec1.id,
      locationText: 'Synthetic site office, Baner',
      rescheduleCount: 0,
    });
    const lead = await leadRow(l);
    expect(lead.stage).toBe('SITE_VISIT_SCHEDULED');
    expect(lead.firstVisitScheduledAt).not.toBeNull();
    const history = await migrator().leadStageHistory.findMany({
      where: { leadId: l, toStage: 'SITE_VISIT_SCHEDULED' },
    });
    expect(history[0]).toMatchObject({
      source: 'SYSTEM_RULE',
      reasonCode: 'SITE_VISIT_SCHEDULED',
      relatedEntityType: 'site_visit',
      relatedEntityId: id,
    });
    expect(
      await migrator().siteVisitEvent.count({ where: { siteVisitId: id, toStatus: 'SCHEDULED' } }),
    ).toBe(1);
    expect(
      await migrator().leadActivity.count({ where: { leadId: l, type: 'SITE_VISIT', refId: id } }),
    ).toBe(1);
    expect(
      await migrator().auditLog.count({ where: { action: 'site_visit.scheduled', entityId: id } }),
    ).toBe(1);
  });

  it('needs the qualification fields when the stage jumps past Qualified; nothing is written otherwise', async () => {
    const { a } = A;
    const l = await created(a.exec1, false);
    const r = await failure(schedule(a.exec1, l));
    expect(r.code).toBe('VALIDATION_FAILED');
    expect(r.fields).toEqual(['stage']);
    expect(await migrator().siteVisit.count({ where: { leadId: l } })).toBe(0);
  });

  it('validates time and meeting point', async () => {
    const { a } = A;
    const l = await created(a.exec1);
    expect(await failure(schedule(a.exec1, l, { scheduledFor: local(-120) }))).toEqual({
      code: 'VALIDATION_FAILED',
      fields: ['scheduledFor'],
    });
    expect(await failure(schedule(a.exec1, l, { scheduledFor: 'tomorrow' }))).toEqual({
      code: 'VALIDATION_FAILED',
      fields: ['scheduledFor'],
    });
    expect((await failure(schedule(a.exec1, l, { location: '   ' }))).code).toBe(
      'VALIDATION_FAILED',
    );
  });

  it('assignees follow the scheduler’s scope: self (exec), team (manager), anyone in sales (admin)', async () => {
    const { a, org } = A;
    const l = await created(a.exec1);
    expect(await failure(schedule(a.exec1, l, { assigneeUserId: org.users.exec2.id }))).toEqual({
      code: 'VALIDATION_FAILED',
      fields: ['assigneeUserId'],
    });
    expect(await failure(schedule(a.manager, l, { assigneeUserId: org.users.exec2.id }))).toEqual({
      code: 'VALIDATION_FAILED',
      fields: ['assigneeUserId'],
    });
    expect(await failure(schedule(a.admin, l, { assigneeUserId: org.users.hr.id }))).toEqual({
      code: 'VALIDATION_FAILED',
      fields: ['assigneeUserId'],
    });
    const byManager = await schedule(a.manager, l, { assigneeUserId: org.users.exec1.id });
    expect((await visitRow(byManager.id)).assignedUserId).toBe(org.users.exec1.id);
    const byAdmin = await schedule(a.admin, l, { assigneeUserId: org.users.exec2.id });
    expect((await visitRow(byAdmin.id)).assignedUserId).toBe(org.users.exec2.id);
  });

  it('lead scope, roles and orgs: not someone else’s lead, not HR, not another org; not archived or closed', async () => {
    const { a } = A;
    const l = await created(a.exec1);
    expect(await codeOf(schedule(a.exec2, l))).toBe('NOT_FOUND');
    expect(await codeOf(schedule(a.hr, l))).toBe('FORBIDDEN');
    expect(await codeOf(schedule(B.a.owner, l))).toBe('NOT_FOUND');
    const gone = await created(a.exec1);
    await leads.archiveLead(a.admin.ctx, gone, { version: await versionOf(gone) });
    expect(await codeOf(schedule(a.admin, gone))).toBe('RULE_VIOLATION');
    const lost = await created(a.exec1);
    await leads.changeStage(a.exec1.ctx, lost, {
      toStage: 'LOST',
      version: String(await versionOf(lost)),
      reasonCode: 'NOT_INTERESTED',
    });
    expect(await codeOf(schedule(a.exec1, lost))).toBe('RULE_VIOLATION');
  });
});

describe('the visit lifecycle (FR-151/152)', () => {
  it('confirm, reschedule (same visit, reason, count), optimistic version', async () => {
    const { a } = A;
    const l = await created(a.exec1);
    const { id } = await schedule(a.exec1, l);
    await act(a.exec1, id, { action: 'confirm', version: '1' });
    expect((await visitRow(id)).status).toBe('CONFIRMED');
    expect(await codeOf(act(a.exec1, id, { action: 'confirm', version: '2' }))).toBe(
      'RULE_VIOLATION',
    );
    expect(
      await failure(
        act(a.exec1, id, { action: 'reschedule', version: '2', scheduledFor: local(48 * 60) }),
      ),
    ).toEqual({ code: 'VALIDATION_FAILED', fields: ['reason'] });
    const before = (await visitRow(id)).scheduledFor;
    await act(a.exec1, id, {
      action: 'reschedule',
      version: '2',
      scheduledFor: local(48 * 60),
      reason: 'Synthetic: customer travelling',
    });
    const v = await visitRow(id);
    expect(v).toMatchObject({ status: 'RESCHEDULED', rescheduleCount: 1, version: 3 });
    const ev = await migrator().siteVisitEvent.findFirstOrThrow({
      where: { siteVisitId: id, toStatus: 'RESCHEDULED' },
    });
    expect(ev).toMatchObject({
      reason: 'Synthetic: customer travelling',
      previousScheduledFor: before,
    });
    expect(await codeOf(act(a.exec1, id, { action: 'confirm', version: '1' }))).toBe('CONFLICT');
    // Attended and no-show are not recorded before the visit's day.
    expect(
      await codeOf(
        act(a.exec1, id, {
          action: 'attended',
          version: '3',
          interestLevel: 'HIGH',
          nextAction: 'Call back',
        }),
      ),
    ).toBe('RULE_VIOLATION');
    expect(await codeOf(act(a.exec1, id, { action: 'no_show', version: '3', reason: 'x' }))).toBe(
      'RULE_VIOLATION',
    );
  });

  it('attended: outcome required; the lead moves to Site Visit Completed; the visit is then final', async () => {
    const { a, org } = A;
    const l = await created(a.exec1);
    await schedule(a.exec1, l); // lead -> Site Visit Scheduled
    const id = await pastVisit(org, a.exec1, l);
    expect(await failure(act(a.exec1, id, { action: 'attended', version: '1' }))).toEqual({
      code: 'VALIDATION_FAILED',
      fields: ['interestLevel', 'nextAction'],
    });
    await act(a.exec1, id, {
      action: 'attended',
      version: '1',
      interestLevel: 'HIGH',
      objections: 'Price, Parking, price',
      notes: 'Liked the view',
      nextAction: 'Share the price sheet',
    });
    const v = await visitRow(id);
    expect(v).toMatchObject({
      status: 'ATTENDED',
      interestLevel: 'HIGH',
      objections: ['Price', 'Parking'],
      outcomeNotes: 'Liked the view',
      nextAction: 'Share the price sheet',
    });
    expect(v.attendedAt).not.toBeNull();
    const lead = await leadRow(l);
    expect(lead.stage).toBe('SITE_VISIT_COMPLETED');
    expect(lead.firstVisitCompletedAt).not.toBeNull();
    expect(
      await migrator().leadStageHistory.count({
        where: { leadId: l, reasonCode: 'SITE_VISIT_ATTENDED', relatedEntityId: id },
      }),
    ).toBe(1);
    expect(await codeOf(act(a.exec1, id, { action: 'cancel', version: '2', reason: 'x' }))).toBe(
      'RULE_VIOLATION',
    );
    // Another visit from Site Visit Completed moves the lead back to Scheduled.
    await schedule(a.exec1, l);
    expect((await leadRow(l)).stage).toBe('SITE_VISIT_SCHEDULED');
  });

  it('no-show needs a reason and leaves the stage; cancelling the only open visit returns the lead to Qualified', async () => {
    const { a, org } = A;
    const l = await created(a.exec1);
    const { id: future } = await schedule(a.exec1, l);
    const past = await pastVisit(org, a.exec1, l);
    expect(await failure(act(a.exec1, past, { action: 'no_show', version: '1' }))).toEqual({
      code: 'VALIDATION_FAILED',
      fields: ['reason'],
    });
    await act(a.exec1, past, {
      action: 'no_show',
      version: '1',
      reason: 'Synthetic: did not come',
    });
    expect((await visitRow(past)).status).toBe('NO_SHOW');
    expect((await leadRow(l)).stage).toBe('SITE_VISIT_SCHEDULED');
    expect(await failure(act(a.exec1, future, { action: 'cancel', version: '1' }))).toEqual({
      code: 'VALIDATION_FAILED',
      fields: ['reason'],
    });
    await act(a.exec1, future, {
      action: 'cancel',
      version: '1',
      reason: 'Synthetic: postponed purchase',
    });
    expect((await visitRow(future)).status).toBe('CANCELLED');
    expect((await leadRow(l)).stage).toBe('QUALIFIED');
    expect(
      await migrator().leadStageHistory.count({
        where: { leadId: l, reasonCode: 'SITE_VISIT_CANCELLED', relatedEntityId: future },
      }),
    ).toBe(1);
  });

  it('cancelling one of two open visits keeps the lead in Site Visit Scheduled', async () => {
    const { a } = A;
    const l = await created(a.exec1);
    const one = await schedule(a.exec1, l);
    await schedule(a.exec1, l, { scheduledFor: local(3 * 24 * 60) });
    await act(a.exec1, one.id, {
      action: 'cancel',
      version: '1',
      reason: 'Synthetic: second one kept',
    });
    expect((await leadRow(l)).stage).toBe('SITE_VISIT_SCHEDULED');
  });

  it('only those who may manage the lead change a visit', async () => {
    const { a } = A;
    const l = await created(a.exec1);
    const { id } = await schedule(a.exec1, l);
    for (const who of [a.exec2, B.a.owner])
      expect(await codeOf(act(who, id, { action: 'confirm', version: '1' }))).toBe('NOT_FOUND');
    expect(await codeOf(act(a.hr, id, { action: 'confirm', version: '1' }))).toBe('FORBIDDEN');
    expect(await codeOf(act(a.manager, id, { action: 'confirm', version: '1' }))).toBe('OK'); // team lead
  });
});

describe('lead lifecycle', () => {
  it('Won/Lost cancels open visits with a reason; the database refuses it otherwise', async () => {
    const { a, org } = A;
    const l = await created(a.exec1);
    await schedule(a.exec1, l);
    await act(a.exec1, await pastVisit(org, a.exec1, l), {
      action: 'attended',
      version: '1',
      interestLevel: 'MEDIUM',
      nextAction: 'Negotiate',
    });
    await leads.changeStage(a.exec1.ctx, l, {
      toStage: 'NEGOTIATION',
      version: String(await versionOf(l)),
    });
    const { id } = await schedule(a.exec1, l); // stays in Negotiation
    expect((await leadRow(l)).stage).toBe('NEGOTIATION');
    await leads.changeStage(a.exec1.ctx, l, {
      toStage: 'LOST',
      version: String(await versionOf(l)),
      reasonCode: 'NOT_INTERESTED',
    });
    expect(await visitRow(id)).toMatchObject({
      status: 'CANCELLED',
      cancelReason: 'Lead marked as Lost',
    });

    const l2 = await created(a.exec1);
    await leads.changeStage(a.exec1.ctx, l2, {
      toStage: 'QUALIFIED',
      version: String(await versionOf(l2)),
    });
    await migrator().$executeRaw`UPDATE lead SET stage = 'NEGOTIATION' WHERE id = ${l2}::uuid`;
    await schedule(a.exec1, l2);
    expect(
      await sqlState(
        asApp(
          org,
          org.users.owner.id,
          `UPDATE lead SET stage = 'LOST', version = version + 1 WHERE id = $1`,
          [l2],
        ),
      ),
    ).toBe('23514');
  });

  it('a reassigned lead keeps its visits and assignee; the assignee still sees them, without the lead', async () => {
    const { a, org } = A;
    const l = await created(a.exec1);
    const { id } = await schedule(a.exec1, l);
    await leads.assignLead(a.admin.ctx, l, {
      target: `user:${org.users.exec2.id}`,
      version: await versionOf(l),
      reason: 'Synthetic: rebalancing',
    });
    expect((await visitRow(id)).assignedUserId).toBe(org.users.exec1.id);
    const mine = await visits.myVisits(a.exec1.ctx);
    const seen = mine.open.find((v) => v.id === id)!;
    expect(seen).toMatchObject({ lead: null, leadName: 'Synthetic Visit Lead', canManage: false });
    // The new owner manages it through the lead.
    expect(
      (await visits.visitsForLead(a.exec2.ctx, l)).visits.find((v) => v.id === id)!.canManage,
    ).toBe(true);
    expect(await codeOf(act(a.exec1, id, { action: 'confirm', version: '1' }))).toBe('NOT_FOUND');
    // Other orgs never see it.
    expect((await visits.myVisits(B.a.owner.ctx)).open.map((v) => v.id)).not.toContain(id);
  });
});

describe('reminders (FR-150)', () => {
  it('the assignee and the scheduler are reminded once, 15 minutes before; a reschedule makes it stale', async () => {
    const { a, org } = A;
    const l = await created(a.exec1);
    const { id } = await schedule(a.manager, l, {
      scheduledFor: local(10),
      assigneeUserId: org.users.exec1.id,
    });
    await Promise.all([claimDueVisitReminders(), claimDueVisitReminders()]);
    await claimDueVisitReminders();
    const reminders = await migrator().siteVisitReminder.findMany({ where: { siteVisitId: id } });
    expect(reminders.map((r) => r.recipientUserId).sort()).toEqual(
      [org.users.exec1.id, org.users.manager.id].sort(),
    );
    const events = await migrator().outboxEvent.findMany({
      where: { type: 'site_visit.reminder_due', payload: { path: ['siteVisitId'], equals: id } },
    });
    expect(events).toHaveLength(2);
    for (const e of [...events, ...events])
      await notifyForEvent({ eventId: e.id, orgId: e.orgId, type: e.type, payload: e.payload });
    for (const who of [a.exec1, a.manager]) {
      const n = (await listNotifications(who.ctx)).rows.filter((x) => x.type === 'VISIT_REMINDER');
      expect(n).toHaveLength(1);
      expect(n[0]!.title).toMatch(/^Site visit at /);
      expect(n[0]!.link).toBe('/app/visits');
    }
    // A stale reminder (rescheduled) is dropped.
    const l2 = await created(a.exec1);
    const v2 = await schedule(a.exec1, l2, { scheduledFor: local(11) });
    await claimDueVisitReminders();
    await act(a.exec1, v2.id, {
      action: 'reschedule',
      version: '1',
      scheduledFor: local(120),
      reason: 'Synthetic',
    });
    for (const e of await migrator().outboxEvent.findMany({
      where: { type: 'site_visit.reminder_due', payload: { path: ['siteVisitId'], equals: v2.id } },
    }))
      await notifyForEvent({ eventId: e.id, orgId: e.orgId, type: e.type, payload: e.payload });
    expect(
      await migrator().notification.count({
        where: { type: 'VISIT_REMINDER', data: { path: ['siteVisitId'], equals: v2.id } },
      }),
    ).toBe(0);
  });
});

describe('database backstop (crm_app, migration 0026)', () => {
  it('refuses invalid transitions, time changes without a reschedule, other roles and inserts not as the session user', async () => {
    const { a, org } = A;
    const u = org.users;
    const l = await created(a.exec1);
    const { id } = await schedule(a.exec1, l);
    expect(
      (await asApp(org, u.hr.id, `SELECT count(*)::int AS n FROM site_visit WHERE id = $1`, [id]))
        .rows[0].n,
    ).toBe(0);
    expect(
      await sqlState(
        asApp(
          org,
          u.exec1.id,
          `UPDATE site_visit SET scheduled_for = scheduled_for + interval '1 day', version = version + 1 WHERE id = $1`,
          [id],
        ),
      ),
    ).toBe('23514');
    expect(
      await sqlState(
        asApp(
          org,
          u.exec1.id,
          `UPDATE site_visit SET status = 'ATTENDED', version = version + 1 WHERE id = $1`,
          [id],
        ),
      ),
    ).toBe('23514');
    await act(a.exec1, id, { action: 'cancel', version: '1', reason: 'Synthetic' });
    expect(
      await sqlState(
        asApp(
          org,
          u.exec1.id,
          `UPDATE site_visit SET status = 'SCHEDULED', cancel_reason = NULL, closed_at = NULL, version = version + 1 WHERE id = $1`,
          [id],
        ),
      ),
    ).toBe('23514');
    expect(
      await sqlState(
        asApp(
          org,
          u.exec1.id,
          `INSERT INTO site_visit (org_id, lead_id, assigned_user_id, scheduled_by, scheduled_for, location_text) VALUES ($1, $2, $3, $4, now() + interval '1 day', 'X')`,
          [org.orgId, l, u.exec1.id, u.exec2.id],
        ),
      ),
    ).toBe('42501');
    expect(
      await sqlState(asApp(org, u.exec1.id, `DELETE FROM site_visit WHERE id = $1`, [id])),
    ).toBe('42501');
    expect(
      await sqlState(
        asApp(
          org,
          u.exec1.id,
          `INSERT INTO site_visit_reminder (org_id, site_visit_id, recipient_user_id, offset_minutes, fire_at, scheduled_for) SELECT org_id, id, assigned_user_id, 15, scheduled_for - interval '15 minutes', scheduled_for FROM site_visit WHERE id = $1`,
          [id],
        ),
      ),
    ).toBe('42501');
  });
});

describe('owner decisions 2026-10-30', () => {
  it('double-booking: a non-blocking warning within 60 minutes for the same salesperson', async () => {
    const { a } = A;
    const l = await created(a.exec1);
    const base = 5 * 24 * 60 + (Date.now() % 600);
    const first = await schedule(a.exec1, l, { scheduledFor: local(base) });
    expect(first.warning).toBeUndefined();
    const near = await schedule(a.exec1, l, { scheduledFor: local(base + 30) });
    expect(near.warning).toBe(
      'The salesperson has another site visit within 60 minutes of this one.',
    );
    expect((await visitRow(near.id)).status).toBe('SCHEDULED'); // saved anyway
    const far = await schedule(a.exec1, l, { scheduledFor: local(base + 120) });
    expect(far.warning).toBeUndefined();
    // Rescheduling into the window warns too; a closed visit does not count.
    const r = await act(a.exec1, far.id, {
      action: 'reschedule',
      version: '1',
      scheduledFor: local(base + 45),
      reason: 'Synthetic: moved',
    });
    expect(r.warning).toMatch(/2 other site visits within 60 minutes/);
    await act(a.exec1, near.id, { action: 'cancel', version: '1', reason: 'Synthetic' });
    expect((await schedule(a.exec1, l, { scheduledFor: local(base + 10) })).warning).toMatch(
      /2 other site visits/,
    );
  });

  it('no-show returns the lead to Qualified only from Site Visit Scheduled with no other open visit', async () => {
    const { a, org } = A;
    const l = await created(a.exec1);
    await schedule(a.exec1, l);
    const only = await pastVisit(org, a.exec1, l);
    // The scheduled future visit is still open: cancel it first so the no-show is the last one.
    const open = await migrator().siteVisit.findFirstOrThrow({
      where: { leadId: l, id: { not: only } },
    });
    await act(a.exec1, open.id, { action: 'cancel', version: '1', reason: 'Synthetic' });
    // Cancelling left the no-show visit open, so the stage stayed Scheduled.
    expect((await leadRow(l)).stage).toBe('SITE_VISIT_SCHEDULED');
    await act(a.exec1, only, {
      action: 'no_show',
      version: '1',
      reason: 'Synthetic: did not come',
    });
    expect((await leadRow(l)).stage).toBe('QUALIFIED');
    expect(
      await migrator().leadStageHistory.count({
        where: { leadId: l, reasonCode: 'SITE_VISIT_NO_SHOW', relatedEntityId: only },
      }),
    ).toBe(1);
  });

  it('a lead at Site Visit Completed never regresses when another visit is cancelled', async () => {
    const { a, org } = A;
    const l = await created(a.exec1);
    await schedule(a.exec1, l); // Scheduled; stays open
    const other = await schedule(a.exec1, l, { scheduledFor: local(4 * 24 * 60) });
    const done = await pastVisit(org, a.exec1, l);
    await act(a.exec1, done, {
      action: 'attended',
      version: '1',
      interestLevel: 'LOW',
      nextAction: 'Wait',
    });
    expect((await leadRow(l)).stage).toBe('SITE_VISIT_COMPLETED');
    await act(a.exec1, other.id, { action: 'cancel', version: '1', reason: 'Synthetic' });
    expect((await leadRow(l)).stage).toBe('SITE_VISIT_COMPLETED');
  });

  it('Do-Not-Contact: no new or rescheduled visit (app and database); history and cancel remain', async () => {
    const { a, org } = A;
    const l = await created(a.exec1);
    const { id } = await schedule(a.exec1, l);
    await leads.changeContactStatus(a.exec1.ctx, l, {
      toStatus: 'DO_NOT_CONTACT',
      version: await versionOf(l),
      method: 'VERBAL',
      reason: 'Synthetic: asked not to be contacted',
    });
    expect(await codeOf(schedule(a.exec1, l))).toBe('RULE_VIOLATION');
    expect(
      await codeOf(
        act(a.exec1, id, {
          action: 'reschedule',
          version: '1',
          scheduledFor: local(3000),
          reason: 'x',
        }),
      ),
    ).toBe('RULE_VIOLATION');
    expect((await visits.visitsForLead(a.exec1.ctx, l)).visits.map((v) => v.id)).toContain(id);
    expect(await codeOf(act(a.exec1, id, { action: 'confirm', version: '1' }))).toBe('OK');
    expect(
      await codeOf(act(a.exec1, id, { action: 'cancel', version: '2', reason: 'Synthetic' })),
    ).toBe('OK');
    const u = org.users;
    expect(
      await sqlState(
        asApp(
          org,
          u.exec1.id,
          `INSERT INTO site_visit (org_id, lead_id, assigned_user_id, scheduled_by, scheduled_for, location_text) VALUES ($1, $2, $3, $3, now() + interval '1 day', 'X')`,
          [org.orgId, l, u.exec1.id],
        ),
      ),
    ).toBe('23514');
  });

  it('My Day and calendar: only visits assigned to me; the lead only within my scope', async () => {
    const { a, org } = A;
    const l = await created(a.exec1);
    const { id } = await schedule(a.admin, l, {
      scheduledFor: local(2 * 24 * 60),
      assigneeUserId: org.users.exec2.id,
    });
    const mine = await visits.assignedVisits(a.exec2.ctx, { nextDays: 7 });
    const seen = mine.find((v) => v.id === id)!;
    expect(seen).toMatchObject({ lead: null, leadName: 'Synthetic Visit Lead', canManage: false });
    expect(seen.day).toMatch(/^\d{4}-\d{2}-\d{2}$/);
    // Not on the scheduler's, a manager's or an Owner's own list.
    for (const who of [a.admin, a.manager, a.owner, a.exec1])
      expect(
        (await visits.assignedVisits(who.ctx, { nextDays: 7 })).map((v) => v.id),
      ).not.toContain(id);
    // A calendar range that excludes the day excludes the visit; HR has none.
    expect(
      (await visits.assignedVisits(a.exec2.ctx, { fromDay: seen.day, toDay: seen.day })).map(
        (v) => v.id,
      ),
    ).not.toContain(id);
    expect(await codeOf(visits.assignedVisits(a.hr.ctx, { nextDays: 7 }))).toBe('FORBIDDEN');
    expect(
      (await visits.assignedVisits(B.a.owner.ctx, { nextDays: 7 })).map((v) => v.id),
    ).not.toContain(id);
  });
});
