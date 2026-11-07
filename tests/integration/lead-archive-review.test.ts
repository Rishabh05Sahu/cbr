// Phase 2 M5 Slice 1: archive / restore and the duplicate review queue through the leads module
// (authorisation, tenant scope, stale writes, read-only archived leads, D2 routing of enquiries
// for archived leads, atomic resolution under concurrency). Synthetic data only; crm_test only.
import { randomUUID } from 'node:crypto';
import { beforeAll, describe, expect, it } from 'vitest';
import * as leads from '@/modules/leads';
import * as teams from '@/modules/teams';
import { resolveRequestContext } from '@/platform/auth/context';
import { DomainError } from '@/platform/errors';
import { migrator, openRole } from '../support/db';
import { actorIn, seedOrg, type Actor } from '../support/factory';

const APP = process.env.TEST_DATABASE_URL!;
let A: Awaited<ReturnType<typeof seedOrg>>;
let B: Awaited<ReturnType<typeof seedOrg>>;
const a = {} as Record<'owner' | 'admin' | 'manager' | 'exec1' | 'exec2', Actor>;
let ownerB: Actor;
let unknownA: string;

let seq = 0;
const phone = () => `93${String(40_000_000 + ++seq * 6_011 + (process.pid % 1000)).slice(-8)}`;

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

async function newLead(by: Actor = a.exec1, p = phone()): Promise<string> {
  const r = await leads.createLead(by.ctx, { fullName: 'Synthetic Customer', primaryPhone: p });
  if (r.status !== 'created') throw new Error(`expected created, got ${JSON.stringify(r)}`);
  return r.leadId;
}
const row = (id: string) => migrator().lead.findUniqueOrThrow({ where: { id } });
const version = async (id: string) => (await row(id)).version;

async function archived(by: Actor = a.owner, p = phone()): Promise<string> {
  const id = await newLead(a.exec1, p);
  await leads.archiveLead(by.ctx, id, { version: await version(id) });
  return id;
}

/** Opens a pair case as the system (detection is not a user command yet). */
async function pairCase(l1: string, l2: string): Promise<string> {
  const id = randomUUID();
  const c = await openRole(APP);
  try {
    await c.query('BEGIN');
    await c.query(
      `SELECT set_config('app.org_id', $1, true), set_config('app.user_id', '', true)`,
      [A.orgId],
    );
    await c.query(
      `INSERT INTO lead_duplicate_match (id, org_id, match_type, lead_id, candidate_lead_id)
       VALUES ($1, $2, 'EMAIL', $3, $4)`,
      [id, A.orgId, l1, l2],
    );
    await c.query('COMMIT');
  } finally {
    await c.end();
  }
  return id;
}

const openCases = (leadId: string) =>
  migrator().leadDuplicateMatch.findMany({
    where: { leadId, matchType: 'ARCHIVED_ENQUIRY', status: 'OPEN' },
  });

beforeAll(async () => {
  A = await seedOrg('ArchiveA');
  B = await seedOrg('ArchiveB');
  for (const k of ['owner', 'admin', 'manager', 'exec1', 'exec2'] as const)
    a[k] = await actorIn(A.users[k], A.orgId);
  ownerB = await actorIn(B.users.owner, B.orgId);
  const north = (await teams.createTeam(a.owner.ctx, { name: 'North' })).id;
  await teams.addTeamMember(a.owner.ctx, {
    teamId: north,
    membershipId: A.membership.manager!,
    teamRole: 'LEAD',
  });
  await teams.addTeamMember(a.owner.ctx, {
    teamId: north,
    membershipId: A.membership.exec1!,
    teamRole: 'MEMBER',
  });
  unknownA = (await row(await newLead())).sourceId;
});

describe('archive and restore', () => {
  it('Owner and Admin archive: timeline entry, audit, version bump, archive time set by the database', async () => {
    for (const who of [a.owner, a.admin]) {
      const id = await newLead();
      const v = await version(id);
      await leads.archiveLead(who.ctx, id, { version: v, reason: 'Synthetic: not interested' });
      const l = await row(id);
      expect(l.archivedAt).not.toBeNull();
      expect(l.version).toBe(v + 1);
      const act = await migrator().leadActivity.findFirstOrThrow({
        where: { leadId: id, type: 'ARCHIVED' },
      });
      expect(act).toMatchObject({
        actorId: who.user.id,
        summary: { reason: 'Synthetic: not interested' },
      });
      expect(
        await migrator().auditLog.count({
          where: { orgId: A.orgId, action: 'lead.archived', entityId: id },
        }),
      ).toBe(1);
    }
  });

  it('Sales Managers, Executives and other orgs cannot archive', async () => {
    const id = await newLead();
    const v = await version(id);
    expect(await codeOf(leads.archiveLead(a.manager.ctx, id, { version: v }))).toBe('FORBIDDEN');
    expect(await codeOf(leads.archiveLead(a.exec1.ctx, id, { version: v }))).toBe('FORBIDDEN');
    expect(await codeOf(leads.archiveLead(ownerB.ctx, id, { version: v }))).toBe('NOT_FOUND');
    expect((await row(id)).archivedAt).toBeNull();
  });

  it('refuses stale versions, double archive and restoring a live lead', async () => {
    const id = await newLead();
    const v = await version(id);
    expect(await codeOf(leads.archiveLead(a.owner.ctx, id, { version: v + 5 }))).toBe('CONFLICT');
    await leads.archiveLead(a.owner.ctx, id, { version: v });
    expect(await codeOf(leads.archiveLead(a.owner.ctx, id, { version: v + 1 }))).toBe('CONFLICT');
    expect(await codeOf(leads.restoreLead(a.owner.ctx, id, { version: v }))).toBe('CONFLICT'); // stale
    await leads.restoreLead(a.admin.ctx, id, { version: v + 1 });
    expect((await row(id)).archivedAt).toBeNull();
    expect(await codeOf(leads.restoreLead(a.owner.ctx, id, { version: v + 2 }))).toBe('CONFLICT');
    expect(await migrator().leadActivity.count({ where: { leadId: id, type: 'RESTORED' } })).toBe(
      1,
    );
  });

  it('an archived lead is read-only: edits, stage changes, notes and assignment are refused', async () => {
    const id = await archived();
    const v = await version(id);
    expect(
      await codeOf(
        leads.updateRequirements(a.owner.ctx, id, { version: v, preferredCity: 'Pune' }),
      ),
    ).toBe('RULE_VIOLATION');
    expect(
      await codeOf(leads.changeStage(a.owner.ctx, id, { toStage: 'CONTACTED', version: v })),
    ).toBe('RULE_VIOLATION');
    expect(await codeOf(leads.addNote(a.owner.ctx, id, { body: 'Synthetic note' }))).toBe(
      'RULE_VIOLATION',
    );
    expect(
      await codeOf(
        leads.assignLead(a.owner.ctx, id, {
          version: v,
          target: `user:${A.users.exec2.id}`,
          reason: 'x',
        }),
      ),
    ).toBe('RULE_VIOLATION');
    expect((await row(id)).version).toBe(v);
  });

  it('a merged lead cannot be archived or restored', async () => {
    const [m, s] = [await newLead(), await newLead()];
    await migrator().lead.update({ where: { id: m }, data: { mergedIntoLeadId: s } });
    const v = await version(m);
    expect(await codeOf(leads.archiveLead(a.owner.ctx, m, { version: v }))).toBe('RULE_VIOLATION');
    expect(await codeOf(leads.restoreLead(a.owner.ctx, m, { version: v }))).toBe('RULE_VIOLATION');
  });

  it('a suspended Admin no longer gets a request context', async () => {
    await migrator().member.update({
      where: { id: A.membership.admin! },
      data: { status: 'SUSPENDED' },
    });
    try {
      expect((await resolveRequestContext(a.admin.headers)).ok).toBe(false);
    } finally {
      await migrator().member.update({
        where: { id: A.membership.admin! },
        data: { status: 'ACTIVE' },
      });
    }
  });
});

describe('enquiries for archived leads (D2: never auto-restored)', () => {
  it('a new lead with an archived lead’s phone is reported as a duplicate, not created', async () => {
    const p = phone();
    const id = await archived(a.owner, p);
    const r = await leads.createLead(a.exec1.ctx, { fullName: 'Again', primaryPhone: p });
    expect(r).toMatchObject({ status: 'duplicate', leadId: id, archived: true });
  });

  it('a caller who cannot see the archived lead is not told it is archived (M5 U9)', async () => {
    const p = phone();
    await archived(a.owner, p);
    expect(await leads.createLead(a.exec2.ctx, { fullName: 'Again', primaryPhone: p })).toEqual({
      status: 'duplicate',
      leadId: null,
      canAttach: false,
      archived: false,
    });
  });

  it('attaching an enquiry keeps the lead archived and opens one review case', async () => {
    const id = await archived();
    await leads.attachEnquiry(a.exec1.ctx, id, {});
    await leads.attachEnquiry(a.exec1.ctx, id, {});
    expect((await row(id)).archivedAt).not.toBeNull();
    expect(await migrator().leadEnquiry.count({ where: { leadId: id } })).toBe(3);
    const cases = await openCases(id);
    expect(cases).toHaveLength(1);
    expect(cases[0]).toMatchObject({ detectedBy: A.users.exec1.id, status: 'OPEN' });
  });

  it('a reported duplicate (caller cannot see the lead) also routes to review', async () => {
    const p = phone();
    const id = await archived(a.owner, p);
    await migrator().lead.update({ where: { id }, data: { ownerUserId: A.users.manager.id } });
    expect(await leads.reportDuplicateToOwner(a.exec2.ctx, { primaryPhone: p })).toEqual({
      reported: true,
    });
    expect((await row(id)).archivedAt).not.toBeNull();
    expect(await openCases(id)).toHaveLength(1);
  });

  it('an import row matching an archived lead attaches and routes to review', async () => {
    const p = phone();
    const id = await archived(a.owner, p);
    const prepared = leads.prepareLead(
      leads.createInput.parse({ fullName: 'Imported', primaryPhone: p }),
    );
    if (!prepared.ok) throw new Error('fixture');
    const out = await leads.importLeadBatch(
      a.owner.ctx,
      [{ row: 2, lead: prepared.lead, sourceId: unknownA }],
      { importId: randomUUID(), duplicatePolicy: 'ATTACH', assignment: { mode: 'none' } },
    );
    expect(out).toEqual([{ row: 2, outcome: 'ATTACHED', leadId: id }]);
    expect((await row(id)).archivedAt).not.toBeNull();
    expect(await openCases(id)).toHaveLength(1);
  });

  it('concurrent enquiries for the same archived lead open exactly one case', async () => {
    const id = await archived();
    await Promise.all([
      leads.attachEnquiry(a.exec1.ctx, id, {}),
      leads.attachEnquiry(a.owner.ctx, id, {}),
      leads.attachEnquiry(a.admin.ctx, id, {}),
    ]);
    expect(await openCases(id)).toHaveLength(1);
  });
});

describe('duplicate review queue', () => {
  it('lists cases to Owner/Admin/Manager per scope; not to Executives or other orgs', async () => {
    const id = await archived();
    await leads.attachEnquiry(a.exec1.ctx, id, {});
    const [caseRow] = await openCases(id);
    const ids = async (who: Actor) => (await leads.listDuplicateCases(who.ctx)).map((c) => c.id);
    expect(await ids(a.owner)).toContain(caseRow!.id);
    expect(await ids(a.admin)).toContain(caseRow!.id);
    expect(await ids(a.manager)).not.toContain(caseRow!.id); // archived cases need lead.archive
    expect(await codeOf(leads.listDuplicateCases(a.exec1.ctx))).toBe('FORBIDDEN');
    expect(await ids(ownerB)).not.toContain(caseRow!.id);
    expect(
      await codeOf(leads.resolveDuplicateCase(ownerB.ctx, caseRow!.id, { decision: 'restore' })),
    ).toBe('NOT_FOUND');
  });

  it('keep archived: recorded once, attributed, audited; the lead stays archived', async () => {
    const id = await archived();
    await leads.attachEnquiry(a.exec1.ctx, id, {});
    const [c] = await openCases(id);
    expect(
      await leads.resolveDuplicateCase(a.admin.ctx, c!.id, { decision: 'keep_archived' }),
    ).toEqual({
      status: 'KEPT_ARCHIVED',
    });
    const after = await migrator().leadDuplicateMatch.findUniqueOrThrow({ where: { id: c!.id } });
    expect(after).toMatchObject({ status: 'KEPT_ARCHIVED', resolvedBy: A.users.admin.id });
    expect((await row(id)).archivedAt).not.toBeNull();
    expect(
      await codeOf(leads.resolveDuplicateCase(a.owner.ctx, c!.id, { decision: 'restore' })),
    ).toBe('CONFLICT');
    expect(
      await migrator().auditLog.count({
        where: { action: 'lead.duplicate_resolved', entityId: c!.id },
      }),
    ).toBe(1);
  });

  it('restore through the case un-archives the lead and records RESTORED', async () => {
    const id = await archived();
    await leads.attachEnquiry(a.exec1.ctx, id, {});
    const [c] = await openCases(id);
    await leads.resolveDuplicateCase(a.owner.ctx, c!.id, { decision: 'restore' });
    expect((await row(id)).archivedAt).toBeNull();
    expect(
      (await migrator().leadDuplicateMatch.findUniqueOrThrow({ where: { id: c!.id } })).status,
    ).toBe('RESTORED');
    expect(await migrator().leadActivity.count({ where: { leadId: id, type: 'RESTORED' } })).toBe(
      1,
    );
  });

  it('restoring the lead directly closes its open case as RESTORED', async () => {
    const id = await archived();
    await leads.attachEnquiry(a.exec1.ctx, id, {});
    const [c] = await openCases(id);
    await leads.restoreLead(a.owner.ctx, id, { version: await version(id) });
    expect(
      await migrator().leadDuplicateMatch.findUniqueOrThrow({ where: { id: c!.id } }),
    ).toMatchObject({
      status: 'RESTORED',
      resolvedBy: A.users.owner.id,
    });
  });

  it('two concurrent resolvers: exactly one succeeds, the other gets a conflict', async () => {
    const id = await archived();
    await leads.attachEnquiry(a.exec1.ctx, id, {});
    const [c] = await openCases(id);
    const results = await Promise.all([
      codeOf(leads.resolveDuplicateCase(a.owner.ctx, c!.id, { decision: 'restore' })),
      codeOf(leads.resolveDuplicateCase(a.admin.ctx, c!.id, { decision: 'keep_archived' })),
    ]);
    expect(results.sort()).toEqual(['CONFLICT', 'OK']);
    const final = await migrator().leadDuplicateMatch.findUniqueOrThrow({ where: { id: c!.id } });
    expect(['RESTORED', 'KEPT_ARCHIVED']).toContain(final.status);
    expect((await row(id)).archivedAt === null).toBe(final.status === 'RESTORED');
  });

  it('pair cases: dismissed by someone who may merge, in scope; wrong decisions refused', async () => {
    const [l1, l2] = [await newLead(a.exec1), await newLead(a.exec1)]; // exec1 is in North
    const c = await pairCase(l1, l2);
    expect(await codeOf(leads.resolveDuplicateCase(a.owner.ctx, c, { decision: 'restore' }))).toBe(
      'RULE_VIOLATION',
    );
    expect(await codeOf(leads.resolveDuplicateCase(a.exec1.ctx, c, { decision: 'dismiss' }))).toBe(
      'FORBIDDEN',
    );
    expect(await leads.resolveDuplicateCase(a.manager.ctx, c, { decision: 'dismiss' })).toEqual({
      status: 'DISMISSED',
    });
    // A team-scoped manager cannot see a pair involving a lead outside their team.
    const outside = await newLead(a.exec2);
    const c2 = await pairCase(l1, outside);
    expect(
      await codeOf(leads.resolveDuplicateCase(a.manager.ctx, c2, { decision: 'dismiss' })),
    ).toBe('NOT_FOUND');
  });

  it('merge is not a review decision (it goes through the merge command)', async () => {
    const c = await pairCase(await newLead(), await newLead());
    expect(await codeOf(leads.resolveDuplicateCase(a.owner.ctx, c, { decision: 'merge' }))).toBe(
      'VALIDATION_FAILED',
    );
  });
});
