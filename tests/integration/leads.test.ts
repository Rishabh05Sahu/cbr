// Phase 2 M1: lead records — create with duplicate detection, scope, stage changes, notes and
// the timeline, plus the database boundary on the new tables (RLS, grants, forged attribution).
import { beforeAll, describe, expect, it } from 'vitest';
import * as leads from '@/modules/leads';
import * as teams from '@/modules/teams';
import { DomainError } from '@/platform/errors';
import { migrator, withRole } from '../support/db';
import { actorIn, seedOrg, type Actor } from '../support/factory';

const APP = process.env.TEST_DATABASE_URL!;
const AUTH = process.env.TEST_AUTH_DATABASE_URL!;
const PLATFORM = process.env.TEST_PLATFORM_DATABASE_URL!;
const LEAD_TABLES = [
  'lead',
  'lead_activity',
  'lead_enquiry',
  'lead_note',
  'lead_source',
  'lead_stage_history',
];

let A: Awaited<ReturnType<typeof seedOrg>>;
let B: Awaited<ReturnType<typeof seedOrg>>;
const a = {} as Record<'owner' | 'admin' | 'manager' | 'exec1' | 'exec2' | 'hr', Actor>;
let ownerB: Actor;
let teamId: string;

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

async function fieldErrorsOf(p: Promise<unknown>): Promise<Record<string, string[]>> {
  try {
    await p;
  } catch (e) {
    if (e instanceof DomainError) return e.fieldErrors ?? {};
    throw e;
  }
  throw new Error('expected a validation error');
}

let phoneSeq = 0;
/** A fresh valid mobile number per call ("98xxxxxxxx"). */
const nextPhone = () => `98${String(10_000_000 + ++phoneSeq * 7919).slice(-8)}`;

async function created(actor: Actor, input: Record<string, string> = {}): Promise<string> {
  const r = await leads.createLead(actor.ctx, {
    fullName: 'Synthetic Customer',
    primaryPhone: nextPhone(),
    ...input,
  });
  if (r.status !== 'created') throw new Error(`expected created, got ${JSON.stringify(r)}`);
  return r.leadId;
}

const QUALIFIABLE = {
  transactionType: 'BUY',
  propertyType: 'APARTMENT',
  preferredCity: 'Pune',
  budgetMax: '1.2 Cr',
};
const inAWeek = () => {
  const d = new Date(Date.now() + 7 * 864e5 + 5.5 * 36e5); // IST wall clock
  return d.toISOString().slice(0, 16);
};

beforeAll(async () => {
  A = await seedOrg('LeadsA');
  B = await seedOrg('LeadsB');
  for (const k of ['owner', 'admin', 'manager', 'exec1', 'exec2', 'hr'] as const)
    a[k] = await actorIn(A.users[k], A.orgId);
  ownerB = await actorIn(B.users.owner, B.orgId);
  // Team West: manager leads it, exec1 is a member. exec2 is in no team.
  teamId = (await teams.createTeam(a.owner.ctx, { name: 'Team West' })).id;
  await teams.addTeamMember(a.owner.ctx, {
    teamId,
    membershipId: A.membership.manager!,
    teamRole: 'LEAD',
  });
  await teams.addTeamMember(a.owner.ctx, { teamId, membershipId: A.membership.exec1! });
});

describe('create (FR-055) with M0 normalisation', () => {
  it('stores normalised values, assigns to the creator and writes enquiry, history, timeline and audit', async () => {
    const r = await leads.createLead(a.exec1.ctx, {
      fullName: '  Asha Synthetic ',
      primaryPhone: '098765 43210',
      email: 'asha@example.test',
      budgetMin: '85 L',
      budgetMax: '1.2 Cr',
      transactionType: 'BUY',
      preferredLocalities: 'Baner, Aundh, Baner',
      note: 'Walk-in, wants 2 BHK',
      // Ignored: the org, owner, actor and stage come from the server.
      orgId: B.orgId,
      ownerUserId: A.users.exec2.id,
      createdBy: A.users.exec2.id,
      stage: 'WON',
    });
    expect(r.status).toBe('created');
    const id = (r as { leadId: string }).leadId;
    const lead = await migrator().lead.findUniqueOrThrow({ where: { id } });
    expect(lead).toMatchObject({
      orgId: A.orgId,
      fullName: 'Asha Synthetic',
      primaryPhoneE164: '+919876543210',
      primaryPhoneRaw: '098765 43210',
      phoneLast10: '9876543210',
      ownerUserId: A.users.exec1.id,
      createdBy: A.users.exec1.id,
      teamId,
      stage: 'ASSIGNED',
      version: 1,
      preferredLocalities: ['Baner', 'Aundh'],
    });
    expect(lead.budgetMin?.toFixed(2)).toBe('8500000.00');
    expect(lead.budgetMax?.toFixed(2)).toBe('12000000.00');
    const m = migrator();
    expect(await m.leadEnquiry.count({ where: { leadId: id } })).toBe(1);
    expect(await m.leadStageHistory.findMany({ where: { leadId: id } })).toMatchObject([
      { fromStage: null, toStage: 'ASSIGNED', changedBy: A.users.exec1.id, source: 'USER' },
    ]);
    expect(
      (await m.leadActivity.findMany({ where: { leadId: id }, orderBy: { id: 'asc' } })).map(
        (x) => x.type,
      ),
    ).toEqual(['CREATED', 'NOTE']);
    const audit = await m.auditLog.findFirstOrThrow({
      where: { orgId: A.orgId, action: 'lead.created', entityId: id },
    });
    expect(JSON.stringify(audit.metadata)).not.toMatch(/Asha|9876543210|example\.test/);
  });

  it('rejects invalid input with field errors and writes nothing', async () => {
    const before = await migrator().lead.count({ where: { orgId: A.orgId } });
    expect(
      await fieldErrorsOf(
        leads.createLead(a.exec1.ctx, {
          fullName: 'X',
          primaryPhone: '12345',
          alternatePhone: '+44 20 7946 0958',
          budgetMin: '2 Cr',
          budgetMax: '50-75 L',
        }),
      ),
    ).toMatchObject({
      primaryPhone: [expect.stringMatching(/10 digits/)],
      alternatePhone: [expect.stringMatching(/Indian/)],
      budgetMax: [expect.stringMatching(/range/)],
    });
    expect(
      await fieldErrorsOf(
        leads.createLead(a.exec1.ctx, {
          fullName: 'X',
          primaryPhone: nextPhone(),
          budgetMin: '2 Cr',
          budgetMax: '1 Cr',
          bhkMin: '3',
          bhkMax: '2',
        }),
      ),
    ).toMatchObject({ budgetMax: expect.any(Array), bhkMax: expect.any(Array) });
    for (const bad of [
      { fullName: '', primaryPhone: nextPhone() },
      { fullName: 'X', primaryPhone: nextPhone(), transactionType: 'TIMESHARE' },
      { fullName: 'X', primaryPhone: nextPhone(), email: 'not-an-email' },
      { fullName: 'X', primaryPhone: nextPhone(), sourceId: B.orgId },
      { fullName: 'X', primaryPhone: '' },
    ])
      expect(await codeOf(leads.createLead(a.exec1.ctx, bad)), JSON.stringify(bad)).toBe(
        'VALIDATION_FAILED',
      );
    expect(await migrator().lead.count({ where: { orgId: A.orgId } })).toBe(before);
  });

  it('HR cannot create leads (support access is read-only: unit matrix)', async () => {
    expect(await codeOf(created(a.hr))).toBe('FORBIDDEN');
  });
});

describe('duplicate detection (lead-lifecycle §5)', () => {
  let existing: string;
  let phone: string;
  beforeAll(async () => {
    phone = nextPhone();
    existing = await created(a.exec1, { primaryPhone: phone });
  });

  it('same phone in another format: no new lead; in-scope caller may attach', async () => {
    const r = await leads.createLead(a.exec1.ctx, {
      fullName: 'Again',
      primaryPhone: `+91-${phone}`,
    });
    expect(r).toEqual({
      status: 'duplicate',
      leadId: existing,
      canAttach: true,
      archived: false,
    });
  });

  it('matches alternate phones both ways', async () => {
    expect(
      await leads.createLead(a.exec1.ctx, {
        fullName: 'Alt',
        primaryPhone: nextPhone(),
        alternatePhone: phone,
      }),
    ).toMatchObject({ status: 'duplicate', leadId: existing });
    const alt = nextPhone();
    const withAlt = await created(a.exec1, { alternatePhone: alt });
    expect(
      await leads.createLead(a.exec1.ctx, { fullName: 'Alt2', primaryPhone: alt }),
    ).toMatchObject({ status: 'duplicate', leadId: withAlt });
  });

  it('out-of-scope caller learns only that a lead exists, never which', async () => {
    expect(
      await leads.createLead(a.exec2.ctx, { fullName: 'Other exec', primaryPhone: phone }),
    ).toEqual({ status: 'duplicate', leadId: null, canAttach: false, archived: false });
    expect(await codeOf(leads.attachEnquiry(a.exec2.ctx, existing, {}))).toBe('NOT_FOUND');
  });

  it('is tenant-scoped: another org creates the same phone freely', async () => {
    const r = await leads.createLead(ownerB.ctx, { fullName: 'B customer', primaryPhone: phone });
    expect(r.status).toBe('created');
  });

  it('attaching a returning enquiry adds an enquiry and a timeline entry', async () => {
    await leads.attachEnquiry(a.exec1.ctx, existing, { campaign: 'Diwali' });
    expect(await migrator().leadEnquiry.count({ where: { leadId: existing } })).toBe(2);
    expect(
      await migrator().leadActivity.count({ where: { leadId: existing, type: 'ENQUIRY' } }),
    ).toBe(1);
  });

  it('concurrent creates of one new phone produce exactly one lead', async () => {
    const p = nextPhone();
    const results = await Promise.all(
      Array.from({ length: 6 }, (_, i) =>
        leads.createLead(i % 2 ? a.exec1.ctx : a.admin.ctx, {
          fullName: `Race ${i}`,
          primaryPhone: p,
        }),
      ),
    );
    expect(results.filter((r) => r.status === 'created')).toHaveLength(1);
    expect(results.filter((r) => r.status === 'duplicate')).toHaveLength(5);
    expect(
      await migrator().lead.count({ where: { orgId: A.orgId, primaryPhoneE164: `+91${p}` } }),
    ).toBe(1);
  });

  it('the database refuses a second open lead for a phone even without the app check', async () => {
    const lead = await migrator().lead.findUniqueOrThrow({ where: { id: existing } });
    await expect(
      migrator().lead.create({
        data: {
          orgId: A.orgId,
          fullName: 'Bypass',
          primaryPhoneE164: lead.primaryPhoneE164,
          primaryPhoneRaw: 'x',
          phoneLast10: lead.phoneLast10,
          sourceId: lead.sourceId,
          stage: 'NEW',
        },
      }),
    ).rejects.toThrow(/Unique constraint|lead_open_phone_uq/);
  });

  it('a closed lead with the same phone yields a new lead linked to it', async () => {
    const p = nextPhone();
    const first = await created(a.exec1, { primaryPhone: p });
    await leads.changeStage(a.exec1.ctx, first, {
      toStage: 'LOST',
      version: '1',
      reasonCode: 'NOT_INTERESTED',
    });
    const second = await created(a.exec1, { primaryPhone: p });
    expect(
      (await migrator().lead.findUniqueOrThrow({ where: { id: second } })).previousLeadId,
    ).toBe(first);
  });
});

describe('visibility scope (roles §2.2) and tenant isolation', () => {
  let exec1Lead: string;
  let exec2Lead: string;
  let bLead: string;
  beforeAll(async () => {
    exec1Lead = await created(a.exec1, { fullName: 'Exec1 Customer' });
    exec2Lead = await created(a.exec2, { fullName: 'Exec2 Customer' });
    bLead = await created(ownerB, { fullName: 'Org B Customer' });
  });

  it('executives see only their own leads', async () => {
    expect((await leads.getLead(a.exec1.ctx, exec1Lead)).fullName).toBe('Exec1 Customer');
    expect(await codeOf(leads.getLead(a.exec2.ctx, exec1Lead))).toBe('NOT_FOUND');
    expect((await leads.listLeads(a.exec2.ctx)).map((l) => l.id)).not.toContain(exec1Lead);
  });

  it('a manager sees leads of the teams they lead, not others', async () => {
    expect((await leads.getLead(a.manager.ctx, exec1Lead)).canChangeStage).toBe(true);
    expect(await codeOf(leads.getLead(a.manager.ctx, exec2Lead))).toBe('NOT_FOUND');
    const ids = (await leads.listLeads(a.manager.ctx)).map((l) => l.id);
    expect(ids).toContain(exec1Lead);
    expect(ids).not.toContain(exec2Lead);
  });

  it('owner and admin see every lead in their org; HR sees none', async () => {
    for (const k of ['owner', 'admin'] as const) {
      expect((await leads.getLead(a[k].ctx, exec2Lead)).id).toBe(exec2Lead);
      expect((await leads.getLead(a[k].ctx, exec1Lead)).canReopen).toBe(true);
    }
    expect(await codeOf(leads.getLead(a.hr.ctx, exec1Lead))).toBe('FORBIDDEN');
    expect(await codeOf(leads.listLeads(a.hr.ctx))).toBe('FORBIDDEN');
  });

  it("another org's lead id is not found for every read and write", async () => {
    const o = a.owner.ctx;
    expect(await codeOf(leads.getLead(o, bLead))).toBe('NOT_FOUND');
    expect(await codeOf(leads.getTimeline(o, bLead))).toBe('NOT_FOUND');
    expect(await codeOf(leads.addNote(o, bLead, { body: 'x' }))).toBe('NOT_FOUND');
    expect(await codeOf(leads.attachEnquiry(o, bLead, {}))).toBe('NOT_FOUND');
    expect(await codeOf(leads.changeStage(o, bLead, { toStage: 'CONTACTED', version: '1' }))).toBe(
      'NOT_FOUND',
    );
    expect(await codeOf(leads.updateRequirements(o, bLead, { version: '1', intent: 'HOT' }))).toBe(
      'NOT_FOUND',
    );
    expect((await leads.listLeads(o)).map((l) => l.id)).not.toContain(bLead);
    const b = await migrator().lead.findUniqueOrThrow({ where: { id: bLead } });
    expect(b).toMatchObject({ stage: 'ASSIGNED', version: 1 });
    expect(await migrator().leadNote.count({ where: { leadId: bLead } })).toBe(0);
  });

  it('an executive cannot write to a lead outside their scope', async () => {
    const e = a.exec2.ctx;
    expect(await codeOf(leads.addNote(e, exec1Lead, { body: 'x' }))).toBe('NOT_FOUND');
    expect(
      await codeOf(leads.changeStage(e, exec1Lead, { toStage: 'CONTACTED', version: '1' })),
    ).toBe('NOT_FOUND');
    expect(
      await codeOf(leads.updateRequirements(e, exec1Lead, { version: '1', intent: 'HOT' })),
    ).toBe('NOT_FOUND');
  });

  it('malformed ids are not found, not errors', async () => {
    expect(await codeOf(leads.getLead(a.owner.ctx, "1' OR '1'='1"))).toBe('NOT_FOUND');
  });
});

describe('stage changes (FR-058, lead-lifecycle §2.1)', () => {
  it('skips forward with implied milestones, atomically with history, timeline and audit', async () => {
    const id = await created(a.exec1, QUALIFIABLE);
    await leads.changeStage(a.exec1.ctx, id, {
      toStage: 'SITE_VISIT_SCHEDULED',
      version: '1',
      visitAt: inAWeek(),
      // Ignored by the server:
      changedBy: A.users.owner.id,
      occurredAt: '2020-01-01T00:00:00Z',
    });
    const m = migrator();
    const lead = await m.lead.findUniqueOrThrow({ where: { id } });
    expect(lead).toMatchObject({ stage: 'SITE_VISIT_SCHEDULED', version: 2 });
    expect(lead.firstContactedAt).not.toBeNull();
    expect(lead.qualifiedAt).not.toBeNull();
    expect(lead.firstVisitScheduledAt).not.toBeNull();
    const history = await m.leadStageHistory.findMany({
      where: { leadId: id },
      orderBy: { id: 'asc' },
    });
    expect(history.map((h) => [h.fromStage, h.toStage, h.reasonCode])).toEqual([
      [null, 'ASSIGNED', null],
      ['ASSIGNED', 'CONTACTED', 'IMPLIED'],
      ['CONTACTED', 'QUALIFIED', 'IMPLIED'],
      ['QUALIFIED', 'SITE_VISIT_SCHEDULED', null],
    ]);
    for (const h of history) {
      expect(h.changedBy).toBe(A.users.exec1.id);
      expect(Date.now() - h.occurredAt.getTime()).toBeLessThan(60_000);
    }
    const stage = await m.leadActivity.findFirstOrThrow({ where: { leadId: id, type: 'STAGE' } });
    expect(stage).toMatchObject({
      actorId: A.users.exec1.id,
      summary: {
        from: 'ASSIGNED',
        to: 'SITE_VISIT_SCHEDULED',
        implied: ['CONTACTED', 'QUALIFIED'],
      },
    });
    expect(
      await m.auditLog.count({
        where: { orgId: A.orgId, action: 'lead.stage_changed', entityId: id },
      }),
    ).toBe(1);
  });

  it('rejects invalid stages, transitions, missing entry data and stale versions', async () => {
    const id = await created(a.exec1);
    const c = a.exec1.ctx;
    expect(await codeOf(leads.changeStage(c, id, { toStage: 'FOO', version: '1' }))).toBe(
      'VALIDATION_FAILED',
    );
    expect(await codeOf(leads.changeStage(c, id, { toStage: 'WON', version: '1' }))).toBe(
      'RULE_VIOLATION',
    );
    expect(await codeOf(leads.changeStage(c, id, { toStage: 'ASSIGNED', version: '1' }))).toBe(
      'RULE_VIOLATION',
    );
    expect(await codeOf(leads.changeStage(c, id, { toStage: 'QUALIFIED', version: '1' }))).toBe(
      'VALIDATION_FAILED',
    );
    expect(await codeOf(leads.changeStage(c, id, { toStage: 'LOST', version: '1' }))).toBe(
      'VALIDATION_FAILED',
    );
    expect(
      await codeOf(
        leads.changeStage(c, id, {
          toStage: 'SITE_VISIT_SCHEDULED',
          version: '1',
          visitAt: '2026-02-30T10:00',
        }),
      ),
    ).toBe('VALIDATION_FAILED');
    await leads.changeStage(c, id, { toStage: 'CONTACTED', version: '1' });
    expect(await codeOf(leads.changeStage(c, id, { toStage: 'NURTURE', version: '1' }))).toBe(
      'CONFLICT',
    );
    const lead = await migrator().lead.findUniqueOrThrow({ where: { id } });
    expect(lead).toMatchObject({ stage: 'CONTACTED', version: 2 });
    expect(await migrator().leadStageHistory.count({ where: { leadId: id } })).toBe(2);
  });

  it('only a manager reopens a lost lead, with a reason', async () => {
    const id = await created(a.exec1);
    await leads.changeStage(a.exec1.ctx, id, {
      toStage: 'LOST',
      version: '1',
      reasonCode: 'NOT_REACHABLE',
    });
    expect(
      await codeOf(
        leads.changeStage(a.exec1.ctx, id, { toStage: 'CONTACTED', version: '2', reasonText: 'x' }),
      ),
    ).toBe('RULE_VIOLATION');
    expect(
      await codeOf(leads.changeStage(a.manager.ctx, id, { toStage: 'CONTACTED', version: '2' })),
    ).toBe('VALIDATION_FAILED');
    await leads.changeStage(a.manager.ctx, id, {
      toStage: 'CONTACTED',
      version: '2',
      reasonText: 'Customer called back',
    });
    const lead = await migrator().lead.findUniqueOrThrow({ where: { id } });
    expect(lead.stage).toBe('CONTACTED');
    expect(lead.lostAt).not.toBeNull(); // milestones are never cleared
  });

  it('reopening fails when a newer open lead has the phone', async () => {
    const p = nextPhone();
    const old = await created(a.exec1, { primaryPhone: p });
    await leads.changeStage(a.exec1.ctx, old, {
      toStage: 'LOST',
      version: '1',
      reasonCode: 'OTHER',
    });
    await created(a.exec1, { primaryPhone: p });
    expect(
      await codeOf(
        leads.changeStage(a.owner.ctx, old, {
          toStage: 'CONTACTED',
          version: '2',
          reasonText: 'r',
        }),
      ),
    ).toBe('CONFLICT');
  });

  it('if the timeline write fails, the stage change and its history roll back', async () => {
    const id = await created(a.exec1);
    const m = migrator();
    await m.$executeRawUnsafe(
      `ALTER TABLE lead_activity ADD CONSTRAINT test_block_stage
         CHECK (NOT (type = 'STAGE' AND lead_id = '${id}'::uuid)) NOT VALID`,
    );
    try {
      await expect(
        leads.changeStage(a.exec1.ctx, id, { toStage: 'CONTACTED', version: '1' }),
      ).rejects.toThrow(/test_block_stage/);
    } finally {
      await m.$executeRawUnsafe('ALTER TABLE lead_activity DROP CONSTRAINT test_block_stage');
    }
    expect(await m.lead.findUniqueOrThrow({ where: { id } })).toMatchObject({
      stage: 'ASSIGNED',
      version: 1,
      firstContactedAt: null,
    });
    expect(await m.leadStageHistory.count({ where: { leadId: id } })).toBe(1);
    expect(await m.auditLog.count({ where: { action: 'lead.stage_changed', entityId: id } })).toBe(
      0,
    );
  });
});

describe('requirements, notes and timeline (FR-058, FR-059, FR-032)', () => {
  it('requirement edits use the M0 parser, bump the version and log changed field names', async () => {
    const id = await created(a.exec1);
    await leads.updateRequirements(a.exec1.ctx, id, {
      version: '1',
      budgetMax: '95 L',
      preferredCity: 'Pune',
      intent: 'HOT',
    });
    const lead = await migrator().lead.findUniqueOrThrow({ where: { id } });
    expect(lead).toMatchObject({ version: 2, preferredCity: 'Pune', intent: 'HOT' });
    expect(lead.budgetMax?.toFixed(2)).toBe('9500000.00');
    expect(
      await migrator().leadActivity.findFirstOrThrow({
        where: { leadId: id, type: 'FIELD_CHANGED' },
      }),
    ).toMatchObject({ summary: { fields: ['budgetMax', 'preferredCity', 'intent'] } });
    expect(
      await codeOf(leads.updateRequirements(a.exec1.ctx, id, { version: '1', intent: 'COLD' })),
    ).toBe('CONFLICT');
    expect(
      await codeOf(leads.updateRequirements(a.exec1.ctx, id, { version: '2', budgetMin: 'lots' })),
    ).toBe('VALIDATION_FAILED');
  });

  it('notes: author edits within 15 minutes; nobody else, and never after', async () => {
    const id = await created(a.exec1);
    const { id: noteId } = await leads.addNote(a.exec1.ctx, id, { body: 'First call done' });
    await leads.editNote(a.exec1.ctx, noteId, { body: 'First call done, call back Friday' });
    expect(await codeOf(leads.editNote(a.manager.ctx, noteId, { body: 'rewritten' }))).toBe(
      'RULE_VIOLATION',
    );
    expect(await codeOf(leads.editNote(a.exec2.ctx, noteId, { body: 'rewritten' }))).toBe(
      'NOT_FOUND',
    );
    expect(await codeOf(leads.editNote(ownerB.ctx, noteId, { body: 'rewritten' }))).toBe(
      'NOT_FOUND',
    );
    expect(await codeOf(leads.addNote(a.exec1.ctx, id, { body: '   ' }))).toBe('VALIDATION_FAILED');
    await migrator().leadNote.update({
      where: { id: noteId },
      data: {
        createdAt: new Date(Date.now() - 20 * 60_000),
        editedUntil: new Date(Date.now() - 5 * 60_000),
      },
    });
    expect(await codeOf(leads.editNote(a.exec1.ctx, noteId, { body: 'late edit' }))).toBe(
      'RULE_VIOLATION',
    );
    expect((await migrator().leadNote.findUniqueOrThrow({ where: { id: noteId } })).body).toBe(
      'First call done, call back Friday',
    );
  });

  it('timeline: newest first, attributed, with note bodies; scope-checked', async () => {
    const id = await created(a.exec1, { note: 'Opening note' });
    await leads.changeStage(a.exec1.ctx, id, { toStage: 'CONTACTED', version: '1' });
    const t = await leads.getTimeline(a.exec1.ctx, id);
    expect(t.map((e) => e.type)).toEqual(['STAGE', 'NOTE', 'CREATED']);
    expect(t[1]!.note).toMatchObject({ body: 'Opening note', editable: true });
    expect(t.every((e) => e.actorName === A.users.exec1.name)).toBe(true);
    const asManager = await leads.getTimeline(a.manager.ctx, id);
    expect(asManager[1]!.note?.editable).toBe(false);
    expect(await codeOf(leads.getTimeline(a.exec2.ctx, id))).toBe('NOT_FOUND');
    expect(await codeOf(leads.getTimeline(a.hr.ctx, id))).toBe('FORBIDDEN');
  });
});

describe('database boundary on the new tables', () => {
  it('RLS is enabled and forced, with a crm_app tenant policy, on every lead table', async () => {
    const { rows } = await withRole(process.env.TEST_MIGRATOR_URL!, (c) =>
      c.query(
        `SELECT c.relname, c.relrowsecurity AND c.relforcerowsecurity AS forced,
                EXISTS (SELECT 1 FROM pg_policies p WHERE p.tablename = c.relname
                        AND p.policyname = 'tenant_isolation' AND 'crm_app' = ANY (p.roles)) AS tenant
         FROM pg_class c WHERE c.relnamespace = 'public'::regnamespace AND c.relname = ANY ($1)
         ORDER BY 1`,
        [LEAD_TABLES],
      ),
    );
    expect(rows).toEqual(LEAD_TABLES.map((t) => ({ relname: t, forced: true, tenant: true })));
  });

  it('crm_app has exactly the minimum grants; crm_auth and crm_platform have none', async () => {
    const { rows } = await withRole(process.env.TEST_MIGRATOR_URL!, (c) =>
      c.query(
        `SELECT grantee, table_name, string_agg(privilege_type, ',' ORDER BY privilege_type) AS p
         FROM information_schema.role_table_grants
         WHERE table_schema = 'public' AND table_name = ANY ($1)
           AND grantee IN ('crm_app', 'crm_auth', 'crm_platform', 'crm_definer')
         GROUP BY 1, 2 ORDER BY 1, 2`,
        [LEAD_TABLES],
      ),
    );
    expect(rows).toEqual(
      LEAD_TABLES.map((t) => ({ grantee: 'crm_app', table_name: t, p: 'INSERT,SELECT' })),
    );
    const cols = await withRole(process.env.TEST_MIGRATOR_URL!, (c) =>
      c.query(
        `SELECT table_name, column_name FROM information_schema.column_privileges
         WHERE grantee = 'crm_app' AND privilege_type = 'UPDATE' AND table_schema = 'public'
           AND table_name = ANY ($1) AND column_name IN
             ('id', 'org_id', 'created_at', 'created_by', 'author_id', 'lead_id', 'edited_until')`,
        [LEAD_TABLES],
      ),
    );
    expect(cols.rows).toEqual([]);
    for (const url of [AUTH, PLATFORM])
      await withRole(url, async (c) => {
        for (const t of LEAD_TABLES)
          await expect(c.query(`SELECT 1 FROM ${t} LIMIT 1`), t).rejects.toThrow(
            /permission denied/,
          );
      });
  });

  /** Raw crm_app session with org A / exec1 context, as withTenant sets it. */
  async function asApp<T>(fn: (q: (sql: string, v?: unknown[]) => Promise<unknown>) => Promise<T>) {
    return withRole(APP, async (c) => {
      await c.query('BEGIN');
      try {
        await c.query(
          "SELECT set_config('app.org_id', $1, true), set_config('app.user_id', $2, true)",
          [A.orgId, A.users.exec1.id],
        );
        return await fn(async (sql, v) => (await c.query(sql, v)).rows);
      } finally {
        await c.query('ROLLBACK');
      }
    });
  }

  it('raw SQL as crm_app: no context sees nothing; context sees only its org', async () => {
    await withRole(APP, async (c) => {
      for (const t of LEAD_TABLES)
        expect((await c.query(`SELECT count(*)::int AS n FROM ${t}`)).rows[0].n, t).toBe(0);
    });
    await asApp(async (q) => {
      const rows = (await q('SELECT DISTINCT org_id FROM lead')) as { org_id: string }[];
      expect(rows).toEqual([{ org_id: A.orgId }]);
    });
  });

  it('attribution, tenant and timestamps cannot be forged, and history is append-only', async () => {
    const leadId = await created(a.exec1);
    const bLead = await created(ownerB);
    const tries: [string, string, unknown[]][] = [
      [
        'actor is another user',
        `INSERT INTO lead_activity (org_id, lead_id, type, actor_id) VALUES ($1, $2, 'NOTE', $3)`,
        [A.orgId, leadId, A.users.owner.id],
      ],
      [
        'backdated timeline entry',
        `INSERT INTO lead_activity (org_id, lead_id, type, actor_id, occurred_at)
         VALUES ($1, $2, 'NOTE', $3, now() - interval '1 day')`,
        [A.orgId, leadId, A.users.exec1.id],
      ],
      [
        'history in another org',
        `INSERT INTO lead_stage_history (org_id, lead_id, to_stage, changed_by) VALUES ($1, $2, 'WON', $3)`,
        [B.orgId, bLead, A.users.exec1.id],
      ],
      [
        'note on another org lead',
        `INSERT INTO lead_note (org_id, lead_id, author_id, body, edited_until)
         VALUES ($1, $2, $3, 'x', now() + interval '1 minute')`,
        [A.orgId, bLead, A.users.exec1.id],
      ],
      [
        'note authored as someone else',
        `INSERT INTO lead_note (org_id, lead_id, author_id, body, edited_until)
         VALUES ($1, $2, $3, 'x', now() + interval '1 minute')`,
        [A.orgId, leadId, A.users.exec2.id],
      ],
      ['rewrite history', `UPDATE lead_stage_history SET to_stage = 'WON'`, []],
      ['rewrite timeline', `UPDATE lead_activity SET actor_id = NULL`, []],
      ['delete notes', `DELETE FROM lead_note`, []],
      ['delete leads', `DELETE FROM lead`, []],
      ['move a lead to another org', `UPDATE lead SET org_id = $1`, [B.orgId]],
      ['change the creator', `UPDATE lead SET created_by = NULL`, []],
    ];
    for (const [what, sql, values] of tries)
      await expect(
        asApp((q) => q(sql, values)),
        what,
      ).rejects.toThrow(/row-level security|permission denied|foreign key|violates/);
    // The same session may append correctly attributed rows.
    await asApp(async (q) => {
      await q(
        `INSERT INTO lead_activity (org_id, lead_id, type, actor_id) VALUES ($1, $2, 'NOTE', $3)`,
        [A.orgId, leadId, A.users.exec1.id],
      );
    });
  });
});
