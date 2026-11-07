// Phase 2 M5 Slice 2: the merge command (preview, explicit conflict choices, tombstone by
// reference, combined timeline, review cases, phone/row locking against concurrent merges and
// enquiries). Synthetic data only; crm_test only.
import { randomUUID } from 'node:crypto';
import { beforeAll, describe, expect, it } from 'vitest';
import * as leads from '@/modules/leads';
import * as teams from '@/modules/teams';
import { DomainError } from '@/platform/errors';
import { migrator, openRole } from '../support/db';
import { actorIn, seedOrg, type Actor } from '../support/factory';

const APP = process.env.TEST_DATABASE_URL!;
let A: Awaited<ReturnType<typeof seedOrg>>;
let B: Awaited<ReturnType<typeof seedOrg>>;
const a = {} as Record<'owner' | 'admin' | 'manager' | 'exec1' | 'exec2', Actor>;
let ownerB: Actor;

let seq = 0;
const phone = () => `92${String(50_000_000 + ++seq * 6_029 + (process.pid % 1000)).slice(-8)}`;
const e164 = (p: string) => `+91${p}`;

async function failure(p: Promise<unknown>): Promise<{ code: string; fields?: string[] }> {
  try {
    await p;
  } catch (e) {
    if (e instanceof DomainError)
      return {
        code: e.code,
        ...(e.fieldErrors ? { fields: Object.keys(e.fieldErrors).sort() } : {}),
      };
    if (e instanceof Error && e.name === 'ZodError') return { code: 'VALIDATION_FAILED' };
    throw e;
  }
  return { code: 'OK' };
}
const codeOf = async (p: Promise<unknown>) => (await failure(p)).code;

async function newLead(input: Record<string, string> = {}, by: Actor = a.exec1): Promise<string> {
  const r = await leads.createLead(by.ctx, {
    fullName: 'Synthetic Customer',
    primaryPhone: phone(),
    ...input,
  });
  if (r.status !== 'created') throw new Error(`expected created, got ${JSON.stringify(r)}`);
  return r.leadId;
}
const row = (id: string) => migrator().lead.findUniqueOrThrow({ where: { id } });
const versions = async (s: string, m: string) => ({
  survivorVersion: (await row(s)).version,
  mergedVersion: (await row(m)).version,
});

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
      `INSERT INTO lead_duplicate_match (id, org_id, match_type, lead_id, candidate_lead_id) VALUES ($1, $2, 'EMAIL', $3, $4)`,
      [id, A.orgId, l1, l2],
    );
    await c.query('COMMIT');
  } finally {
    await c.end();
  }
  return id;
}

beforeAll(async () => {
  A = await seedOrg('MergeA');
  B = await seedOrg('MergeB');
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
});

describe('preview and authorisation', () => {
  it('shows fills and conflicts; Executives cannot merge; other orgs see nothing', async () => {
    const s = await newLead({ email: 'synthetic.a@example.test', bhkMin: '2' });
    const m = await newLead({ email: 'synthetic.b@example.test', preferredCity: 'Pune' });
    const p = await leads.previewMerge(a.owner.ctx, { survivorId: s, mergedId: m });
    expect(p.fills.map((f) => f.field)).toEqual(
      expect.arrayContaining(['preferredCity', 'alternatePhoneE164']),
    );
    expect(p.conflicts.map((c) => c.field)).toEqual(['email']);
    expect(await codeOf(leads.previewMerge(a.exec1.ctx, { survivorId: s, mergedId: m }))).toBe(
      'FORBIDDEN',
    );
    expect(await codeOf(leads.previewMerge(ownerB.ctx, { survivorId: s, mergedId: m }))).toBe(
      'NOT_FOUND',
    );
    expect(await codeOf(leads.previewMerge(a.owner.ctx, { survivorId: s, mergedId: s }))).toBe(
      'RULE_VIOLATION',
    );
  });

  it('a team-scoped Sales Manager merges only leads inside their team', async () => {
    const [s, m] = [await newLead({}, a.exec1), await newLead({}, a.exec1)];
    const outside = await newLead({}, a.exec2);
    expect(
      await codeOf(leads.previewMerge(a.manager.ctx, { survivorId: s, mergedId: outside })),
    ).toBe('NOT_FOUND');
    await leads.mergeLeads(a.manager.ctx, {
      survivorId: s,
      mergedId: m,
      ...(await versions(s, m)),
    });
    expect((await row(m)).mergedIntoLeadId).toBe(s);
  });
});

describe('merge', () => {
  it('requires an explicit choice for every conflict and refuses choices for non-conflicts', async () => {
    const s = await newLead({ email: 'synthetic.c@example.test', intent: 'HOT' });
    const m = await newLead({
      email: 'synthetic.d@example.test',
      intent: 'COLD',
      preferredCity: 'Pune',
    });
    const v = await versions(s, m);
    expect(
      await failure(leads.mergeLeads(a.owner.ctx, { survivorId: s, mergedId: m, ...v })),
    ).toEqual({
      code: 'VALIDATION_FAILED',
      fields: ['email', 'intent'],
    });
    expect(
      await failure(
        leads.mergeLeads(a.owner.ctx, {
          survivorId: s,
          mergedId: m,
          ...v,
          resolutions: { email: 'merged', intent: 'survivor', preferredCity: 'merged' },
        }),
      ),
    ).toEqual({ code: 'VALIDATION_FAILED', fields: ['preferredCity'] });
    expect((await row(m)).mergedIntoLeadId).toBeNull();
  });

  it('applies fills and choices, tombstones the merged lead, records both timelines and the audit', async () => {
    const mp = phone();
    const s = await newLead({ email: 'synthetic.e@example.test', budgetMin: '80 L' });
    const m = await newLead({
      primaryPhone: mp,
      email: 'synthetic.f@example.test',
      preferredCity: 'Pune',
      preferredLocalities: 'Baner, Wakad',
    });
    const v = await versions(s, m);
    await leads.mergeLeads(a.admin.ctx, {
      survivorId: s,
      mergedId: m,
      ...v,
      resolutions: { email: 'merged' },
    });
    const [S, M] = [await row(s), await row(m)];
    expect(M.mergedIntoLeadId).toBe(s);
    expect(M.version).toBe(v.mergedVersion + 1);
    expect(S.version).toBe(v.survivorVersion + 1);
    expect(S).toMatchObject({
      email: 'synthetic.f@example.test',
      preferredCity: 'Pune',
      alternatePhoneE164: e164(mp),
      preferredLocalities: ['Baner', 'Wakad'],
    });
    expect(S.budgetMin?.toFixed(2)).toBe('8000000.00'); // kept
    const acts = await migrator().leadActivity.findMany({
      where: { type: 'MERGED', leadId: { in: [s, m] } },
    });
    expect(acts).toHaveLength(2);
    const sAct = acts.find((x) => x.leadId === s)!;
    expect(sAct.summary).toMatchObject({ mergedLeadId: m, chosen: ['email:merged'] });
    expect(JSON.stringify(sAct.summary)).not.toContain('synthetic.f@example.test'); // names only
    const audit = await migrator().auditLog.findFirstOrThrow({
      where: { action: 'lead.merged', entityId: s },
    });
    expect(audit.metadata).toMatchObject({ mergedLeadId: m, conflictsResolved: 1 });
    // The merged lead's assignment spell is closed.
    expect(
      await migrator().leadAssignmentHistory.count({ where: { leadId: m, endedAt: null } }),
    ).toBe(0);
  });

  it('refuses stale versions', async () => {
    const [s, m] = [await newLead(), await newLead()];
    const v = await versions(s, m);
    expect(
      await codeOf(
        leads.mergeLeads(a.owner.ctx, {
          survivorId: s,
          mergedId: m,
          ...v,
          mergedVersion: v.mergedVersion + 1,
        }),
      ),
    ).toBe('CONFLICT');
    expect(
      await codeOf(
        leads.mergeLeads(a.owner.ctx, { survivorId: s, mergedId: m, ...v, survivorVersion: 99 }),
      ),
    ).toBe('CONFLICT');
  });

  it('refuses mixed choices that would break a range', async () => {
    const s = await newLead({ bhkMin: '3', bhkMax: '4' });
    const m = await newLead({ bhkMin: '1', bhkMax: '2' });
    expect(
      await failure(
        leads.mergeLeads(a.owner.ctx, {
          survivorId: s,
          mergedId: m,
          ...(await versions(s, m)),
          resolutions: { bhkMin: 'survivor', bhkMax: 'merged' },
        }),
      ),
    ).toEqual({ code: 'VALIDATION_FAILED', fields: ['bhkMax'] });
  });

  it('archived: never into an archived survivor; an archived merged lead’s case is closed', async () => {
    const [s, m] = [await newLead(), await newLead()];
    await leads.archiveLead(a.owner.ctx, s, { version: (await row(s)).version });
    expect(
      await codeOf(
        leads.mergeLeads(a.owner.ctx, { survivorId: s, mergedId: m, ...(await versions(s, m)) }),
      ),
    ).toBe('RULE_VIOLATION');
    const [s2, m2] = [await newLead(), await newLead()];
    await leads.archiveLead(a.owner.ctx, m2, { version: (await row(m2)).version });
    await leads.attachEnquiry(a.exec1.ctx, m2, {});
    await leads.mergeLeads(a.owner.ctx, {
      survivorId: s2,
      mergedId: m2,
      ...(await versions(s2, m2)),
    });
    expect(
      await migrator().leadDuplicateMatch.findFirstOrThrow({
        where: { leadId: m2, matchType: 'ARCHIVED_ENQUIRY' },
      }),
    ).toMatchObject({ status: 'KEPT_ARCHIVED', resolvedBy: A.users.owner.id });
  });

  it('no cycles and no merging into or out of a tombstone', async () => {
    const [x, y, z] = [await newLead(), await newLead(), await newLead()];
    await leads.mergeLeads(a.owner.ctx, { survivorId: y, mergedId: x, ...(await versions(y, x)) });
    expect(
      await codeOf(
        leads.mergeLeads(a.owner.ctx, { survivorId: x, mergedId: y, ...(await versions(x, y)) }),
      ),
    ).toBe('RULE_VIOLATION');
    expect(
      await codeOf(
        leads.mergeLeads(a.owner.ctx, { survivorId: z, mergedId: x, ...(await versions(z, x)) }),
      ),
    ).toBe('RULE_VIOLATION');
  });

  it('closes the pair’s review case as MERGED and dismisses other open pairs naming the tombstone', async () => {
    const [s, m, other] = [await newLead(), await newLead(), await newLead()];
    const pair = await pairCase(m, s);
    const stale = await pairCase(m, other);
    await leads.mergeLeads(a.owner.ctx, { survivorId: s, mergedId: m, ...(await versions(s, m)) });
    const cases = await migrator().leadDuplicateMatch.findMany({
      where: { id: { in: [pair, stale] } },
    });
    expect(cases.find((c) => c.id === pair)).toMatchObject({
      status: 'MERGED',
      resolvedBy: A.users.owner.id,
    });
    expect(cases.find((c) => c.id === stale)!.status).toBe('DISMISSED');
  });

  it('combined timeline by reference: the survivor shows the merged lead’s history, nothing moved', async () => {
    const [a1, b1, c1] = [await newLead(), await newLead(), await newLead()];
    await leads.addNote(a.exec1.ctx, a1, { body: 'Synthetic note on A' });
    await leads.mergeLeads(a.owner.ctx, {
      survivorId: b1,
      mergedId: a1,
      ...(await versions(b1, a1)),
    });
    await leads.mergeLeads(a.owner.ctx, {
      survivorId: c1,
      mergedId: b1,
      ...(await versions(c1, b1)),
    });
    const timeline = await leads.getTimeline(a.owner.ctx, c1);
    const note = timeline.find((t) => t.note?.body === 'Synthetic note on A');
    expect(note?.fromMergedLeadId).toBe(a1);
    expect(
      timeline
        .filter((t) => t.type === 'CREATED')
        .map((t) => t.fromMergedLeadId ?? c1)
        .sort(),
    ).toEqual([a1, b1, c1].sort());
    // History rows still belong to their original leads.
    expect(
      (await migrator().leadNote.findFirstOrThrow({ where: { body: 'Synthetic note on A' } }))
        .leadId,
    ).toBe(a1);
    // Writes addressed to a tombstone go to the live end of the chain.
    const { id } = await leads.addNote(a.exec1.ctx, a1, { body: 'Synthetic later note' });
    expect((await migrator().leadNote.findUniqueOrThrow({ where: { id } })).leadId).toBe(c1);
  });
});

describe('concurrency', () => {
  it('crossing merges (X into Y, Y into X) at the same time: exactly one wins, never a cycle', async () => {
    for (let i = 0; i < 5; i++) {
      const [x, y] = [await newLead(), await newLead()];
      const vx = (await row(x)).version;
      const vy = (await row(y)).version;
      const results = await Promise.all([
        codeOf(
          leads.mergeLeads(a.owner.ctx, {
            survivorId: y,
            mergedId: x,
            survivorVersion: vy,
            mergedVersion: vx,
          }),
        ),
        codeOf(
          leads.mergeLeads(a.admin.ctx, {
            survivorId: x,
            mergedId: y,
            survivorVersion: vx,
            mergedVersion: vy,
          }),
        ),
      ]);
      expect(results.filter((r) => r === 'OK')).toHaveLength(1);
      for (const r of results) expect(r).toMatch(/^(OK|CONFLICT|RULE_VIOLATION)$/);
      expect(
        await migrator().lead.count({
          where: { id: { in: [x, y] }, mergedIntoLeadId: { not: null } },
        }),
      ).toBe(1);
    }
  });

  it('an enquiry racing a merge never lands on the lead after it became a tombstone', async () => {
    for (let i = 0; i < 5; i++) {
      const mp = phone();
      const s = await newLead({}, a.exec1);
      const m = await newLead({ primaryPhone: mp }, a.exec2);
      const v = await versions(s, m);
      await Promise.all([
        leads.mergeLeads(a.owner.ctx, { survivorId: s, mergedId: m, ...v }),
        leads.reportDuplicateToOwner(a.exec1.ctx, { primaryPhone: mp }), // phone-matched
        leads.attachEnquiry(a.admin.ctx, m, {}), // by id
      ]);
      // Every ENQUIRY entry on the tombstone was written before its MERGED entry (uuidv7 ids are
      // time-ordered at insert): nothing was attached to it once merged.
      const merged = await migrator().leadActivity.findFirstOrThrow({
        where: { leadId: m, type: 'MERGED' },
      });
      const late = await migrator().leadActivity.count({
        where: { leadId: m, type: 'ENQUIRY', id: { gt: merged.id } },
      });
      expect(late).toBe(0);
      // Both enquiries exist somewhere in the pair (plus the two creation enquiries).
      expect(await migrator().leadEnquiry.count({ where: { leadId: { in: [s, m] } } })).toBe(4);
    }
  });
});
