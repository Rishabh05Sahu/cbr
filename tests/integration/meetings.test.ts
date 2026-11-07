// FR-104 meeting details (migration 0022, ADR-0017): end (required), location or link, internal
// attendees (any active member; owner decisions 2026-10-30), the overlap warning, editing
// (optimistic lock, permissions), reschedule keeping the length, attendees' read-only My Day,
// invitation notifications, lifecycle, other task types unaffected, other orgs, and the database
// backstop as crm_app. Synthetic data only.
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

/** A datetime-local value `minutes` from now in the org time zone (Asia/Kolkata). */
function local(minutes: number): string {
  const d = new Date(Date.now() + minutes * 60_000);
  return tasks.orgLocalInput(d, 'Asia/Kolkata');
}

let seq = 0;
const phone = () => `95${String(10_000_000 + ++seq * 6_131 + (process.pid % 1000)).slice(-8)}`;
async function created(by: Actor): Promise<string> {
  const r = await leads.createLead(by.ctx, {
    fullName: 'Synthetic Meeting Lead',
    primaryPhone: phone(),
  });
  if (r.status !== 'created') throw new Error('fixture lead');
  return r.leadId;
}
const leadRow = (id: string) => migrator().lead.findUniqueOrThrow({ where: { id } });
const taskRow = (id: string) => migrator().task.findUniqueOrThrow({ where: { id } });
const versionOf = async (id: string) => (await leadRow(id)).version;
const attendeesOf = (taskId: string) =>
  migrator().taskAttendee.findMany({ where: { taskId }, orderBy: { createdAt: 'asc' } });
const current = async (taskId: string) =>
  (await attendeesOf(taskId))
    .filter((a) => !a.removedAt)
    .map((a) => a.userId)
    .sort();

/** Base meeting input: starts in `start` minutes, lasts `length` minutes. */
const meeting = (start = 120, length = 60, extra: Record<string, unknown> = {}) => ({
  type: 'MEETING',
  title: `Synthetic meeting ${++seq}`,
  dueAt: local(start),
  endAt: local(start + length),
  ...extra,
});
const make = (by: Actor, leadId: string | null, input: Record<string, unknown>) =>
  tasks.createTask(by.ctx, leadId, input);
async function deliver(org: Org, taskId: string) {
  const events = await migrator().outboxEvent.findMany({
    where: { type: 'meeting.invited', payload: { path: ['taskId'], equals: taskId } },
  });
  for (const e of events)
    await notifyForEvent({ eventId: e.id, orgId: org.orgId, type: e.type, payload: e.payload });
  return events.length;
}
const invitations = async (who: Actor, taskId: string) =>
  (await listNotifications(who.ctx)).rows.filter(
    (n) => n.type === 'MEETING_INVITED' && n.body.length > 0 && n.link === '/app/my-day',
  ).length > 0 &&
  (await migrator().notification.count({
    where: {
      recipientUserId: who.user.id,
      type: 'MEETING_INVITED',
      data: { path: ['taskId'], equals: taskId },
    },
  }));

/** An org with a West team led by the manager, exec1 a member. */
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
  A = await setup('MeetA');
  B = await setup('MeetB');
});

describe('creating a meeting (FR-104)', () => {
  it('stores end, location and attendees; invitees are notified once; history has no address', async () => {
    const { a, org } = A;
    const { id } = await make(
      a.exec1,
      null,
      meeting(120, 45, {
        location: '  Synthetic office,   room 2 ',
        attendeeUserIds: [org.users.exec2.id, org.users.hr.id, org.users.exec2.id],
      }),
    );
    const t = await taskRow(id);
    expect(t.endAt!.getTime() - t.dueAt.getTime()).toBe(45 * 60_000);
    expect(t.location).toBe('Synthetic office, room 2');
    expect(await current(id)).toEqual([org.users.exec2.id, org.users.hr.id].sort());
    expect(await deliver(org, id)).toBe(1);
    await deliver(org, id); // redelivery is a no-op
    expect(await invitations(a.exec2, id)).toBe(1);
    expect(await invitations(a.hr, id)).toBe(1);
    const audit = await migrator().auditLog.findFirstOrThrow({
      where: { action: 'task.scheduled', entityId: id },
    });
    expect(audit.metadata).toMatchObject({ taskType: 'MEETING', attendees: 2 });
    expect(JSON.stringify(audit.metadata)).not.toContain('Synthetic office');
  });

  it('on a lead: timeline entry; attendees may be people who cannot open the lead', async () => {
    const { a, org } = A;
    const l = await created(a.exec1);
    const { id } = await make(
      a.exec1,
      l,
      meeting(180, 30, { attendeeUserIds: [org.users.exec2.id] }),
    );
    const act = await migrator().leadActivity.findFirstOrThrow({ where: { refId: id } });
    expect(act.summary).toMatchObject({ action: 'scheduled', taskType: 'MEETING', attendees: 1 });
    // exec2 cannot open exec1's lead: the invitation gives no access.
    expect(await codeOf(leads.getLead(a.exec2.ctx, l))).toBe('NOT_FOUND');
  });

  it('validates the end, location and attendees', async () => {
    const { a, org } = A;
    const bad = (extra: Record<string, unknown>) =>
      failure(make(a.exec1, null, meeting(120, 60, extra)));
    expect(await bad({ endAt: '' })).toEqual({ code: 'VALIDATION_FAILED', fields: ['endAt'] });
    expect(await bad({ endAt: undefined })).toEqual({
      code: 'VALIDATION_FAILED',
      fields: ['endAt'],
    });
    expect(await bad({ endAt: local(100) })).toEqual({
      code: 'VALIDATION_FAILED',
      fields: ['endAt'],
    });
    expect(await bad({ endAt: local(120) })).toEqual({
      code: 'VALIDATION_FAILED',
      fields: ['endAt'],
    });
    expect(await bad({ endAt: local(120 + 24 * 60 + 1) })).toEqual({
      code: 'VALIDATION_FAILED',
      fields: ['endAt'],
    });
    expect(await bad({ endAt: 'tomorrow' })).toEqual({
      code: 'VALIDATION_FAILED',
      fields: ['endAt'],
    });
    expect((await bad({ location: 'x'.repeat(301) })).code).toBe('VALIDATION_FAILED');
    for (const ids of [
      ['not-a-uuid'],
      [B.org.users.exec1.id],
      ['01a18433-0000-7000-8000-000000000000'],
      [org.users.exec1.id], // the meeting's own assignee
    ])
      expect(await bad({ attendeeUserIds: ids })).toEqual({
        code: 'VALIDATION_FAILED',
        fields: ['attendeeUserIds'],
      });
    expect(
      (await bad({ attendeeUserIds: Array.from({ length: 31 }, () => org.users.exec2.id) })).code,
    ).toBe('VALIDATION_FAILED');
    expect(
      await migrator().task.count({
        where: {
          createdBy: org.users.exec1.id,
          title: { startsWith: 'Synthetic meeting' },
          endAt: null,
        },
      }),
    ).toBe(0);
  });

  it('a suspended or deactivated member cannot be invited', async () => {
    const s = await setup('MeetGone');
    await members.suspendMember(s.a.owner.ctx, s.org.membership.exec2!);
    await members.deactivateMember(s.a.owner.ctx, s.org.membership.hr!);
    for (const u of [s.org.users.exec2.id, s.org.users.hr.id])
      expect(
        await failure(make(s.a.exec1, null, meeting(120, 60, { attendeeUserIds: [u] }))),
      ).toEqual({ code: 'VALIDATION_FAILED', fields: ['attendeeUserIds'] });
  });

  it('other task types refuse meeting fields and need none', async () => {
    const { a, org } = A;
    const l = await created(a.exec1);
    for (const type of ['CALL', 'DOCUMENT', 'OTHER'])
      expect(
        await failure(
          make(a.exec1, l, {
            type,
            title: 'Synthetic',
            dueAt: local(60),
            endAt: local(90),
            location: 'Room',
            attendeeUserIds: [org.users.exec2.id],
          }),
        ),
      ).toEqual({ code: 'VALIDATION_FAILED', fields: ['attendeeUserIds', 'endAt', 'location'] });
    expect(
      await failure(
        make(a.exec1, l, { type: 'FOLLOW_UP', title: '', dueAt: local(60), endAt: local(90) }),
      ),
    ).toEqual({ code: 'VALIDATION_FAILED', fields: ['endAt'] });
    const call = await make(a.exec1, l, {
      type: 'CALL',
      title: 'Synthetic call',
      dueAt: local(60),
    });
    expect(await taskRow(call.id)).toMatchObject({ endAt: null, location: null });
  });
});

describe('overlap warning (same user)', () => {
  it('warns, never blocks; names titles only to the person themself', async () => {
    const s = await setup('MeetOverlap');
    const { a, org } = s;
    const first = await make(a.exec1, null, meeting(300, 60, { title: 'Synthetic first' }));
    expect(first.warning).toBeUndefined();
    const second = await make(a.exec1, null, meeting(330, 60));
    expect(second.warning).toContain('“Synthetic first”');
    // Back to back: no warning.
    expect((await make(a.exec1, null, meeting(240, 60))).warning).toBeUndefined();
    // Assigned by the manager: a count only (exec1's no-lead meetings stay private, ADR-0016 D2).
    const byManager = await make(
      a.manager,
      null,
      meeting(310, 30, { assigneeUserId: org.users.exec1.id }),
    );
    expect(byManager.warning).toBe('They already have 2 other meetings at that time.');
    expect(byManager.warning).not.toContain('Synthetic first');
    // Being an attendee counts: exec2 is invited to exec1's meeting, then books their own.
    await make(a.exec1, null, meeting(600, 60, { attendeeUserIds: [org.users.exec2.id] }));
    expect((await make(a.exec2, null, meeting(630, 15))).warning).toMatch(/overlaps/);
    // Closed meetings do not count.
    const lone = await make(a.exec2, null, meeting(900, 60));
    await tasks.cancelFollowUp(a.exec2.ctx, lone.id, { reason: 'Synthetic', version: 1 });
    expect((await make(a.exec2, null, meeting(900, 60))).warning).toBeUndefined();
  });
});

describe('editing a meeting', () => {
  it('changes end, location and attendees; removals are recorded, additions notified', async () => {
    const { a, org } = A;
    const l = await created(a.exec1);
    const { id } = await make(
      a.exec1,
      l,
      meeting(400, 60, { attendeeUserIds: [org.users.exec2.id] }),
    );
    await tasks.updateMeeting(a.exec1.ctx, id, {
      endAt: local(490),
      location: 'Synthetic site office',
      attendeeUserIds: [org.users.manager.id],
      version: 1,
    });
    const t = await taskRow(id);
    expect(t).toMatchObject({ version: 2, location: 'Synthetic site office' });
    expect(t.endAt!.getTime() - t.dueAt.getTime()).toBe(90 * 60_000);
    expect(await current(id)).toEqual([org.users.manager.id]);
    const removed = (await attendeesOf(id)).find((x) => x.userId === org.users.exec2.id)!;
    expect(removed).toMatchObject({ removedBy: org.users.exec1.id });
    expect(removed.removedAt).not.toBeNull();
    await deliver(org, id);
    expect(await invitations(a.manager, id)).toBe(1);
    const act = await migrator().leadActivity.findFirstOrThrow({
      where: { refId: id, summary: { path: ['action'], equals: 'details_changed' } },
    });
    expect(act.summary).toMatchObject({
      attendeesAdded: 1,
      attendeesRemoved: 1,
      locationChanged: true,
    });
    // Re-inviting a removed person makes a new invitation row.
    await tasks.updateMeeting(a.exec1.ctx, id, {
      endAt: local(490),
      attendeeUserIds: [org.users.manager.id, org.users.exec2.id],
      version: 2,
    });
    expect(await current(id)).toEqual([org.users.manager.id, org.users.exec2.id].sort());
    expect((await taskRow(id)).location).toBeNull();
  });

  it('refuses a stale version, a non-meeting, a missing end, and a closed meeting', async () => {
    const { a } = A;
    const { id } = await make(a.exec1, null, meeting(500, 30));
    const edit = (version: number, extra: Record<string, unknown> = {}) =>
      tasks.updateMeeting(a.exec1.ctx, id, { endAt: local(560), version, ...extra });
    expect(await codeOf(edit(2))).toBe('CONFLICT');
    expect(await failure(edit(1, { endAt: '' }))).toEqual({
      code: 'VALIDATION_FAILED',
      fields: ['endAt'],
    });
    const doc = await make(a.exec1, null, {
      type: 'DOCUMENT',
      title: 'Synthetic',
      dueAt: local(60),
    });
    expect(
      await codeOf(tasks.updateMeeting(a.exec1.ctx, doc.id, { endAt: local(90), version: 1 })),
    ).toBe('RULE_VIOLATION');
    await tasks.completeFollowUp(a.exec1.ctx, id, { version: 1 });
    expect(await codeOf(edit(2))).toBe('RULE_VIOLATION');
  });

  it('a meeting saved before end times must get an end when edited', async () => {
    const { a, org } = A;
    const legacy = await migrator().task.create({
      data: {
        orgId: org.orgId,
        type: 'MEETING',
        title: 'Synthetic legacy meeting',
        assigneeUserId: org.users.exec1.id,
        createdBy: org.users.exec1.id,
        dueAt: new Date(Date.now() + 3 * 3_600_000),
      },
    });
    expect(await failure(tasks.updateMeeting(a.exec1.ctx, legacy.id, { version: 1 }))).toEqual({
      code: 'VALIDATION_FAILED',
      fields: ['endAt'],
    });
    const end = tasks.orgLocalInput(new Date(legacy.dueAt.getTime() + 3_600_000), 'Asia/Kolkata');
    await tasks.updateMeeting(a.exec1.ctx, legacy.id, { endAt: end, version: 1 });
    expect((await taskRow(legacy.id)).endAt).not.toBeNull();
  });

  it('only those who may change the task: not attendees, not a manager on a no-lead meeting, not other orgs', async () => {
    const { a, org } = A;
    const l = await created(a.exec1);
    const onLead = await make(
      a.exec1,
      l,
      meeting(700, 60, { attendeeUserIds: [org.users.exec2.id] }),
    );
    const own = await make(
      a.exec1,
      null,
      meeting(800, 60, { attendeeUserIds: [org.users.exec2.id] }),
    );
    const edit = (who: Actor, id: string) =>
      codeOf(tasks.updateMeeting(who.ctx, id, { endAt: local(950), version: 1 }));
    expect(await edit(a.exec2, own.id)).toBe('NOT_FOUND'); // an attendee
    expect(await edit(a.manager, own.id)).toBe('NOT_FOUND'); // no-lead: private (ADR-0016 D2)
    expect(await edit(a.hr, own.id)).toBe('NOT_FOUND');
    expect(await edit(B.a.owner, own.id)).toBe('NOT_FOUND');
    expect(await edit(a.admin, own.id)).toBe('OK'); // Owner/Admin: ORG task scope
    expect(
      await codeOf(
        tasks.updateMeeting(a.manager.ctx, onLead.id, { endAt: local(760), version: 1 }),
      ),
    ).toBe('OK'); // team lead's meeting on a team lead
  });

  it('reschedule moves the end with the start', async () => {
    const { a } = A;
    const { id } = await make(a.exec1, null, meeting(1000, 75));
    await tasks.rescheduleFollowUp(a.exec1.ctx, id, { dueAt: local(1300), version: 1 });
    const t = await taskRow(id);
    expect(t.endAt!.getTime() - t.dueAt.getTime()).toBe(75 * 60_000);
  });
});

describe('attendees on My Day (read-only)', () => {
  it('shows invited open meetings, without the lead unless they can open it, and nothing else of the organiser', async () => {
    const s = await setup('MeetDay');
    const { a, org } = s;
    const l = await created(a.exec1);
    const noLead = await make(
      a.exec1,
      null,
      meeting(60, 30, { attendeeUserIds: [org.users.exec2.id] }),
    );
    const onLead = await make(
      a.exec1,
      l,
      meeting(90, 30, { attendeeUserIds: [org.users.exec2.id] }),
    );
    const privateTask = await make(a.exec1, null, {
      type: 'OTHER',
      title: 'Synthetic private',
      dueAt: local(60),
    });
    const removedFrom = await make(
      a.exec1,
      null,
      meeting(150, 30, { attendeeUserIds: [org.users.exec2.id] }),
    );
    await tasks.updateMeeting(a.exec1.ctx, removedFrom.id, {
      endAt: local(180),
      attendeeUserIds: [],
      version: 1,
    });
    const later = await make(
      a.exec1,
      null,
      meeting(60 * 24 * 12, 30, { attendeeUserIds: [org.users.exec2.id] }),
    );

    const day = await tasks.myDay(a.exec2.ctx);
    const soon = [...day.overdue, ...day.today, ...day.upcoming];
    const ids = soon.map((t) => t.id);
    expect(ids).toContain(noLead.id);
    expect(ids).toContain(onLead.id);
    expect(ids).not.toContain(privateTask.id);
    expect(ids).not.toContain(removedFrom.id);
    expect(day.later.map((t) => t.id)).toEqual([later.id]);
    const seen = Object.fromEntries(soon.map((t) => [t.id, t]));
    expect(seen[noLead.id]).toMatchObject({ attending: true, canUpdate: false, onLead: false });
    expect(seen[noLead.id]!.organiserName).toBeTruthy();
    expect(seen[onLead.id]).toMatchObject({ attending: true, onLead: true, lead: null });
    // The organiser's own view is unchanged and editable.
    const mine = await tasks.myDay(a.exec1.ctx);
    const own = [...mine.today, ...mine.upcoming, ...mine.overdue].find((t) => t.id === noLead.id);
    expect(own).toMatchObject({ attending: false, canUpdate: true });

    // Won/Lost cancels the lead meeting; cancelled meetings leave the attendee's My Day.
    await leads.changeStage(a.exec1.ctx, l, {
      toStage: 'LOST',
      version: String(await versionOf(l)),
      reasonCode: 'NOT_INTERESTED',
    });
    expect(await taskRow(onLead.id)).toMatchObject({ status: 'CANCELLED' });
    const after = await tasks.myDay(a.exec2.ctx);
    expect([...after.today, ...after.upcoming].map((t) => t.id)).not.toContain(onLead.id);
    // A notification for a removed attendee or a closed meeting is skipped.
    await deliver(org, removedFrom.id);
    await deliver(org, onLead.id);
    expect(await invitations(a.exec2, removedFrom.id)).toBeFalsy();
    expect(await invitations(a.exec2, onLead.id)).toBeFalsy();
  });

  it('a meeting on a Do-Not-Contact lead is still allowed; a Call task still is not', async () => {
    const { a } = A;
    const l = await created(a.exec1);
    await leads.changeContactStatus(a.exec1.ctx, l, {
      toStatus: 'DO_NOT_CONTACT',
      version: await versionOf(l),
      method: 'VERBAL',
      reason: 'Synthetic: asked not to be called',
    });
    expect(await codeOf(make(a.exec1, l, meeting(60, 30)))).toBe('OK');
    expect(
      await codeOf(make(a.exec1, l, { type: 'CALL', title: 'Synthetic', dueAt: local(60) })),
    ).toBe('RULE_VIOLATION');
  });
});

describe('database backstop (crm_app, migration 0022)', () => {
  it('keeps meeting fields on meetings, the end after the start, attendees valid', async () => {
    const { org, a } = A;
    const u = org.users;
    const ins = (type: string, end: string) =>
      sqlState(
        asApp(
          org,
          u.exec1.id,
          `INSERT INTO task (org_id, type, title, assignee_user_id, created_by, due_at, end_at)
           VALUES ($1, $2, 'Synthetic', $3, $3, now() + interval '2 hours', now() + $4::interval)`,
          [org.orgId, type, u.exec1.id, end],
        ),
      );
    expect(await ins('CALL', '3 hours')).toBe('23514');
    expect(await ins('MEETING', '1 hour')).toBe('23514');
    expect(await ins('MEETING', '27 hours')).toBe('23514');
    expect(await ins('MEETING', '3 hours')).toBe('OK');

    const { id } = await make(a.exec1, null, meeting(60, 30));
    const doc = await make(a.exec1, null, {
      type: 'DOCUMENT',
      title: 'Synthetic',
      dueAt: local(60),
    });
    const invite = (as: string, task: string, user: string, by = as) =>
      sqlState(
        asApp(
          org,
          as,
          `INSERT INTO task_attendee (org_id, task_id, user_id, added_by) VALUES ($1, $2, $3, $4)`,
          [org.orgId, task, user, by],
        ),
      );
    expect(await invite(u.exec1.id, doc.id, u.exec2.id)).toBe('23514'); // not a meeting
    expect(await invite(u.exec1.id, id, u.exec1.id)).toBe('23514'); // its assignee
    expect(await invite(u.exec1.id, id, u.exec2.id, u.admin.id)).toBe('42501'); // not the session user
    expect(await invite(u.exec1.id, id, u.exec2.id)).toBe('OK');
    expect(await invite(u.exec1.id, id, u.exec2.id)).toBe('23505'); // already invited
    expect(
      await sqlState(asApp(org, u.exec1.id, `DELETE FROM task_attendee WHERE task_id = $1`, [id])),
    ).toBe('42501');
    // A removal is final: it cannot be undone by clearing removed_at.
    await asApp(
      org,
      u.exec1.id,
      `UPDATE task_attendee SET removed_at = now(), removed_by = $2 WHERE task_id = $1`,
      [id, u.exec1.id],
    );
    expect(
      await sqlState(
        asApp(
          org,
          u.exec1.id,
          `UPDATE task_attendee SET removed_at = NULL, removed_by = NULL WHERE task_id = $1`,
          [id],
        ),
      ),
    ).not.toBe('OK');
    // Another org sees no attendee rows.
    const r = await asApp(
      B.org,
      B.org.users.owner.id,
      `SELECT count(*)::int AS n FROM task_attendee WHERE task_id = $1`,
      [id],
    );
    expect(r.rows[0].n).toBe(0);
  });
});
