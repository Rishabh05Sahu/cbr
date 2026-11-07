// FR-063 bulk "change team" and "add tag" (migration 0011): all-or-nothing, scope-checked,
// audited, through the existing assignment path (history, timeline) for teams; idempotent links
// for tags. Unauthorized roles, other orgs' teams/tags/leads, duplicates, empty and invalid input,
// closed/archived leads, and the database rules. Synthetic data only.
import { randomUUID } from 'node:crypto';
import { beforeAll, describe, expect, it } from 'vitest';
import * as leads from '@/modules/leads';
import * as teams from '@/modules/teams';
import { DomainError } from '@/platform/errors';
import { migrator } from '../support/db';
import { actorIn, seedOrg, type Actor } from '../support/factory';

let A: Awaited<ReturnType<typeof seedOrg>>;
let B: Awaited<ReturnType<typeof seedOrg>>;
const a = {} as Record<'owner' | 'admin' | 'manager' | 'exec1' | 'exec2', Actor>;
let ownerB: Actor;
let west: string;
let east: string;
let north: string;
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
const phone = () => `95${String(20_000_000 + ++seq * 6_311 + (process.pid % 1000)).slice(-8)}`;
async function created(by: Actor): Promise<string> {
  const r = await leads.createLead(by.ctx, { fullName: 'Synthetic Bulk', primaryPhone: phone() });
  if (r.status !== 'created') throw new Error('fixture lead');
  return r.leadId;
}
const lead = (id: string) => migrator().lead.findUniqueOrThrow({ where: { id } });
const teamOf = async (ids: string[]) => (await Promise.all(ids.map(lead))).map((l) => l.teamId);
/** An admin-created (admin-owned) lead moved to West's unassigned queue (a reassignment). */
const toWestQueue = async (id: string) =>
  leads.assignLead(a.admin.ctx, id, {
    target: `team:${west}`,
    version: (await lead(id)).version,
    reason: 'Synthetic: to the team queue',
  });

beforeAll(async () => {
  A = await seedOrg('BulkA');
  B = await seedOrg('BulkB');
  for (const k of ['owner', 'admin', 'manager', 'exec1', 'exec2'] as const)
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
    [A.membership.manager!, 'MEMBER'],
    [A.membership.exec1!, 'MEMBER'],
  ]);
  bTeam = (await teams.createTeam(ownerB.ctx, { name: 'B Team' })).id;
});

describe('bulk change team', () => {
  it('moves owned and queued leads, keeping owners, with history, timeline and one audit entry', async () => {
    const owned = [await created(a.exec1), await created(a.exec1)]; // exec1: primary team West
    const queued = await created(a.admin);
    await toWestQueue(queued);
    expect(await teamOf([...owned, queued])).toEqual([west, west, west]);
    const eventsBefore = await migrator().outboxEvent.count({
      where: { orgId: A.orgId, type: 'lead.assigned' },
    });

    const r = await leads.bulkChangeTeam(a.admin.ctx, {
      leadIds: [...owned, queued, owned[0]!.toUpperCase()], // duplicate (other case) counted once
      teamId: north,
      orgId: B.orgId, // ignored: the org is the session's
    });
    expect(r).toEqual({ moved: 3, unchanged: 0 });
    for (const id of owned)
      expect(await lead(id)).toMatchObject({ teamId: north, ownerUserId: A.users.exec1.id });
    expect(await lead(queued)).toMatchObject({ teamId: north, ownerUserId: null });
    // Assignment history: the open spell is the new team, source BULK, by the admin.
    const open = await migrator().leadAssignmentHistory.findFirstOrThrow({
      where: { leadId: owned[0]!, endedAt: null },
    });
    expect(open).toMatchObject({
      userId: A.users.exec1.id,
      teamId: north,
      source: 'BULK',
      assignedBy: A.users.admin.id,
    });
    expect(
      await migrator().leadActivity.count({
        where: { leadId: owned[0]!, type: 'ASSIGNED', actorId: A.users.admin.id },
      }),
    ).toBe(1);
    const audit = await migrator().auditLog.findFirstOrThrow({
      where: { orgId: A.orgId, action: 'lead.bulk_team_changed' },
      orderBy: { id: 'desc' },
    });
    expect(audit.metadata).toMatchObject({ count: 3, teamId: north });
    expect(JSON.stringify(audit.metadata)).not.toContain('Synthetic');
    // Owners did not change: nobody is notified.
    expect(
      await migrator().outboxEvent.count({ where: { orgId: A.orgId, type: 'lead.assigned' } }),
    ).toBe(eventsBefore);

    // Again: already in the team, nothing to do.
    expect(await leads.bulkChangeTeam(a.admin.ctx, { leadIds: owned, teamId: north })).toEqual({
      moved: 0,
      unchanged: 2,
    });
  });

  it('refuses the whole request when an owner is not in the target team', async () => {
    const mine = await created(a.exec1);
    const queued = await created(a.admin);
    await toWestQueue(queued);
    const before = await teamOf([mine, queued]);
    const err = await leads
      .bulkChangeTeam(a.admin.ctx, { leadIds: [mine, queued], teamId: east })
      .catch((e: unknown) => e as DomainError);
    expect(err).toBeInstanceOf(DomainError);
    expect((err as DomainError).code).toBe('RULE_VIOLATION');
    expect((err as DomainError).message).toMatch(
      /^1 selected lead is owned by someone .* Reassign it first/,
    );
    expect(await teamOf([mine, queued])).toEqual(before);
  });

  it('refuses invalid, archived and other organisations’ teams', async () => {
    const id = await created(a.exec1);
    const archived = (await teams.createTeam(a.owner.ctx, { name: 'Gone' })).id;
    await migrator().team.update({ where: { id: archived }, data: { archivedAt: new Date() } });
    for (const teamId of [bTeam, archived, randomUUID()])
      expect(await codeOf(leads.bulkChangeTeam(a.admin.ctx, { leadIds: [id], teamId }))).toBe(
        'VALIDATION_FAILED',
      );
    expect(await codeOf(leads.bulkChangeTeam(a.admin.ctx, { leadIds: [id], teamId: 'x' }))).toBe(
      'VALIDATION_FAILED',
    );
    expect((await lead(id)).teamId).toBe(west);
  });

  it('respects roles and scope: executives cannot, managers only within teams they lead', async () => {
    const own = await created(a.exec1);
    expect(await codeOf(leads.bulkChangeTeam(a.exec1.ctx, { leadIds: [own], teamId: north }))).toBe(
      'FORBIDDEN',
    );
    // The manager leads West only: North is not theirs to move into.
    expect(
      await codeOf(leads.bulkChangeTeam(a.manager.ctx, { leadIds: [own], teamId: north })),
    ).toBe('VALIDATION_FAILED');
    // A lead in East is outside the manager's scope: indistinguishable from a missing one.
    const eastLead = await created(a.exec2);
    expect(
      await codeOf(leads.bulkChangeTeam(a.manager.ctx, { leadIds: [eastLead], teamId: west })),
    ).toBe('NOT_FOUND');
  });

  it('other organisations’ leads, closed leads, empty and invalid selections change nothing', async () => {
    const mine = await created(a.exec1);
    const theirs = await created(ownerB);
    expect(
      await codeOf(leads.bulkChangeTeam(a.admin.ctx, { leadIds: [mine, theirs], teamId: north })),
    ).toBe('NOT_FOUND');
    expect((await lead(mine)).teamId).toBe(west);
    await migrator().lead.update({ where: { id: mine }, data: { stage: 'WON' } });
    expect(
      await codeOf(leads.bulkChangeTeam(a.admin.ctx, { leadIds: [mine], teamId: north })),
    ).toBe('RULE_VIOLATION');
    for (const leadIds of [[], ['not-a-uuid'], Array.from({ length: 101 }, () => randomUUID())])
      expect(await codeOf(leads.bulkChangeTeam(a.admin.ctx, { leadIds, teamId: north }))).toBe(
        'VALIDATION_FAILED',
      );
  });
});

describe('lead tags and bulk add tag', () => {
  let hot: string;

  it('Owner/Admin create tags (normalized, no duplicates); others cannot', async () => {
    hot = (await leads.createLeadTag(a.owner.ctx, { name: '  Hot   lead ' })).id;
    expect(await migrator().leadTag.findUniqueOrThrow({ where: { id: hot } })).toMatchObject({
      orgId: A.orgId,
      name: 'Hot lead',
      createdBy: A.users.owner.id,
    });
    expect(
      await migrator().auditLog.count({ where: { action: 'lead_tag.created', entityId: hot } }),
    ).toBe(1);
    for (const name of ['hot lead', 'HOT  LEAD'])
      expect(await codeOf(leads.createLeadTag(a.admin.ctx, { name }))).toBe('CONFLICT');
    for (const name of ['  ', 'x'.repeat(51)])
      expect(await codeOf(leads.createLeadTag(a.admin.ctx, { name }))).toBe('VALIDATION_FAILED');
    for (const who of [a.manager, a.exec1])
      expect(await codeOf(leads.createLeadTag(who.ctx, { name: 'Nope' }))).toBe('FORBIDDEN');
    expect((await leads.listLeadTags(a.exec1.ctx)).map((t) => t.name)).toContain('Hot lead');
    expect((await leads.listLeadTags(ownerB.ctx)).map((t) => t.id)).not.toContain(hot);
  });

  it('adds the tag once per lead; already-tagged leads are counted, never duplicated', async () => {
    const ids = [await created(a.exec1), await created(a.exec2), await created(a.admin)];
    expect(await leads.bulkAddTag(a.admin.ctx, { leadIds: ids.slice(0, 2), tagId: hot })).toEqual({
      added: 2,
      alreadyTagged: 0,
    });
    expect(
      await leads.bulkAddTag(a.owner.ctx, {
        leadIds: [...ids, ids[0]!.toUpperCase()],
        tagId: hot,
        orgId: B.orgId, // ignored
      }),
    ).toEqual({ added: 1, alreadyTagged: 2 });
    expect(await migrator().leadTagLink.count({ where: { tagId: hot, leadId: { in: ids } } })).toBe(
      3,
    );
    const link = await migrator().leadTagLink.findFirstOrThrow({ where: { leadId: ids[2]! } });
    expect(link).toMatchObject({ orgId: A.orgId, addedBy: A.users.owner.id });
    const audits = await migrator().auditLog.findMany({
      where: { orgId: A.orgId, action: 'lead.bulk_tagged' },
      orderBy: { id: 'asc' },
    });
    expect(audits.map((x) => (x.metadata as { count: number }).count).slice(-2)).toEqual([2, 1]);
    expect((await leads.tagsForLead(a.exec1.ctx, ids[0]!)).map((t) => t.name)).toEqual([
      'Hot lead',
    ]);
    expect(await codeOf(leads.tagsForLead(ownerB.ctx, ids[0]!))).toBe('NOT_FOUND');
    // Nothing new to add: no new audit entry.
    expect(await leads.bulkAddTag(a.admin.ctx, { leadIds: ids, tagId: hot })).toEqual({
      added: 0,
      alreadyTagged: 3,
    });
    expect(
      await migrator().auditLog.count({ where: { orgId: A.orgId, action: 'lead.bulk_tagged' } }),
    ).toBe(audits.length);
  });

  it('managers and executives cannot bulk-tag; other orgs’ tags and leads are not found', async () => {
    const id = await created(a.exec1);
    for (const who of [a.manager, a.exec1])
      expect(await codeOf(leads.bulkAddTag(who.ctx, { leadIds: [id], tagId: hot }))).toBe(
        'FORBIDDEN',
      );
    const bTag = (await leads.createLeadTag(ownerB.ctx, { name: 'B tag' })).id;
    expect(await codeOf(leads.bulkAddTag(a.admin.ctx, { leadIds: [id], tagId: bTag }))).toBe(
      'NOT_FOUND',
    );
    const theirs = await created(ownerB);
    expect(await codeOf(leads.bulkAddTag(a.admin.ctx, { leadIds: [id, theirs], tagId: hot }))).toBe(
      'NOT_FOUND',
    );
    expect(await codeOf(leads.bulkAddTag(ownerB.ctx, { leadIds: [id], tagId: bTag }))).toBe(
      'NOT_FOUND',
    );
    expect(await migrator().leadTagLink.count({ where: { leadId: { in: [id, theirs] } } })).toBe(0);
  });

  it('archived leads, empty and invalid input tag nothing', async () => {
    const [ok, gone] = [await created(a.exec1), await created(a.exec1)];
    await leads.archiveLead(a.admin.ctx, gone, { version: (await lead(gone)).version });
    expect(await codeOf(leads.bulkAddTag(a.admin.ctx, { leadIds: [ok, gone], tagId: hot }))).toBe(
      'RULE_VIOLATION',
    );
    expect(await migrator().leadTagLink.count({ where: { leadId: ok } })).toBe(0);
    for (const input of [
      { leadIds: [], tagId: hot },
      { leadIds: ['nope'], tagId: hot },
      { leadIds: [ok], tagId: 'nope' },
      { leadIds: [ok], tagId: randomUUID() },
    ])
      expect(['VALIDATION_FAILED', 'NOT_FOUND']).toContain(
        await codeOf(leads.bulkAddTag(a.admin.ctx, input)),
      );
  });

  it('database rules: RLS forced; crm_app reads and inserts only; one link per lead and tag', async () => {
    const rls = await migrator().$queryRaw<{ relname: string; f: boolean }[]>`
      SELECT relname, relrowsecurity AND relforcerowsecurity AS f FROM pg_class
       WHERE relname IN ('lead_tag', 'lead_tag_link') ORDER BY relname`;
    expect(rls).toEqual([
      { relname: 'lead_tag', f: true },
      { relname: 'lead_tag_link', f: true },
    ]);
    const [p] = await migrator().$queryRaw<{ ins: boolean; upd: boolean; del: boolean }[]>`
      SELECT has_table_privilege('crm_app', 'lead_tag_link', 'INSERT') AS ins,
             has_any_column_privilege('crm_app', 'lead_tag_link', 'UPDATE')
               OR has_any_column_privilege('crm_app', 'lead_tag', 'UPDATE') AS upd,
             has_table_privilege('crm_app', 'lead_tag_link', 'DELETE')
               OR has_table_privilege('crm_app', 'lead_tag', 'DELETE') AS del`;
    expect(p).toEqual({ ins: true, upd: false, del: false });
    const l = await migrator().leadTagLink.findFirstOrThrow({ where: { tagId: hot } });
    await expect(
      migrator().leadTagLink.create({
        data: { orgId: l.orgId, leadId: l.leadId, tagId: l.tagId, addedBy: l.addedBy },
      }),
    ).rejects.toThrow();
  });
});
