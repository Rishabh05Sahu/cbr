// Phase 2 M5 Slice 3: custom field definitions and lead values through the leads module
// (Owner/Admin management, 30-active limit incl. concurrency, immutable key/type, option removal
// safety, strict values with no coercion, archived fields, required fields, scope, stale writes).
// Synthetic data only; crm_test only.
import { randomUUID } from 'node:crypto';
import { beforeAll, describe, expect, it } from 'vitest';
import * as leads from '@/modules/leads';
import { DomainError } from '@/platform/errors';
import { migrator } from '../support/db';
import { actorIn, seedOrg, type Actor } from '../support/factory';

let A: Awaited<ReturnType<typeof seedOrg>>;
let B: Awaited<ReturnType<typeof seedOrg>>;
let C: Awaited<ReturnType<typeof seedOrg>>;
const a = {} as Record<'owner' | 'admin' | 'manager' | 'exec1' | 'exec2', Actor>;
let ownerB: Actor;
let ownerC: Actor;

let seq = 0;
const phone = () => `91${String(60_000_000 + ++seq * 6_037 + (process.pid % 1000)).slice(-8)}`;

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

const field = async (by: Actor, key: string, extra: Record<string, unknown> = {}) =>
  (await leads.createCustomField(by.ctx, { key, label: `Label ${key}`, type: 'text', ...extra }))
    .id;
const def = (id: string) => migrator().customFieldDefinition.findUniqueOrThrow({ where: { id } });
const lead = (id: string) => migrator().lead.findUniqueOrThrow({ where: { id } });

async function newLead(
  by: Actor = a.exec1,
  customFields?: Record<string, unknown>,
): Promise<string> {
  const r = await leads.createLead(by.ctx, {
    fullName: 'Synthetic Customer',
    primaryPhone: phone(),
    ...(customFields ? { customFields } : {}),
  });
  if (r.status !== 'created') throw new Error(`expected created, got ${JSON.stringify(r)}`);
  return r.leadId;
}
const setValues = async (by: Actor, id: string, values: Record<string, unknown>) =>
  leads.setLeadCustomFields(by.ctx, id, { version: (await lead(id)).version, values });

beforeAll(async () => {
  A = await seedOrg('FieldsA');
  B = await seedOrg('FieldsB');
  C = await seedOrg('FieldsC');
  for (const k of ['owner', 'admin', 'manager', 'exec1', 'exec2'] as const)
    a[k] = await actorIn(A.users[k], A.orgId);
  ownerB = await actorIn(B.users.owner, B.orgId);
  ownerC = await actorIn(C.users.owner, C.orgId);
  await field(a.owner, 'visit_slot', { type: 'single_select', options: ['Morning', 'Evening'] });
  await field(a.owner, 'family_size', { type: 'number' });
  await field(a.owner, 'move_in', { type: 'date' });
  await field(a.owner, 'amenities', { type: 'multi_select', options: ['Gym', 'Pool', 'Park'] });
  await field(a.owner, 'nri', { type: 'boolean' });
});

describe('definitions', () => {
  it('Owner and Admin manage fields; others cannot; audit is written', async () => {
    const id = await field(a.admin, 'pet_friendly', { type: 'boolean' });
    expect(
      await migrator().auditLog.count({ where: { action: 'custom_field.created', entityId: id } }),
    ).toBe(1);
    for (const who of [a.manager, a.exec1])
      expect(await codeOf(field(who, `x_${randomUUID().slice(0, 6)}`))).toBe('FORBIDDEN');
    expect(
      await codeOf(leads.updateCustomField(a.manager.ctx, id, { version: 1, label: 'X' })),
    ).toBe('FORBIDDEN');
  });

  it('every member with lead access can list active fields; other orgs see none of them', async () => {
    const keys = (await leads.listCustomFields(a.exec1.ctx)).map((f) => f.key);
    expect(keys).toEqual(
      expect.arrayContaining(['visit_slot', 'family_size', 'move_in', 'amenities', 'nri']),
    );
    expect((await leads.listCustomFields(ownerB.ctx)).map((f) => f.key)).not.toContain(
      'visit_slot',
    );
    expect(
      await codeOf(
        leads.updateCustomField(ownerB.ctx, (await leads.listCustomFields(a.owner.ctx))[0]!.id, {
          version: 1,
        }),
      ),
    ).toBe('NOT_FOUND');
  });

  it('refuses reserved, malformed and duplicate keys; keys are never reused after archiving', async () => {
    expect(await codeOf(field(a.owner, 'phone'))).toBe('VALIDATION_FAILED');
    expect(await codeOf(field(a.owner, 'Bad Key'))).toBe('VALIDATION_FAILED');
    expect(await codeOf(field(a.owner, 'visit_slot'))).toBe('CONFLICT');
    const id = await field(a.owner, 'old_field');
    await leads.setCustomFieldArchived(a.owner.ctx, id, true, { version: 1 });
    expect(await codeOf(field(a.owner, 'old_field'))).toBe('CONFLICT');
  });

  it('key and type are immutable; stale versions are refused', async () => {
    const id = await field(a.owner, 'budget_note');
    expect(
      await codeOf(leads.updateCustomField(a.owner.ctx, id, { version: 1, key: 'other' })),
    ).toBe('VALIDATION_FAILED');
    expect(
      await codeOf(leads.updateCustomField(a.owner.ctx, id, { version: 1, type: 'number' })),
    ).toBe('VALIDATION_FAILED');
    await leads.updateCustomField(a.owner.ctx, id, { version: 1, label: 'Budget note' });
    expect(
      await codeOf(leads.updateCustomField(a.owner.ctx, id, { version: 1, label: 'Again' })),
    ).toBe('CONFLICT');
    expect(await def(id)).toMatchObject({
      key: 'budget_note',
      type: 'text',
      label: 'Budget note',
      version: 2,
    });
  });

  it('an option still used by a lead cannot be removed; unused ones can', async () => {
    const id = await field(a.owner, 'facing', {
      type: 'single_select',
      options: ['East', 'West', 'North'],
    });
    const l = await newLead();
    await setValues(a.exec1, l, { facing: 'West' });
    expect(
      await codeOf(
        leads.updateCustomField(a.owner.ctx, id, { version: 1, options: ['East', 'North'] }),
      ),
    ).toBe('RULE_VIOLATION');
    await leads.updateCustomField(a.owner.ctx, id, { version: 1, options: ['East', 'West'] });
    const tags = await field(a.owner, 'tags_x', { type: 'multi_select', options: ['A', 'B'] });
    await setValues(a.exec1, l, { tags_x: ['B'] });
    expect(
      await codeOf(leads.updateCustomField(a.owner.ctx, tags, { version: 1, options: ['A'] })),
    ).toBe('RULE_VIOLATION');
  });
});

describe('the 30-active limit', () => {
  it('31st refused; concurrent 30th/31st cannot both succeed; archive frees, restore past it refused', async () => {
    for (let i = 1; i <= 28; i++) await field(ownerC, `c_field_${i}`);
    const results = await Promise.all([
      codeOf(field(ownerC, 'c_field_29')),
      codeOf(field(ownerC, 'c_field_30')),
      codeOf(field(ownerC, 'c_field_31')),
    ]);
    expect(results.sort()).toEqual(['OK', 'OK', 'RULE_VIOLATION']);
    expect(
      await migrator().customFieldDefinition.count({ where: { orgId: C.orgId, archivedAt: null } }),
    ).toBe(30);
    expect(await codeOf(field(ownerC, 'c_field_32'))).toBe('RULE_VIOLATION');
    const first = await migrator().customFieldDefinition.findFirstOrThrow({
      where: { orgId: C.orgId, key: 'c_field_1' },
    });
    await leads.setCustomFieldArchived(ownerC.ctx, first.id, true, { version: first.version });
    expect(await codeOf(field(ownerC, 'c_field_33'))).toBe('OK');
    expect(
      await codeOf(
        leads.setCustomFieldArchived(ownerC.ctx, first.id, false, { version: first.version + 1 }),
      ),
    ).toBe('RULE_VIOLATION');
  });
});

describe('lead values', () => {
  it('stores typed values; clears with null; keeps other values', async () => {
    const l = await newLead();
    await setValues(a.exec1, l, {
      visit_slot: 'Morning',
      family_size: 4,
      move_in: '2027-02-28',
      amenities: ['Gym', 'Park'],
      nri: false,
    });
    await setValues(a.exec1, l, { family_size: null });
    expect((await lead(l)).customFields).toEqual({
      visit_slot: 'Morning',
      move_in: '2027-02-28',
      amenities: ['Gym', 'Park'],
      nri: false,
    });
    expect(
      await migrator().leadActivity.count({ where: { leadId: l, type: 'FIELD_CHANGED' } }),
    ).toBe(2);
  });

  it.each([
    ['a number given as text', { family_size: '4' }, 'customFields.family_size'],
    ['a boolean given as text', { nri: 'true' }, 'customFields.nri'],
    ['an impossible date', { move_in: '2027-02-30' }, 'customFields.move_in'],
    ['an unknown option', { visit_slot: 'Night' }, 'customFields.visit_slot'],
    ['a repeated option', { amenities: ['Gym', 'Gym'] }, 'customFields.amenities'],
    ['an unknown field', { mystery: 1 }, 'customFields.mystery'],
  ])('refuses %s, without coercion', async (_, values, key) => {
    const l = await newLead();
    expect(await failure(setValues(a.exec1, l, values))).toEqual({
      code: 'VALIDATION_FAILED',
      fields: [key],
    });
    expect((await lead(l)).customFields).toEqual({});
  });

  it('archived fields keep stored values but accept no new value', async () => {
    const id = await field(a.owner, 'legacy_ref');
    const l = await newLead();
    await setValues(a.exec1, l, { legacy_ref: 'Synthetic ref' });
    await leads.setCustomFieldArchived(a.owner.ctx, id, true, { version: 1 });
    expect(await failure(setValues(a.exec1, l, { legacy_ref: 'New' }))).toEqual({
      code: 'VALIDATION_FAILED',
      fields: ['customFields.legacy_ref'],
    });
    await setValues(a.exec1, l, { nri: true });
    expect((await lead(l)).customFields).toEqual({ legacy_ref: 'Synthetic ref', nri: true });
    expect((await leads.getLead(a.exec1.ctx, l)).customFields).toMatchObject({
      legacy_ref: 'Synthetic ref',
    });
  });

  it('scope, other orgs, archived leads and stale versions', async () => {
    const mine = await newLead(a.exec1);
    expect(await codeOf(setValues(a.exec2, mine, { nri: true }))).toBe('NOT_FOUND');
    expect(await codeOf(setValues(ownerB, mine, { nri: true }))).toBe('NOT_FOUND');
    expect(
      await codeOf(
        leads.setLeadCustomFields(a.exec1.ctx, mine, {
          version: (await lead(mine)).version + 1,
          values: { nri: true },
        }),
      ),
    ).toBe('CONFLICT');
    await leads.archiveLead(a.owner.ctx, mine, { version: (await lead(mine)).version });
    expect(await codeOf(setValues(a.owner, mine, { nri: true }))).toBe('RULE_VIOLATION');
  });
});

describe('required fields', () => {
  it('manual create and imports must supply them; they cannot be cleared; unknown values refused', async () => {
    const org = await seedOrg('FieldsReq');
    const owner = await actorIn(org.users.owner, org.orgId);
    await field(owner, 'site_city', { required: true });
    expect(
      await failure(leads.createLead(owner.ctx, { fullName: 'Synthetic', primaryPhone: phone() })),
    ).toEqual({
      code: 'VALIDATION_FAILED',
      fields: ['customFields.site_city'],
    });
    expect(
      await failure(
        leads.createLead(owner.ctx, {
          fullName: 'Synthetic',
          primaryPhone: phone(),
          customFields: { site_city: 'Pune', x: 1 },
        }),
      ),
    ).toEqual({ code: 'VALIDATION_FAILED', fields: ['customFields.x'] });
    const id = await newLead(owner, { site_city: 'Pune' });
    expect((await lead(id)).customFields).toEqual({ site_city: 'Pune' });
    expect(await failure(setValues(owner, id, { site_city: null }))).toEqual({
      code: 'VALIDATION_FAILED',
      fields: ['customFields.site_city'],
    });
    // Imports enforce required custom fields too (M5 completion): a row without one is refused.
    const src = (await lead(id)).sourceId;
    const prepared = leads.prepareLead(
      leads.createInput.parse({ fullName: 'Imported', primaryPhone: phone() }),
    );
    if (!prepared.ok) throw new Error('fixture');
    const out = await leads.importLeadBatch(
      owner.ctx,
      [{ row: 2, lead: prepared.lead, sourceId: src }],
      {
        importId: randomUUID(),
        duplicatePolicy: 'ATTACH',
        assignment: { mode: 'none' },
      },
    );
    expect(out).toEqual([
      {
        row: 2,
        outcome: 'FAILED',
        leadId: null,
        field: 'CF_site_city',
        code: 'CUSTOM_FIELD_REQUIRED',
      },
    ]);
  });
});
