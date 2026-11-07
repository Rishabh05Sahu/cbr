// Phase 2 M4 (pre-approval part): committing validated import rows through the leads module on
// the existing schema. Retry safety, duplicate policy, import-time assignment, authorisation and
// tenant scoping. Synthetic data only; no import-job tables are involved yet.
import { randomUUID } from 'node:crypto';
import { beforeAll, describe, expect, it } from 'vitest';
import * as leads from '@/modules/leads';
import * as members from '@/modules/members';
import * as teams from '@/modules/teams';
import { DomainError } from '@/platform/errors';
import { migrator } from '../support/db';
import { actorIn, seedOrg, type Actor } from '../support/factory';

let A: Awaited<ReturnType<typeof seedOrg>>;
let B: Awaited<ReturnType<typeof seedOrg>>;
const a = {} as Record<'owner' | 'admin' | 'manager' | 'exec1' | 'hr', Actor>;
let ownerB: Actor;
let north: string;
let unknownA: string;
let unknownB: string;

let seq = 0;
const phone = () => `95${String(30_000_000 + ++seq * 6_007).slice(-8)}`;

function row(n: number, p = phone(), extra: Partial<leads.CreateInput> = {}): leads.ImportRowInput {
  const prepared = leads.prepareLead(
    leads.createInput.parse({ fullName: `Imported ${n}`, primaryPhone: p, ...extra }),
  );
  if (!prepared.ok) throw new Error('bad fixture');
  return { row: n, lead: prepared.lead, sourceId: unknownA };
}

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

const none = { mode: 'none' } as const;
const opts = (importId: string, extra: Partial<leads.ImportBatchOptions> = {}) => ({
  importId,
  duplicatePolicy: 'ATTACH' as const,
  assignment: none,
  ...extra,
});
const countLeads = (orgId: string) => migrator().lead.count({ where: { orgId } });

beforeAll(async () => {
  A = await seedOrg('ImportA');
  B = await seedOrg('ImportB');
  for (const k of ['owner', 'admin', 'manager', 'exec1', 'hr'] as const)
    a[k] = await actorIn(A.users[k], A.orgId);
  ownerB = await actorIn(B.users.owner, B.orgId);
  north = (await teams.createTeam(a.owner.ctx, { name: 'North' })).id;
  for (const m of [A.membership.manager!, A.membership.exec1!])
    await teams.addTeamMember(a.owner.ctx, { teamId: north, membershipId: m, teamRole: 'MEMBER' });
  // The "Unknown" source exists once any lead was created without a source.
  const seedA = await leads.createLead(a.admin.ctx, { fullName: 'Seed', primaryPhone: phone() });
  const seedB = await leads.createLead(ownerB.ctx, { fullName: 'Seed', primaryPhone: phone() });
  if (seedA.status !== 'created' || seedB.status !== 'created') throw new Error('seed');
  unknownA = (await migrator().lead.findUniqueOrThrow({ where: { id: seedA.leadId } })).sourceId;
  unknownB = (await migrator().lead.findUniqueOrThrow({ where: { id: seedB.leadId } })).sourceId;
});

describe('importLeadBatch', () => {
  it('creates unassigned leads with the same rows as manual create, attributed to the importer', async () => {
    const importId = randomUUID();
    const r = row(2, phone(), {
      email: 'imp@example.test',
      budgetMin: '85 L',
      note: 'From portal',
    });
    const [out] = await leads.importLeadBatch(a.admin.ctx, [r], opts(importId));
    expect(out).toMatchObject({ row: 2, outcome: 'CREATED' });
    const lead = await migrator().lead.findUniqueOrThrow({
      where: { id: out!.leadId! },
      include: {
        enquiries: true,
        stageHistory: true,
        assignments: true,
        activities: true,
        notes: true,
      },
    });
    expect(lead).toMatchObject({
      orgId: A.orgId,
      createdBy: A.users.admin.id,
      ownerUserId: null,
      teamId: null,
      stage: 'NEW',
      email: 'imp@example.test',
    });
    expect(lead.budgetMin?.toFixed(2)).toBe('8500000.00');
    expect(lead.enquiries).toMatchObject([
      { externalId: `${importId}:2`, channelRef: 'IMPORT', createdBy: A.users.admin.id },
    ]);
    expect(lead.stageHistory).toMatchObject([{ toStage: 'NEW', source: 'IMPORT' }]);
    expect(lead.assignments).toEqual([]); // no owner and no team: nothing to record
    expect(lead.activities.map((x) => x.type).sort()).toEqual(['CREATED', 'NOTE']);
    expect(lead.notes).toMatchObject([{ authorId: A.users.admin.id, body: 'From portal' }]);
  });

  it('is retry-safe: re-running a committed batch writes nothing and reports ALREADY_IMPORTED', async () => {
    const importId = randomUUID();
    const batch = [row(2), row(3), row(4)];
    const first = await leads.importLeadBatch(a.admin.ctx, batch, opts(importId));
    const before = await countLeads(A.orgId);
    const enquiries = await migrator().leadEnquiry.count({ where: { orgId: A.orgId } });
    const again = await leads.importLeadBatch(a.admin.ctx, batch, opts(importId));
    expect(again.map((o) => o.outcome)).toEqual(Array(3).fill('ALREADY_IMPORTED'));
    expect(again.map((o) => o.leadId)).toEqual(first.map((o) => o.leadId));
    expect(await countLeads(A.orgId)).toBe(before);
    expect(await migrator().leadEnquiry.count({ where: { orgId: A.orgId } })).toBe(enquiries);
    // A crash mid-batch rolls the whole batch back; the resumed batch completes it once.
    const partial = [row(5), row(6)];
    await leads.importLeadBatch(a.admin.ctx, partial.slice(0, 1), opts(importId));
    const resumed = await leads.importLeadBatch(a.admin.ctx, partial, opts(importId));
    expect(resumed.map((o) => o.outcome)).toEqual(['ALREADY_IMPORTED', 'CREATED']);
  });

  it('existing open lead: ATTACH adds an enquiry and notifies; SKIP writes nothing; never a second lead', async () => {
    const p = phone();
    const existing = await leads.createLead(a.exec1.ctx, { fullName: 'Existing', primaryPhone: p });
    if (existing.status !== 'created') throw new Error('fixture');
    const before = await countLeads(A.orgId);

    const skip = await leads.importLeadBatch(
      a.admin.ctx,
      [row(2, p)],
      opts(randomUUID(), { duplicatePolicy: 'SKIP' }),
    );
    expect(skip).toEqual([{ row: 2, outcome: 'SKIPPED_DUPLICATE', leadId: existing.leadId }]);
    expect(await migrator().leadEnquiry.count({ where: { leadId: existing.leadId } })).toBe(1);

    const importId = randomUUID();
    const attach = await leads.importLeadBatch(a.admin.ctx, [row(3, `+91 ${p}`)], opts(importId));
    expect(attach).toEqual([{ row: 3, outcome: 'ATTACHED', leadId: existing.leadId }]);
    const lead = await migrator().lead.findUniqueOrThrow({
      where: { id: existing.leadId },
      include: { enquiries: { orderBy: { createdAt: 'asc' } } },
    });
    // Never overwritten: name and owner unchanged.
    expect(lead).toMatchObject({ fullName: 'Existing', ownerUserId: A.users.exec1.id });
    expect(lead.enquiries[1]).toMatchObject({ externalId: `${importId}:3`, channelRef: 'IMPORT' });
    const evt = await migrator().outboxEvent.findFirst({
      where: {
        orgId: A.orgId,
        type: 'lead.enquiry_returned',
        payload: { path: ['leadId'], equals: existing.leadId },
      },
    });
    expect(evt).not.toBeNull();
    expect(await countLeads(A.orgId)).toBe(before);
    // Retried attach is not attached twice.
    await leads.importLeadBatch(a.admin.ctx, [row(3, p)], opts(importId));
    expect(await migrator().leadEnquiry.count({ where: { leadId: existing.leadId } })).toBe(2);
  });

  it('assigns at import with M3 semantics: a person, or round-robin within a team (source IMPORT)', async () => {
    const [one] = await leads.importLeadBatch(
      a.owner.ctx,
      [row(2)],
      opts(randomUUID(), { assignment: { mode: 'target', target: `user:${A.users.exec1.id}` } }),
    );
    const lead = await migrator().lead.findUniqueOrThrow({
      where: { id: one!.leadId! },
      include: { assignments: true },
    });
    expect(lead).toMatchObject({ ownerUserId: A.users.exec1.id, teamId: north, stage: 'ASSIGNED' });
    expect(lead.assignments).toMatchObject([
      { userId: A.users.exec1.id, teamId: north, source: 'IMPORT', assignedBy: A.users.owner.id },
    ]);

    const out = await leads.importLeadBatch(
      a.owner.ctx,
      [row(2), row(3), row(4), row(5)],
      opts(randomUUID(), { assignment: { mode: 'round_robin', teamId: north } }),
    );
    const owners = await Promise.all(
      out.map(
        async (o) =>
          (await migrator().lead.findUniqueOrThrow({ where: { id: o.leadId! } })).ownerUserId,
      ),
    );
    const pool = [A.users.manager.id, A.users.exec1.id];
    expect(owners.every((o) => pool.includes(o!))).toBe(true);
    expect(owners[0]).not.toBe(owners[1]);
    expect(owners[0]).toBe(owners[2]);
    const evts = await migrator().outboxEvent.findMany({
      where: {
        orgId: A.orgId,
        type: 'lead.assigned',
        payload: { path: ['source'], equals: 'IMPORT' },
      },
    });
    expect(evts.length).toBeGreaterThanOrEqual(3); // one digest per assignee per batch
  });

  it('only Owners and Admins import; targets and sources from another org are refused', async () => {
    for (const k of ['manager', 'exec1', 'hr'] as const)
      expect(await codeOf(leads.importLeadBatch(a[k].ctx, [row(2)], opts(randomUUID()))), k).toBe(
        'FORBIDDEN',
      );
    const before = await countLeads(A.orgId);
    expect(
      await codeOf(
        leads.importLeadBatch(
          a.admin.ctx,
          [row(2)],
          opts(randomUUID(), {
            assignment: { mode: 'target', target: `user:${B.users.exec1.id}` },
          }),
        ),
      ),
    ).toBe('VALIDATION_FAILED');
    expect(
      await codeOf(
        leads.importLeadBatch(a.admin.ctx, [{ ...row(2), sourceId: unknownB }], opts(randomUUID())),
      ),
    ).toBe('RULE_VIOLATION');
    expect(await countLeads(A.orgId)).toBe(before);
  });

  it('import ids and phones are per org: the same import id and phone in org B create B leads only', async () => {
    const importId = randomUUID();
    const p = phone();
    const [inA] = await leads.importLeadBatch(a.admin.ctx, [row(2, p)], opts(importId));
    const rB = { ...row(2, p), sourceId: unknownB };
    const [inB] = await leads.importLeadBatch(ownerB.ctx, [rB], opts(importId));
    expect(inB).toMatchObject({ outcome: 'CREATED' });
    expect(inB!.leadId).not.toBe(inA!.leadId);
    expect((await migrator().lead.findUniqueOrThrow({ where: { id: inB!.leadId! } })).orgId).toBe(
      B.orgId,
    );
  });

  it('concurrent imports of the same phone create one lead; the other attaches', async () => {
    const p = phone();
    const runs = await Promise.all(
      [randomUUID(), randomUUID(), randomUUID()].map((id) =>
        leads.importLeadBatch(a.admin.ctx, [row(2, p)], opts(id)),
      ),
    );
    const outcomes = runs.map((r) => r[0]!.outcome).sort();
    expect(outcomes).toEqual(['ATTACHED', 'ATTACHED', 'CREATED']);
    expect(
      await migrator().lead.count({ where: { orgId: A.orgId, primaryPhoneE164: `+91${p}` } }),
    ).toBe(1);
  });

  it('a target suspended mid-import stops the batch with nothing written', async () => {
    const before = await countLeads(A.orgId);
    await members.suspendMember(a.owner.ctx, A.membership.exec1!);
    try {
      expect(
        await codeOf(
          leads.importLeadBatch(
            a.owner.ctx,
            [row(2), row(3)],
            opts(randomUUID(), {
              assignment: { mode: 'target', target: `user:${A.users.exec1.id}` },
            }),
          ),
        ),
      ).toBe('VALIDATION_FAILED');
      expect(await countLeads(A.orgId)).toBe(before);
    } finally {
      await members.reactivateMember(a.owner.ctx, A.membership.exec1!);
    }
  });

  it('rejects oversized and malformed batches before touching the database', async () => {
    expect(
      await codeOf(leads.importLeadBatch(a.admin.ctx, [row(2), row(2)], opts(randomUUID()))),
    ).toBe('RULE_VIOLATION');
    expect(await codeOf(leads.importLeadBatch(a.admin.ctx, [row(2)], opts('not-a-uuid')))).toBe(
      'VALIDATION_FAILED',
    );
  });
});
