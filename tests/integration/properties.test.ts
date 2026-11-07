// FR-140 property inventory and FR-142 confidential owner contacts (migration 0025, ADR-0021):
// codes in sequence per org (also concurrently), validation, the role matrix (§4.5: manage =
// Owner/Admin; read = Owner/Admin/SM/SE; owner contacts = Owner/Admin/SM), edits with optimistic
// locking and audit, list filters and paging, audited contact reveals, removal, other orgs, and the
// database backstop as crm_app. Synthetic data only.
import { beforeAll, describe, expect, it } from 'vitest';
import * as properties from '@/modules/properties';
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

let seq = 0;
const sale = (extra: Record<string, string> = {}) => ({
  title: `Synthetic flat ${++seq}`,
  listingType: 'SALE',
  propertyType: 'APARTMENT',
  city: 'Pune',
  locality: 'Baner',
  price: '85,00,000',
  priceType: 'TOTAL',
  bhk: '2',
  amenities: 'Lift, Parking',
  ...extra,
});
const rent = (extra: Record<string, string> = {}) => ({
  ...sale(),
  title: `Synthetic rental ${++seq}`,
  listingType: 'RENT',
  price: '35000',
  priceType: 'MONTHLY_RENT',
  deposit: '1,00,000',
  ...extra,
});
const row = (id: string) => migrator().property.findUniqueOrThrow({ where: { id } });

async function setup(name: string) {
  const org = await seedOrg(name);
  const a = {} as Record<Role, Actor>;
  for (const k of ['owner', 'admin', 'manager', 'exec1', 'exec2', 'hr'] as const)
    a[k] = await actorIn(org.users[k], org.orgId);
  return { org, a };
}
let A: Awaited<ReturnType<typeof setup>>;
let B: Awaited<ReturnType<typeof setup>>;
beforeAll(async () => {
  A = await setup('PropA');
  B = await setup('PropB');
});

describe('creating properties (FR-140)', () => {
  it('Owner and Admin add properties with codes in sequence per org; audited', async () => {
    const { a, org } = A;
    const first = await properties.createProperty(a.owner.ctx, sale());
    const second = await properties.createProperty(a.admin.ctx, rent());
    expect(first.code).toMatch(/^P-\d{5}$/);
    expect(Number(second.code.slice(2))).toBe(Number(first.code.slice(2)) + 1);
    const p = await row(first.id);
    expect(p).toMatchObject({
      orgId: org.orgId,
      status: 'DRAFT',
      listingType: 'SALE',
      priceType: 'TOTAL',
      bhk: 2,
      amenities: ['Lift', 'Parking'],
      responsibleUserId: org.users.owner.id,
      createdBy: org.users.owner.id,
    });
    expect(p.price.toString()).toBe('8500000');
    expect((await row(second.id)).deposit!.toString()).toBe('100000');
    expect(
      await migrator().auditLog.count({
        where: { action: 'property.created', entityId: first.id },
      }),
    ).toBe(1);
    // Another org has its own sequence.
    expect((await properties.createProperty(B.a.owner.ctx, sale())).code).toBe('P-00001');
  });

  it('concurrent creates get distinct codes', async () => {
    const s = await setup('PropConc');
    const made = await Promise.all(
      Array.from({ length: 5 }, () => properties.createProperty(s.a.admin.ctx, sale())),
    );
    expect(new Set(made.map((m) => m.code)).size).toBe(5);
  });

  it('only Owner and Admin manage; Sales Manager, Executive and HR cannot', async () => {
    const { a } = A;
    for (const who of [a.manager, a.exec1, a.hr])
      expect(await codeOf(properties.createProperty(who.ctx, sale()))).toBe('FORBIDDEN');
  });

  it('validates the listing', async () => {
    const { a, org } = A;
    const bad = (input: Record<string, string>) =>
      failure(properties.createProperty(a.owner.ctx, input));
    expect(await bad(sale({ priceType: 'MONTHLY_RENT' }))).toEqual({
      code: 'VALIDATION_FAILED',
      fields: ['priceType'],
    });
    expect(await bad(sale({ status: 'RENTED' }))).toEqual({
      code: 'VALIDATION_FAILED',
      fields: ['status'],
    });
    expect(await bad(rent({ status: 'SOLD' }))).toEqual({
      code: 'VALIDATION_FAILED',
      fields: ['status'],
    });
    expect(await bad(sale({ deposit: '5000' }))).toEqual({
      code: 'VALIDATION_FAILED',
      fields: ['deposit'],
    });
    expect(await bad(sale({ price: '0' }))).toEqual({
      code: 'VALIDATION_FAILED',
      fields: ['price'],
    });
    expect(await bad(sale({ price: '12.345' }))).toEqual({
      code: 'VALIDATION_FAILED',
      fields: ['price'],
    });
    expect(await bad(sale({ latitude: '18.5' }))).toEqual({
      code: 'VALIDATION_FAILED',
      fields: ['latitude'],
    });
    expect(await bad(sale({ bhk: '25' }))).toEqual({ code: 'VALIDATION_FAILED', fields: ['bhk'] });
    expect(await bad(sale({ availableFrom: '2026-02-30' }))).toEqual({
      code: 'VALIDATION_FAILED',
      fields: ['availableFrom'],
    });
    expect(
      await bad(sale({ amenities: Array.from({ length: 31 }, (_, i) => `A${i}`).join(',') })),
    ).toEqual({ code: 'VALIDATION_FAILED', fields: ['amenities'] });
    // The responsible agent: an active sales member or administrator of this org.
    for (const u of [org.users.hr.id, B.org.users.exec1.id, 'nope'])
      expect(await bad(sale({ responsibleUserId: u }))).toEqual({
        code: 'VALIDATION_FAILED',
        fields: ['responsibleUserId'],
      });
    const ok = await properties.createProperty(
      a.owner.ctx,
      sale({ responsibleUserId: org.users.exec1.id, latitude: '18.559', longitude: '73.7868' }),
    );
    expect(await row(ok.id)).toMatchObject({ responsibleUserId: org.users.exec1.id });
  });
});

describe('reading and listing', () => {
  it('sales roles read; HR and other orgs cannot', async () => {
    const { a } = A;
    const { id } = await properties.createProperty(a.owner.ctx, sale());
    for (const who of [a.owner, a.admin, a.manager, a.exec1])
      expect((await properties.getProperty(who.ctx, id)).id).toBe(id);
    expect(await codeOf(properties.getProperty(a.hr.ctx, id))).toBe('FORBIDDEN');
    expect(await codeOf(properties.getProperty(B.a.owner.ctx, id))).toBe('NOT_FOUND');
    expect(await codeOf(properties.getProperty(a.owner.ctx, 'not-a-uuid'))).toBe('NOT_FOUND');
  });

  it('filters, searches and pages; never other orgs', async () => {
    const s = await setup('PropList');
    const make = (input: Record<string, string>) => properties.createProperty(s.a.owner.ctx, input);
    const villa = await make(
      sale({
        propertyType: 'VILLA',
        city: 'Mumbai',
        price: '3,00,00,000',
        bhk: '4',
        status: 'AVAILABLE',
        locality: 'Juhu',
        title: 'Synthetic sea villa',
      }),
    );
    const flat = await make(sale({ price: '60,00,000', status: 'AVAILABLE' }));
    const let1 = await make(rent({ status: 'RENTED' }));
    const other = await properties.createProperty(
      B.a.owner.ctx,
      sale({ title: 'Synthetic sea villa elsewhere' }),
    );
    const ids = async (q: Record<string, string>) =>
      (await properties.listProperties(s.a.exec1.ctx, q)).rows.map((r) => r.id).sort();
    expect(await ids({ status: 'AVAILABLE' })).toEqual([villa.id, flat.id].sort());
    expect(await ids({ listingType: 'RENT' })).toEqual([let1.id]);
    expect(await ids({ propertyType: 'VILLA' })).toEqual([villa.id]);
    expect(await ids({ city: 'mumbai' })).toEqual([villa.id]);
    expect(await ids({ minPrice: '50,00,000', maxPrice: '1,00,00,000' })).toEqual([flat.id]);
    expect(await ids({ bhk: '4' })).toEqual([villa.id]);
    expect(await ids({ q: 'juhu' })).toEqual([villa.id]);
    expect(await ids({ q: 'sea villa' })).toEqual([villa.id]);
    expect(await ids({ q: (await row(flat.id)).code })).toEqual([flat.id]);
    expect(await ids({})).not.toContain(other.id);
    // Invalid filters are ignored rather than failing the page.
    expect((await ids({ status: 'BOGUS' })).length).toBe(3);
    expect(await codeOf(properties.listProperties(s.a.hr.ctx, {}))).toBe('FORBIDDEN');
    // Paging: 50 per page.
    await Promise.all(Array.from({ length: 50 }, () => make(sale())));
    const p1 = await properties.listProperties(s.a.exec1.ctx, {});
    const p2 = await properties.listProperties(s.a.exec1.ctx, { page: '2' });
    expect([p1.rows.length, p1.hasMore, p2.rows.length, p2.hasMore]).toEqual([50, true, 3, false]);
  });
});

describe('editing', () => {
  it('updates with the version, audits status and price, keeps the code', async () => {
    const { a } = A;
    const { id, code } = await properties.createProperty(a.owner.ctx, sale());
    await properties.updateProperty(
      a.admin.ctx,
      id,
      sale({ price: '90,00,000', status: 'AVAILABLE', version: '1' }),
    );
    const p = await row(id);
    expect(p).toMatchObject({ code, status: 'AVAILABLE', version: 2 });
    expect(p.price.toString()).toBe('9000000');
    const audit = await migrator().auditLog.findFirstOrThrow({
      where: { action: 'property.updated', entityId: id },
    });
    expect(audit.metadata).toMatchObject({
      fromStatus: 'DRAFT',
      toStatus: 'AVAILABLE',
      fromPrice: '8500000',
      toPrice: '9000000',
    });
    expect(await codeOf(properties.updateProperty(a.admin.ctx, id, sale({ version: '1' })))).toBe(
      'CONFLICT',
    );
    // Leaving the status out keeps it.
    await properties.updateProperty(a.admin.ctx, id, {
      ...sale({ price: '90,00,000', version: '2' }),
      title: p.title,
      bhk: '2',
    });
    expect((await row(id)).status).toBe('AVAILABLE');
    expect(await codeOf(properties.updateProperty(a.manager.ctx, id, sale({ version: '3' })))).toBe(
      'FORBIDDEN',
    );
    expect(await codeOf(properties.updateProperty(B.a.owner.ctx, id, sale({ version: '3' })))).toBe(
      'NOT_FOUND',
    );
  });
});

describe('owner contacts (FR-142)', () => {
  it('confidential: added by Owner/Admin, read by Owner/Admin/SM through an audited reveal only', async () => {
    const { a, org } = A;
    const { id } = await properties.createProperty(a.owner.ctx, sale());
    const c1 = await properties.addContact(a.admin.ctx, id, {
      name: 'Synthetic Owner',
      phone: '+91 98765 43210',
      relationship: 'OWNER',
    });
    await properties.addContact(a.owner.ctx, id, {
      name: 'Synthetic Agent',
      email: 'Agent@Example.test',
      relationship: 'AUTHORISED_AGENT',
    });
    expect(
      await failure(
        properties.addContact(a.owner.ctx, id, { name: 'No way', relationship: 'OWNER' }),
      ),
    ).toEqual({ code: 'VALIDATION_FAILED', fields: ['phone'] });
    expect(
      await failure(
        properties.addContact(a.owner.ctx, id, {
          name: 'X',
          phone: '12345',
          relationship: 'OWNER',
        }),
      ),
    ).toEqual({ code: 'VALIDATION_FAILED', fields: ['phone'] });
    expect(
      await codeOf(
        properties.addContact(a.manager.ctx, id, {
          name: 'X',
          phone: '9876543210',
          relationship: 'OWNER',
        }),
      ),
    ).toBe('FORBIDDEN');

    const seen = await properties.revealContacts(a.manager.ctx, id);
    expect(seen.map((c) => [c.name, c.phone, c.email])).toEqual([
      ['Synthetic Owner', '+919876543210', null],
      ['Synthetic Agent', null, 'agent@example.test'],
    ]);
    expect(
      await migrator().auditLog.count({
        where: {
          action: 'property.contacts_viewed',
          entityId: id,
          actorUserId: org.users.manager.id,
        },
      }),
    ).toBe(1);
    for (const who of [a.exec1, a.hr])
      expect(await codeOf(properties.revealContacts(who.ctx, id))).toBe('FORBIDDEN');
    expect(await codeOf(properties.revealContacts(B.a.owner.ctx, id))).toBe('NOT_FOUND');
    // A property read never carries contact data.
    const view = JSON.stringify(await properties.getProperty(a.exec1.ctx, id));
    expect(view).not.toContain('9876543210');
    expect(view).not.toContain('Synthetic Owner');
    // Contact data is never written to the audit log.
    const audits = await migrator().auditLog.findMany({ where: { entityId: id } });
    expect(JSON.stringify(audits)).not.toMatch(/9876543210|Synthetic Owner|agent@example/i);

    await properties.removeContact(a.owner.ctx, c1.id);
    expect((await properties.revealContacts(a.owner.ctx, id)).map((c) => c.name)).toEqual([
      'Synthetic Agent',
    ]);
    expect(
      await migrator().propertyContact.findUniqueOrThrow({ where: { id: c1.id } }),
    ).toMatchObject({ removedBy: org.users.owner.id });
    expect(await codeOf(properties.removeContact(a.owner.ctx, c1.id))).toBe('NOT_FOUND');
    expect(await codeOf(properties.removeContact(a.manager.ctx, c1.id))).toBe('FORBIDDEN');
  });
});

describe('database backstop (crm_app, migration 0025)', () => {
  it('enforces the role matrix and immutability', async () => {
    const { a, org } = A;
    const u = org.users;
    const { id } = await properties.createProperty(a.owner.ctx, sale());
    await properties.addContact(a.owner.ctx, id, {
      name: 'Synthetic Owner',
      phone: '9876500000',
      relationship: 'OWNER',
    });
    const count = async (as: string, table: string) =>
      (
        await asApp(
          org,
          as,
          `SELECT count(*)::int AS n FROM ${table} WHERE ${table === 'property' ? 'id' : 'property_id'} = $1`,
          [id],
        )
      ).rows[0].n;
    expect(await count(u.exec1.id, 'property')).toBe(1);
    expect(await count(u.hr.id, 'property')).toBe(0);
    expect(await count(u.exec1.id, 'property_contact')).toBe(0);
    expect(await count(u.manager.id, 'property_contact')).toBe(1);
    expect(await count(B.org.users.owner.id, 'property')).toBe(0);
    const insert = (as: string) =>
      sqlState(
        asApp(
          org,
          as,
          `INSERT INTO property (org_id, code, title, listing_type, property_type, city, price, price_type, responsible_user_id, created_by)
           VALUES ($1, 'P-99999', 'Synthetic', 'SALE', 'APARTMENT', 'Pune', 100, 'TOTAL', $2, $2)`,
          [org.orgId, as],
        ),
      );
    expect(await insert(u.exec1.id)).toBe('42501');
    expect(await insert(u.manager.id)).toBe('42501');
    const updated = await asApp(
      org,
      u.manager.id,
      `UPDATE property SET title = 'Hacked', version = version + 1 WHERE id = $1`,
      [id],
    );
    expect(updated.rowCount).toBe(0);
    expect(
      await sqlState(
        asApp(org, u.owner.id, `UPDATE property SET code = 'P-77777' WHERE id = $1`, [id]),
      ),
    ).toBe('42501');
    expect(await sqlState(asApp(org, u.owner.id, `DELETE FROM property WHERE id = $1`, [id]))).toBe(
      '42501',
    );
    expect(
      await sqlState(
        asApp(
          org,
          u.owner.id,
          `UPDATE property_contact SET name = 'Changed' WHERE property_id = $1`,
          [id],
        ),
      ),
    ).toBe('42501');
    expect(
      await sqlState(
        asApp(
          org,
          u.owner.id,
          `UPDATE property SET status = 'RENTED', version = version + 1 WHERE id = $1`,
          [id],
        ),
      ),
    ).toBe('23514');
  });
});
