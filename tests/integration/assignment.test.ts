// Phase 2 M3: assignment, reassignment, round-robin, assignment history (+ 0004 backfill),
// deactivation handover, in-app notifications, returning enquiries and the assigned-date
// filter, with the database boundary on the new tables.
import { readFileSync } from 'node:fs';
import { beforeAll, describe, expect, it } from 'vitest';
import * as leads from '@/modules/leads';
import * as members from '@/modules/members';
import * as notifications from '@/modules/notifications';
import * as teams from '@/modules/teams';
import { DomainError } from '@/platform/errors';
import { handleDomainEvent } from '@/worker/handlers';
import { migrator, withRole } from '../support/db';
import { actorIn, seedOrg, type Actor } from '../support/factory';

const APP = process.env.TEST_DATABASE_URL!;
const AUTH = process.env.TEST_AUTH_DATABASE_URL!;
const PLATFORM = process.env.TEST_PLATFORM_DATABASE_URL!;
const MIGRATOR = process.env.TEST_MIGRATOR_URL!;
const NEW_TABLES = ['lead_assignment_history', 'notification', 'team_assignment_state'];

let A: Awaited<ReturnType<typeof seedOrg>>;
let B: Awaited<ReturnType<typeof seedOrg>>;
const a = {} as Record<'owner' | 'admin' | 'manager' | 'exec1' | 'exec2' | 'hr', Actor>;
let ownerB: Actor;
let west: string; // manager leads; exec1 member
let east: string; // exec2 member; nobody leads it
let north: string; // admin, manager, exec1: round-robin pool
let empty: string; // only HR (not eligible to own leads)
let bTeam: string;

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

let seq = 0;
const phone = () => `96${String(40_000_000 + ++seq * 7_919).slice(-8)}`;

async function created(actor: Actor, input: Record<string, string> = {}) {
  const r = await leads.createLead(actor.ctx, {
    fullName: `Lead ${seq}`,
    primaryPhone: phone(),
    ...input,
  });
  if (r.status !== 'created') throw new Error('expected a new lead');
  return r.leadId;
}

const version = async (id: string) =>
  String((await migrator().lead.findUniqueOrThrow({ where: { id } })).version);

/** A lead in a team's (or the org's) unassigned queue. */
async function queued(teamId: string | null = west) {
  const id = await created(a.admin);
  await leads.assignLead(a.admin.ctx, id, {
    target: teamId ? `team:${teamId}` : 'queue',
    version: await version(id),
    reason: 'setup',
  });
  return id;
}

const spells = (leadId: string) =>
  migrator().leadAssignmentHistory.findMany({ where: { leadId }, orderBy: { startedAt: 'asc' } });

/** Runs every unprocessed lead outbox event of org A through the worker handler (twice). */
let handled = new Set<string>();
async function drainEvents(times = 2) {
  const events = await migrator().outboxEvent.findMany({
    where: { orgId: A.orgId, type: { startsWith: 'lead.' } },
    orderBy: { createdAt: 'asc' },
  });
  for (const e of events) {
    if (handled.has(e.id)) continue;
    for (let i = 0; i < times; i++)
      await handleDomainEvent({ eventId: e.id, orgId: e.orgId, type: e.type, payload: e.payload });
    handled.add(e.id);
  }
}

const notes = (userId: string) =>
  migrator().notification.findMany({ where: { recipientUserId: userId }, orderBy: { id: 'asc' } });

beforeAll(async () => {
  A = await seedOrg('AssignA');
  B = await seedOrg('AssignB');
  for (const k of ['owner', 'admin', 'manager', 'exec1', 'exec2', 'hr'] as const)
    a[k] = await actorIn(A.users[k], A.orgId);
  ownerB = await actorIn(B.users.owner, B.orgId);
  const mk = async (name: string, list: [string, 'LEAD' | 'MEMBER'][]) => {
    const id = (await teams.createTeam(a.owner.ctx, { name })).id;
    for (const [m, teamRole] of list)
      await teams.addTeamMember(a.owner.ctx, { teamId: id, membershipId: m, teamRole });
    return id;
  };
  west = await mk('West', [
    [A.membership.manager!, 'LEAD'],
    [A.membership.exec1!, 'MEMBER'],
  ]);
  east = await mk('East', [[A.membership.exec2!, 'MEMBER']]);
  north = await mk('North', [
    [A.membership.admin!, 'MEMBER'],
    [A.membership.manager!, 'MEMBER'],
    [A.membership.exec1!, 'MEMBER'],
  ]);
  empty = await mk('Empty', [[A.membership.hr!, 'MEMBER']]);
  bTeam = (await teams.createTeam(ownerB.ctx, { name: 'B Team' })).id;
});

describe('assign and reassign (FR-070, Workflow G)', () => {
  it('assigning a queued lead sets owner, team and stage, with history, audit and an event', async () => {
    const id = await queued();
    expect(await migrator().lead.findUniqueOrThrow({ where: { id } })).toMatchObject({
      ownerUserId: null,
      teamId: west,
      stage: 'NEW',
    });
    await leads.assignLead(a.admin.ctx, id, {
      target: `user:${A.users.exec1.id}`,
      version: await version(id),
      // Ignored: actor, org and timestamps come from the server.
      assignedBy: A.users.owner.id,
      orgId: B.orgId,
    });
    const lead = await migrator().lead.findUniqueOrThrow({ where: { id } });
    expect(lead).toMatchObject({ ownerUserId: A.users.exec1.id, teamId: west, stage: 'ASSIGNED' });
    const s = await spells(id);
    expect(s.map((x) => [x.userId, x.teamId, x.source, x.assignedBy])).toEqual([
      [A.users.admin.id, north, 'MANUAL', A.users.admin.id], // the creator's primary team
      [null, west, 'MANUAL', A.users.admin.id],
      [A.users.exec1.id, west, 'MANUAL', A.users.admin.id],
    ]);
    // Contiguous, exactly one open spell.
    for (let i = 0; i < s.length - 1; i++) expect(s[i]!.endedAt).toEqual(s[i + 1]!.startedAt);
    expect(s.filter((x) => x.endedAt === null)).toHaveLength(1);
    expect(
      await migrator().auditLog.count({ where: { action: 'lead.assigned', entityId: id } }),
    ).toBe(1);
    expect(
      await migrator().leadStageHistory.count({
        where: { leadId: id, fromStage: 'NEW', toStage: 'ASSIGNED', reasonCode: 'ASSIGNMENT' },
      }),
    ).toBe(1);
  });

  it('reassigning needs a reason and the current version', async () => {
    const id = await created(a.exec1);
    const v = await version(id);
    expect(
      await codeOf(
        leads.assignLead(a.admin.ctx, id, { target: `user:${A.users.exec2.id}`, version: v }),
      ),
    ).toBe('VALIDATION_FAILED');
    expect(
      await codeOf(
        leads.assignLead(a.admin.ctx, id, {
          target: `user:${A.users.exec2.id}`,
          version: '99',
          reason: 'x',
        }),
      ),
    ).toBe('CONFLICT');
    await leads.assignLead(a.admin.ctx, id, {
      target: `user:${A.users.exec2.id}`,
      version: v,
      reason: 'Speaks Marathi',
    });
    const lead = await migrator().lead.findUniqueOrThrow({ where: { id } });
    expect(lead).toMatchObject({ ownerUserId: A.users.exec2.id, teamId: east, stage: 'ASSIGNED' });
    expect((await spells(id)).at(-1)).toMatchObject({ reason: 'Speaks Marathi', endedAt: null });
    // The previous owner lost access immediately.
    expect(await codeOf(leads.getLead(a.exec1.ctx, id))).toBe('NOT_FOUND');
  });

  it('managers act only within the teams they lead', async () => {
    const mine = await created(a.exec1); // West
    const theirs = await created(a.exec2); // East
    const v = await version(mine);
    expect(
      await codeOf(
        leads.assignLead(a.manager.ctx, mine, {
          target: `user:${A.users.exec2.id}`,
          version: v,
          reason: 'r',
        }),
      ),
    ).toBe('VALIDATION_FAILED'); // target outside West
    expect(
      await codeOf(
        leads.assignLead(a.manager.ctx, mine, { target: `team:${east}`, version: v, reason: 'r' }),
      ),
    ).toBe('VALIDATION_FAILED');
    expect(
      await codeOf(
        leads.assignLead(a.manager.ctx, mine, { target: 'queue', version: v, reason: 'r' }),
      ),
    ).toBe('VALIDATION_FAILED'); // org-wide queue is ORG scope only
    expect(
      await codeOf(
        leads.assignLead(a.manager.ctx, theirs, {
          target: `user:${A.users.exec1.id}`,
          version: await version(theirs),
          reason: 'r',
        }),
      ),
    ).toBe('NOT_FOUND'); // lead outside the manager's scope
    await leads.assignLead(a.manager.ctx, mine, {
      target: `user:${A.users.manager.id}`,
      version: v,
      reason: 'Taking it myself',
    });
    expect((await migrator().lead.findUniqueOrThrow({ where: { id: mine } })).teamId).toBe(west);
  });

  it('executives, HR and other orgs cannot assign; targets must be eligible members of this org', async () => {
    const id = await queued();
    const v = await version(id);
    const tryAs = (actor: Actor, target: string) =>
      codeOf(leads.assignLead(actor.ctx, id, { target, version: v, reason: 'r' }));
    expect(await tryAs(a.exec1, `user:${A.users.exec1.id}`)).toBe('FORBIDDEN');
    expect(await tryAs(a.hr, `user:${A.users.exec1.id}`)).toBe('FORBIDDEN');
    expect(await tryAs(ownerB, `user:${B.users.exec1.id}`)).toBe('NOT_FOUND');
    for (const target of [
      `user:${A.users.hr.id}`, // role cannot own leads
      `user:${B.users.exec1.id}`, // another org's user
      `team:${bTeam}`, // another org's team
      `user:${A.users.exec1.id}x`,
      'user:not-a-uuid',
      "queue' OR 1=1",
      '',
    ])
      expect(await tryAs(a.admin, target), target).toBe('VALIDATION_FAILED');
    expect(await migrator().lead.findUniqueOrThrow({ where: { id } })).toMatchObject({
      ownerUserId: null,
      version: Number(v),
    });
  });

  it('a suspended member cannot receive leads', async () => {
    const id = await queued();
    await members.suspendMember(a.owner.ctx, A.membership.exec2!);
    try {
      expect(
        await codeOf(
          leads.assignLead(a.admin.ctx, id, {
            target: `user:${A.users.exec2.id}`,
            version: await version(id),
          }),
        ),
      ).toBe('VALIDATION_FAILED');
    } finally {
      await members.reactivateMember(a.owner.ctx, A.membership.exec2!);
      a.exec2 = await actorIn(A.users.exec2, A.orgId);
    }
  });

  it('moving to the org queue clears owner and team; closed leads are not reassigned', async () => {
    const id = await created(a.exec1);
    await leads.assignLead(a.admin.ctx, id, { target: 'queue', version: '1', reason: 'Re-pool' });
    expect(await migrator().lead.findUniqueOrThrow({ where: { id } })).toMatchObject({
      ownerUserId: null,
      teamId: null,
      stage: 'NEW',
    });
    expect((await spells(id)).every((s) => s.endedAt !== null)).toBe(true);
    const lost = await created(a.exec1);
    await leads.changeStage(a.exec1.ctx, lost, {
      toStage: 'LOST',
      version: '1',
      reasonCode: 'OTHER',
    });
    expect(
      await codeOf(
        leads.assignLead(a.admin.ctx, lost, {
          target: `user:${A.users.exec2.id}`,
          version: '2',
          reason: 'r',
        }),
      ),
    ).toBe('RULE_VIOLATION');
  });

  it('bulk assign is all-or-nothing and writes one audit entry', async () => {
    const ids = [await queued(), await queued(), await queued()];
    const outside = await created(ownerB);
    expect(
      await codeOf(
        leads.bulkAssign(a.admin.ctx, {
          leadIds: [...ids, outside],
          target: `user:${A.users.exec1.id}`,
        }),
      ),
    ).toBe('NOT_FOUND');
    for (const id of ids)
      expect((await migrator().lead.findUniqueOrThrow({ where: { id } })).ownerUserId).toBeNull();
    expect(
      await leads.bulkAssign(a.admin.ctx, { leadIds: ids, target: `user:${A.users.exec1.id}` }),
    ).toEqual({ moved: 3 });
    const audit = await migrator().auditLog.findFirstOrThrow({
      where: { orgId: A.orgId, action: 'lead.bulk_assigned' },
      orderBy: { occurredAt: 'desc' },
    });
    expect(audit.metadata).toMatchObject({ count: 3 });
  });
});

describe('round-robin (FR-073 basic)', () => {
  const pool = () =>
    [
      { m: A.membership.admin!, u: A.users.admin.id },
      { m: A.membership.manager!, u: A.users.manager.id },
      { m: A.membership.exec1!, u: A.users.exec1.id },
    ].sort((x, y) => (x.m < y.m ? -1 : 1));

  it('deals in membership order and continues from the pointer across calls', async () => {
    const first = [await queued(north), await queued(north)].sort();
    const second = [await queued(north), await queued(north)].sort();
    const r1 = await leads.roundRobinAssign(a.admin.ctx, { leadIds: first, teamId: north });
    const r2 = await leads.roundRobinAssign(a.admin.ctx, { leadIds: second, teamId: north });
    const order = pool().map((p) => p.u);
    const got = [...r1.assigned, ...r2.assigned].map((x) => x.userId);
    const start = order.indexOf(got[0]!);
    expect(got).toEqual([0, 1, 2, 3].map((i) => order[(start + i) % 3]));
    for (const { leadId, userId } of [...r1.assigned, ...r2.assigned]) {
      const s = (await spells(leadId)).at(-1)!;
      expect(s).toMatchObject({ userId, teamId: north, source: 'ROUND_ROBIN', endedAt: null });
    }
  });

  it('concurrent requests share one pointer: everyone gets the same number', async () => {
    const batches = await Promise.all(
      [0, 1, 2].map(async () => [await queued(north), await queued(north)]),
    );
    const results = await Promise.all(
      batches.map((leadIds) => leads.roundRobinAssign(a.admin.ctx, { leadIds, teamId: north })),
    );
    const counts = new Map<string, number>();
    for (const r of results)
      for (const x of r.assigned) counts.set(x.userId, (counts.get(x.userId) ?? 0) + 1);
    expect([...counts.values()].sort()).toEqual([2, 2, 2]);
    const all = batches.flat();
    const owned = await migrator().lead.findMany({ where: { id: { in: all } } });
    expect(owned.every((l) => l.ownerUserId && l.stage === 'ASSIGNED')).toBe(true);
  });

  it('skips inactive members, refuses an empty pool and already-owned leads', async () => {
    await members.suspendMember(a.owner.ctx, A.membership.exec1!);
    try {
      const ids = [await queued(north), await queued(north), await queued(north)];
      const r = await leads.roundRobinAssign(a.admin.ctx, { leadIds: ids, teamId: north });
      expect(r.assigned.map((x) => x.userId)).not.toContain(A.users.exec1.id);
    } finally {
      await members.reactivateMember(a.owner.ctx, A.membership.exec1!);
      a.exec1 = await actorIn(A.users.exec1, A.orgId);
    }
    const lonely = await queued(empty);
    expect(
      await codeOf(leads.roundRobinAssign(a.admin.ctx, { leadIds: [lonely], teamId: empty })),
    ).toBe('RULE_VIOLATION');
    expect(
      (await migrator().lead.findUniqueOrThrow({ where: { id: lonely } })).ownerUserId,
    ).toBeNull();
    const owned = await created(a.exec1);
    expect(
      await codeOf(leads.roundRobinAssign(a.admin.ctx, { leadIds: [owned], teamId: north })),
    ).toBe('RULE_VIOLATION');
    expect(
      await codeOf(leads.roundRobinAssign(a.manager.ctx, { leadIds: [lonely], teamId: north })),
    ).toBe('VALIDATION_FAILED'); // the manager does not lead North
    expect(
      await codeOf(leads.roundRobinAssign(a.exec1.ctx, { leadIds: [lonely], teamId: west })),
    ).toBe('FORBIDDEN');
  });
});

describe('notifications (FR-075, FR-118, FR-120)', () => {
  beforeAll(async () => {
    await drainEvents(); // everything so far
    handled = new Set(
      (await migrator().outboxEvent.findMany({ where: { orgId: A.orgId } })).map((e) => e.id),
    );
    await migrator().notification.updateMany({
      where: { orgId: A.orgId },
      data: { readAt: new Date() },
    });
  });

  it('one notification for the new owner, deduplicated across redelivery', async () => {
    const id = await queued();
    await leads.assignLead(a.manager.ctx, id, {
      target: `user:${A.users.exec1.id}`,
      version: await version(id),
    });
    await drainEvents(3);
    const mine = (await notes(A.users.exec1.id)).filter((n) => !n.readAt);
    expect(mine).toHaveLength(1);
    expect(mine[0]).toMatchObject({ type: 'LEAD_ASSIGNED', link: `/app/leads/${id}` });
    expect(await notifications.unreadCount(a.exec1.ctx)).toBe(1);
  });

  it('bulk assignment sends one digest; the previous owner gets a count without details', async () => {
    const ids = [await created(a.exec2), await created(a.exec2), await created(a.exec2)];
    await leads.bulkAssign(a.admin.ctx, {
      leadIds: ids,
      target: `user:${A.users.exec1.id}`,
      reason: 'Rebalance',
    });
    await drainEvents();
    const digest = (await notes(A.users.exec1.id)).filter(
      (n) => n.type === 'LEADS_ASSIGNED_DIGEST' && !n.readAt,
    );
    expect(digest).toHaveLength(1);
    expect(digest[0]).toMatchObject({ title: '3 leads assigned to you', link: '/app/leads' });
    const away = (await notes(A.users.exec2.id)).filter((n) => n.type === 'LEADS_REASSIGNED_AWAY');
    expect(away.at(-1)).toMatchObject({ link: null, title: '3 leads were reassigned' });
    expect(JSON.stringify(away)).not.toMatch(/Lead \d|\/app\/leads\//);
  });

  it('no self-notification, and no notice for a lead reassigned again before delivery', async () => {
    const id = await queued();
    await leads.assignLead(a.admin.ctx, id, {
      target: `user:${A.users.admin.id}`,
      version: await version(id),
    });
    await leads.assignLead(a.admin.ctx, id, {
      target: `user:${A.users.exec2.id}`,
      version: await version(id),
      reason: 'Changed my mind',
    });
    // Deliver the first event only after the second change: admin assigned to self (skipped).
    await drainEvents();
    expect(
      (await notes(A.users.admin.id)).filter(
        (n) => n.data && (n.data as { leadId?: string }).leadId === id,
      ),
    ).toEqual([]);
    expect(
      (await notes(A.users.exec2.id)).filter((n) => (n.data as { leadId?: string }).leadId === id),
    ).toHaveLength(1);
    // A stale event (lead since moved away from its recipient) produces nothing.
    const stale = await migrator().outboxEvent.create({
      data: {
        orgId: A.orgId,
        type: 'lead.assigned',
        payload: {
          leadIds: [id],
          toUserId: A.users.exec1.id,
          teamId: west,
          previousOwners: [],
          actorUserId: A.users.admin.id,
          source: 'MANUAL',
        },
      },
    });
    expect(
      await handleDomainEvent({
        eventId: stale.id,
        orgId: A.orgId,
        type: stale.type,
        payload: stale.payload,
      }),
    ).toBe('skipped');
  });

  it('recipients read and mark only their own notifications', async () => {
    const [n] = (await notes(A.users.exec1.id)).filter((x) => !x.readAt);
    expect(
      (await notifications.listNotifications(a.exec2.ctx)).rows.map((r) => r.id),
    ).not.toContain(n!.id);
    expect(await codeOf(notifications.markRead(a.exec2.ctx, n!.id))).toBe('NOT_FOUND');
    expect(await codeOf(notifications.markRead(a.owner.ctx, n!.id))).toBe('NOT_FOUND');
    expect(await codeOf(notifications.markRead(ownerB.ctx, n!.id))).toBe('NOT_FOUND');
    expect(
      (await migrator().notification.findUniqueOrThrow({ where: { id: n!.id } })).readAt,
    ).toBeNull();
    await notifications.markRead(a.exec1.ctx, n!.id);
    expect(
      (await migrator().notification.findUniqueOrThrow({ where: { id: n!.id } })).readAt,
    ).not.toBeNull();
    await notifications.markAllRead(a.exec1.ctx);
    expect(await notifications.unreadCount(a.exec1.ctx)).toBe(0);
    expect(await notifications.unreadCount(ownerB.ctx)).toBe(0);
  });
});

describe('returning enquiries (lead-lifecycle §5, FR-055)', () => {
  it('an out-of-scope duplicate notifies the owner and reveals nothing to the reporter', async () => {
    const p = phone();
    const id = await created(a.exec1, { primaryPhone: p, fullName: 'Returning Customer' });
    const dup = await leads.createLead(a.exec2.ctx, { fullName: 'Walk-in', primaryPhone: `0${p}` });
    expect(dup).toEqual({
      status: 'duplicate',
      leadId: null,
      canAttach: false,
      archived: false,
    });
    const r = await leads.reportDuplicateToOwner(a.exec2.ctx, { primaryPhone: `+91 ${p}` });
    expect(r).toEqual({ reported: true });
    expect(await migrator().leadEnquiry.count({ where: { leadId: id } })).toBe(2);
    await drainEvents();
    const n = (await notes(A.users.exec1.id)).filter((x) => x.type === 'LEAD_RETURNING_ENQUIRY');
    expect(n.at(-1)).toMatchObject({
      body: 'Returning Customer enquired again.',
      link: `/app/leads/${id}`,
    });
    expect((await notes(A.users.exec2.id)).some((x) => x.link === `/app/leads/${id}`)).toBe(false);
    expect(await codeOf(leads.getLead(a.exec2.ctx, id))).toBe('NOT_FOUND');
  });

  it('the owner attaching their own enquiry is not notified; closed matches start a new lead', async () => {
    const p = phone();
    const id = await created(a.exec1, { primaryPhone: p });
    const before = (await notes(A.users.exec1.id)).length;
    await leads.attachEnquiry(a.exec1.ctx, id, {});
    await drainEvents();
    expect((await notes(A.users.exec1.id)).length).toBe(before);
    await leads.changeStage(a.exec1.ctx, id, {
      toStage: 'LOST',
      version: '1',
      reasonCode: 'OTHER',
    });
    expect(await leads.reportDuplicateToOwner(a.exec2.ctx, { primaryPhone: p })).toEqual({
      reported: false,
    });
    const again = await leads.createLead(a.exec2.ctx, { fullName: 'Back again', primaryPhone: p });
    expect(again.status).toBe('created');
    await drainEvents();
    expect((await notes(A.users.exec1.id)).length).toBe(before);
  });
});

describe('assigned-date filter (FR-056, M2 deferred)', () => {
  it('filters by the current owner spell start in the org time zone, with stable cursors', async () => {
    const today = new Date(Date.now() + 5.5 * 36e5).toISOString().slice(0, 10);
    const ids = new Set<string>();
    let cursor: string | null = null;
    for (let i = 0; i < 20; i++) {
      const page: Awaited<ReturnType<typeof leads.searchLeads>> = await leads.searchLeads(
        a.admin.ctx,
        { assignedFrom: today, assignedTo: today, ...(cursor ? { cursor } : {}) },
      );
      expect(page.errors).toEqual({});
      for (const r of page.rows) {
        expect(ids.has(r.id)).toBe(false);
        ids.add(r.id);
      }
      cursor = page.nextCursor;
      if (!cursor) break;
    }
    const expected = await migrator().leadAssignmentHistory.count({
      where: { orgId: A.orgId, endedAt: null, userId: { not: null } },
    });
    expect(ids.size).toBe(expected);
    expect((await leads.searchLeads(a.admin.ctx, { assignedTo: '2020-01-01' })).rows).toEqual([]);
    expect(
      (await leads.searchLeads(a.exec2.ctx, { assignedFrom: today })).rows.every(
        (r) => r.ownerName === A.users.exec2.name,
      ),
    ).toBe(true);
    expect(
      Object.keys((await leads.searchLeads(a.admin.ctx, { assignedFrom: 'today' })).errors),
    ).toEqual(['assignedFrom']);
  });
});

describe('deactivation handover (FR-077)', () => {
  it('refuses to orphan open leads, then hands them over atomically with the deactivation', async () => {
    const open1 = await created(a.exec2);
    const open2 = await created(a.exec2);
    const lost = await created(a.exec2);
    await leads.changeStage(a.exec2.ctx, lost, {
      toStage: 'LOST',
      version: '1',
      reasonCode: 'OTHER',
    });
    const status = async () =>
      (await migrator().member.findUniqueOrThrow({ where: { id: A.membership.exec2! } })).status;

    expect(await codeOf(members.deactivateMember(a.owner.ctx, A.membership.exec2!))).toBe(
      'RULE_VIOLATION',
    );
    // Invalid targets roll everything back: the departing user, HR, another org's user.
    for (const target of [
      `user:${A.users.exec2.id}`,
      `user:${A.users.hr.id}`,
      `user:${B.users.exec1.id}`,
    ])
      expect(
        await codeOf(members.deactivateMember(a.owner.ctx, A.membership.exec2!, target)),
        target,
      ).toBe('VALIDATION_FAILED');
    expect(await status()).toBe('ACTIVE');
    expect((await migrator().lead.findUniqueOrThrow({ where: { id: open1 } })).ownerUserId).toBe(
      A.users.exec2.id,
    );

    await members.deactivateMember(a.owner.ctx, A.membership.exec2!, `user:${A.users.exec1.id}`);
    expect(await status()).toBe('DEACTIVATED');
    for (const id of [open1, open2]) {
      expect((await migrator().lead.findUniqueOrThrow({ where: { id } })).ownerUserId).toBe(
        A.users.exec1.id,
      );
      const s = await spells(id);
      expect(s.at(-2)).toMatchObject({ userId: A.users.exec2.id }); // history kept
      expect(s.at(-1)).toMatchObject({ userId: A.users.exec1.id, source: 'DEACTIVATION' });
    }
    expect(
      await migrator().lead.count({
        where: { orgId: A.orgId, ownerUserId: A.users.exec2.id, stage: { notIn: ['WON', 'LOST'] } },
      }),
    ).toBe(0);
    expect((await migrator().lead.findUniqueOrThrow({ where: { id: lost } })).ownerUserId).toBe(
      A.users.exec2.id,
    );
    const handovers = () =>
      migrator().auditLog.count({ where: { orgId: A.orgId, action: 'lead.handover' } });
    expect(await handovers()).toBe(1);

    // Retry: already deactivated, nothing more happens.
    const spellCount = (await spells(open1)).length;
    await members.deactivateMember(a.owner.ctx, A.membership.exec2!, `user:${A.users.exec1.id}`);
    expect((await spells(open1)).length).toBe(spellCount);
    expect(await handovers()).toBe(1);
    // The handover event notifies the new owner once; the deactivated person gets nothing.
    const exec2Before = (await notes(A.users.exec2.id)).length;
    const exec1Before = (await notes(A.users.exec1.id)).length;
    await drainEvents();
    expect((await notes(A.users.exec2.id)).length).toBe(exec2Before);
    expect((await notes(A.users.exec1.id)).length).toBe(exec1Before + 1);

    // A deactivated person is never a target again.
    const q = await queued();
    expect(
      await codeOf(
        leads.assignLead(a.admin.ctx, q, {
          target: `user:${A.users.exec2.id}`,
          version: await version(q),
        }),
      ),
    ).toBe('VALIDATION_FAILED');
  });
});

describe('0004 backfill and the database boundary', () => {
  const backfillSql = () => {
    const sql = readFileSync('prisma/migrations/0004_assignment/migration.sql', 'utf8');
    return sql.slice(sql.indexOf('INSERT INTO lead_assignment_history'));
  };

  it('backfill records one creation spell for owned/queued leads, nothing else, and is idempotent', async () => {
    const m = migrator();
    const src = await m.leadSource.findFirstOrThrow({ where: { orgId: A.orgId } });
    const base = {
      orgId: A.orgId,
      sourceId: src.id,
      stage: 'ASSIGNED' as const,
      primaryPhoneRaw: 'x',
    };
    const p1 = `+91${phone()}`;
    const p2 = `+91${phone()}`;
    const p3 = `+91${phone()}`;
    // As M1 left them: no spells.
    const owned = await m.lead.create({
      data: {
        ...base,
        fullName: 'M1 owned',
        primaryPhoneE164: p1,
        phoneLast10: p1.slice(-10),
        ownerUserId: A.users.exec1.id,
        teamId: west,
        createdBy: A.users.exec1.id,
      },
    });
    const queuedOnly = await m.lead.create({
      data: {
        ...base,
        stage: 'NEW',
        fullName: 'M1 team queue',
        primaryPhoneE164: p2,
        phoneLast10: p2.slice(-10),
        teamId: west,
      },
    });
    const neither = await m.lead.create({
      data: {
        ...base,
        stage: 'NEW',
        fullName: 'M1 nowhere',
        primaryPhoneE164: p3,
        phoneLast10: p3.slice(-10),
      },
    });
    const before = await m.leadAssignmentHistory.count();
    await m.$executeRawUnsafe(backfillSql());
    await m.$executeRawUnsafe(backfillSql()); // rerun: no change
    expect(await m.leadAssignmentHistory.count()).toBe(before + 2);
    expect(await spells(owned.id)).toMatchObject([
      {
        userId: A.users.exec1.id,
        teamId: west,
        startedAt: owned.createdAt,
        assignedBy: A.users.exec1.id,
        source: 'MANUAL',
        endedAt: null,
      },
    ]);
    expect(await spells(queuedOnly.id)).toMatchObject([
      { userId: null, teamId: west, endedAt: null },
    ]);
    expect(await spells(neither.id)).toEqual([]);
  });

  it('the database rejects overlapping spells even for the schema owner', async () => {
    const id = await created(a.exec1);
    await expect(
      migrator().leadAssignmentHistory.create({
        data: {
          orgId: A.orgId,
          leadId: id,
          userId: A.users.exec1.id,
          source: 'MANUAL',
          startedAt: new Date(Date.now() - 864e5),
        },
      }),
    ).rejects.toThrow(/lead_assignment_history_no_overlap|open_uq|Unique constraint|exclusion/i);
  });

  it('RLS forced with a tenant policy; minimum grants; nothing for crm_auth/crm_platform', async () => {
    await withRole(MIGRATOR, async (c) => {
      const rls = await c.query(
        `SELECT c.relname, c.relrowsecurity AND c.relforcerowsecurity AS forced,
                EXISTS (SELECT 1 FROM pg_policies p WHERE p.tablename = c.relname
                        AND p.policyname = 'tenant_isolation' AND 'crm_app' = ANY (p.roles)) AS tenant
         FROM pg_class c WHERE c.relnamespace = 'public'::regnamespace AND c.relname = ANY ($1) ORDER BY 1`,
        [NEW_TABLES],
      );
      expect(rls.rows).toEqual(NEW_TABLES.map((t) => ({ relname: t, forced: true, tenant: true })));
      const grants = await c.query(
        `SELECT grantee, table_name, string_agg(privilege_type, ',' ORDER BY privilege_type) AS p
         FROM information_schema.role_table_grants
         WHERE table_schema = 'public' AND table_name = ANY ($1)
           AND grantee IN ('crm_app', 'crm_auth', 'crm_platform', 'crm_definer')
         GROUP BY 1, 2 ORDER BY 1, 2`,
        [NEW_TABLES],
      );
      expect(grants.rows).toEqual(
        NEW_TABLES.map((t) => ({ grantee: 'crm_app', table_name: t, p: 'INSERT,SELECT' })),
      );
      const cols = await c.query(
        `SELECT table_name, string_agg(column_name, ',' ORDER BY column_name) AS cols
         FROM information_schema.column_privileges
         WHERE grantee = 'crm_app' AND privilege_type = 'UPDATE' AND table_name = ANY ($1)
         GROUP BY 1 ORDER BY 1`,
        [NEW_TABLES],
      );
      expect(cols.rows).toEqual([
        { table_name: 'lead_assignment_history', cols: 'ended_at' },
        { table_name: 'notification', cols: 'read_at' },
        { table_name: 'team_assignment_state', cols: 'last_assigned_membership_id,updated_at' },
      ]);
    });
    for (const url of [AUTH, PLATFORM])
      await withRole(url, async (c) => {
        for (const t of NEW_TABLES)
          await expect(c.query(`SELECT 1 FROM ${t} LIMIT 1`), t).rejects.toThrow(
            /permission denied/,
          );
      });
  });

  /** Raw crm_app session as `userId` (null = system actor) in org A, rolled back afterwards. */
  async function asApp<T>(
    userId: string | null,
    fn: (
      q: (sql: string, v?: unknown[]) => Promise<{ rows: unknown[]; rowCount: number | null }>,
    ) => Promise<T>,
  ) {
    return withRole(APP, async (c) => {
      await c.query('BEGIN');
      try {
        await c.query(
          "SELECT set_config('app.org_id', $1, true), set_config('app.user_id', $2, true)",
          [A.orgId, userId ?? ''],
        );
        return await fn((sql, v) => c.query(sql, v));
      } finally {
        await c.query('ROLLBACK');
      }
    });
  }

  it('history cannot be forged or rewritten; notifications only by the system, read only by the recipient', async () => {
    const id = await created(a.exec1);
    const bLead = await created(ownerB);
    const e1 = A.users.exec1.id;
    const forged: [string, string | null, string, unknown[]][] = [
      [
        'spell attributed to someone else',
        e1,
        `INSERT INTO lead_assignment_history (org_id, lead_id, user_id, assigned_by, source) VALUES ($1, $2, $3, $4, 'MANUAL')`,
        [A.orgId, id, e1, A.users.owner.id],
      ],
      [
        'backdated spell',
        e1,
        `INSERT INTO lead_assignment_history (org_id, lead_id, user_id, assigned_by, source, started_at) VALUES ($1, $2, $3, $3, 'MANUAL', now() - interval '1 day')`,
        [A.orgId, id, e1],
      ],
      [
        'spell on another org lead',
        e1,
        `INSERT INTO lead_assignment_history (org_id, lead_id, user_id, assigned_by, source) VALUES ($1, $2, $3, $3, 'MANUAL')`,
        [A.orgId, bLead, e1],
      ],
      [
        'spell for another org user',
        e1,
        `INSERT INTO lead_assignment_history (org_id, lead_id, user_id, assigned_by, source) VALUES ($1, $2, $3, $4, 'MANUAL')`,
        [A.orgId, id, B.users.exec1.id, e1],
      ],
      [
        'close a spell in the past',
        e1,
        `UPDATE lead_assignment_history SET ended_at = now() - interval '1 day' WHERE lead_id = $1`,
        [id],
      ],
      ['rewrite the owner', e1, `UPDATE lead_assignment_history SET user_id = NULL`, []],
      ['delete history', e1, `DELETE FROM lead_assignment_history`, []],
      [
        'user writes a notification',
        e1,
        `INSERT INTO notification (org_id, recipient_user_id, type, title, body) VALUES ($1, $2, 'LEAD_ASSIGNED', 't', 'b')`,
        [A.orgId, A.users.exec2.id],
      ],
      [
        'system writes into another org',
        null,
        `INSERT INTO notification (org_id, recipient_user_id, type, title, body) VALUES ($1, $2, 'LEAD_ASSIGNED', 't', 'b')`,
        [B.orgId, B.users.exec1.id],
      ],
      [
        'external link',
        null,
        `INSERT INTO notification (org_id, recipient_user_id, type, title, body, link) VALUES ($1, $2, 'LEAD_ASSIGNED', 't', 'b', 'https://evil.example')`,
        [A.orgId, e1],
      ],
      ['delete notifications', e1, `DELETE FROM notification`, []],
      [
        'move the round-robin pointer to another org team',
        e1,
        `INSERT INTO team_assignment_state (team_id, org_id) VALUES ($1, $2)`,
        [bTeam, A.orgId],
      ],
    ];
    for (const [what, user, sql, values] of forged)
      await expect(
        asApp(user, (q) => q(sql, values)),
        what,
      ).rejects.toThrow(/row-level security|permission denied|foreign key|violates/);
    // Closed spells stay closed: the UPDATE matches nothing.
    await asApp(e1, async (q) => {
      const r = await q(
        `UPDATE lead_assignment_history SET ended_at = now() WHERE ended_at IS NOT NULL`,
      );
      expect(r.rowCount).toBe(0);
    });
    // Another member's notifications are invisible and unmarkable.
    await asApp(A.users.exec2.id === e1 ? null : A.users.manager.id, async (q) => {
      const seen = await q(
        'SELECT count(*)::int AS n FROM notification WHERE recipient_user_id = $1',
        [e1],
      );
      expect((seen.rows[0] as { n: number }).n).toBe(0);
      const upd = await q('UPDATE notification SET read_at = now() WHERE recipient_user_id = $1', [
        e1,
      ]);
      expect(upd.rowCount).toBe(0);
    });
  });
});
