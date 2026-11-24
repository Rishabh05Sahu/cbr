// Owner request 2026-11-24 (app items 1–2 and the team dashboard): properties on a site visit
// (migration 0032), editing a lead's contact details, the lead list's tag filter, and the
// dashboard's per-person table (roles, team roster). Synthetic data only.
import { beforeAll, describe, expect, it } from 'vitest';
import * as leads from '@/modules/leads';
import * as properties from '@/modules/properties';
import { dashboard } from '@/modules/reporting';
import * as teams from '@/modules/teams';
import * as visits from '@/modules/visits';
import { DomainError } from '@/platform/errors';
import { migrator, withRole } from '../support/db';
import { actorIn, seedOrg, type Actor } from '../support/factory';

const APP = process.env.TEST_DATABASE_URL!;
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
async function sqlState(p: Promise<unknown>): Promise<string> {
  try {
    await p;
    return 'OK';
  } catch (e) {
    return (e as { code?: string }).code ?? 'ERR';
  }
}

/** A datetime-local value `minutes` from now in India time (the seeded org's zone). */
const local = (minutes: number) =>
  new Date(Date.now() + minutes * 60_000 + 330 * 60_000).toISOString().slice(0, 16);

let seq = 0;
const phone = () => `98${String(20_000_000 + ++seq * 7_717 + (process.pid % 1000)).slice(-8)}`;
async function created(by: Actor, extra: Record<string, string> = {}): Promise<string> {
  const r = await leads.createLead(by.ctx, {
    fullName: 'Synthetic Extras Lead',
    primaryPhone: phone(),
    transactionType: 'BUY',
    propertyType: 'APARTMENT',
    preferredCity: 'Dubai',
    budgetMax: '2M',
    ...extra,
  });
  if (r.status !== 'created') throw new Error('fixture lead');
  return r.leadId;
}
async function property(by: Actor): Promise<string> {
  return (
    await properties.createProperty(by.ctx, {
      title: `Synthetic tower unit ${++seq}`,
      listingType: 'SALE',
      propertyType: 'APARTMENT',
      city: 'Dubai',
      locality: 'Marina',
      price: '1800000',
      priceType: 'TOTAL',
      bhk: '2',
    })
  ).id;
}
const versionOf = async (id: string) =>
  (await migrator().lead.findUniqueOrThrow({ where: { id } })).version;
const visitVersion = async (id: string) =>
  (await migrator().siteVisit.findUniqueOrThrow({ where: { id } })).version;

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
  return { org, a, west };
}
let A: Awaited<ReturnType<typeof setup>>;
let B: Awaited<ReturnType<typeof setup>>;
beforeAll(async () => {
  A = await setup('ExtrasA');
  B = await setup('ExtrasB');
});

describe('properties on a site visit (migration 0032)', () => {
  it('books a visit with properties and changes the list while the visit is open', async () => {
    const { a } = A;
    const [p1, p2, p3] = [
      await property(a.owner),
      await property(a.owner),
      await property(a.owner),
    ];
    const l = await created(a.exec1);
    const { id } = await visits.scheduleVisit(a.exec1.ctx, l, {
      scheduledFor: local(24 * 60),
      location: 'Synthetic marina lobby',
      propertyIds: [p1, p2],
    });
    let view = (await visits.visitsForLead(a.exec1.ctx, l)).visits.find((v) => v.id === id)!;
    expect(view.properties.map((p) => p.id)).toEqual([p1, p2]);
    expect(view.properties[0]).toMatchObject({ code: expect.stringMatching(/^P-/) });

    const r = await visits.setVisitProperties(a.exec1.ctx, id, {
      version: await visitVersion(id),
      propertyIds: [p2, p3],
    });
    expect(r.propertyIds).toEqual([p2, p3]);
    view = (await visits.myVisits(a.exec1.ctx)).open.find((v) => v.id === id)!;
    expect(view.properties.map((p) => p.id).sort()).toEqual([p2, p3].sort());
    expect(
      await migrator().auditLog.count({
        where: { entityId: id, action: 'site_visit.properties_changed' },
      }),
    ).toBe(1);

    // Closed visit: the list is the record and no longer changes.
    await visits.updateVisit(a.exec1.ctx, id, {
      action: 'cancel',
      version: String(await visitVersion(id)),
      reason: 'Synthetic: customer travelling',
    });
    expect(
      (
        await failure(
          visits.setVisitProperties(a.exec1.ctx, id, {
            version: await visitVersion(id),
            propertyIds: [p1],
          }),
        )
      ).code,
    ).toBe('RULE_VIOLATION');
  });

  it('refuses unknown or other-org properties, more than 10, stale versions and other people', async () => {
    const { a } = A;
    const l = await created(a.exec1);
    const mine = await property(a.owner);
    const other = await property(B.a.owner);
    const { id } = await visits.scheduleVisit(a.exec1.ctx, l, {
      scheduledFor: local(2 * 24 * 60),
      location: 'Synthetic site office',
    });
    const v = await visitVersion(id);
    expect(
      await failure(
        visits.setVisitProperties(a.exec1.ctx, id, { version: v, propertyIds: [other] }),
      ),
    ).toEqual({ code: 'VALIDATION_FAILED', fields: ['propertyIds'] });
    expect(
      (
        await failure(
          visits.setVisitProperties(a.exec1.ctx, id, {
            version: v,
            propertyIds: Array.from({ length: 11 }, () => mine),
          }),
        )
      ).code,
    ).toBe('VALIDATION_FAILED');
    expect(
      (
        await failure(
          visits.setVisitProperties(a.exec1.ctx, id, { version: v + 5, propertyIds: [mine] }),
        )
      ).code,
    ).toBe('CONFLICT');
    // Another executive and another organisation: not found.
    for (const who of [a.exec2, B.a.owner])
      expect(
        (await failure(visits.setVisitProperties(who.ctx, id, { version: v, propertyIds: [mine] })))
          .code,
      ).toBe('NOT_FOUND');
    // Scheduling with another org's property is refused and creates nothing.
    const before = await migrator().siteVisit.count({ where: { leadId: l } });
    expect(
      (
        await failure(
          visits.scheduleVisit(a.exec1.ctx, l, {
            scheduledFor: local(3 * 24 * 60),
            location: 'Elsewhere',
            propertyIds: [other],
          }),
        )
      ).code,
    ).toBe('VALIDATION_FAILED');
    expect(await migrator().siteVisit.count({ where: { leadId: l } })).toBe(before);
  });

  it('the database holds at most 10 per visit, and HR cannot touch the table', async () => {
    const { a, org } = A;
    const l = await created(a.exec1);
    const { id } = await visits.scheduleVisit(a.exec1.ctx, l, {
      scheduledFor: local(4 * 24 * 60),
      location: 'Synthetic limit lobby',
    });
    const ids: string[] = [];
    for (let i = 0; i < 11; i++) ids.push(await property(a.owner));
    for (const p of ids.slice(0, 10))
      await migrator()
        .$executeRaw`INSERT INTO site_visit_property (org_id, site_visit_id, property_id, added_by)
        VALUES (${org.orgId}::uuid, ${id}::uuid, ${p}::uuid, ${org.users.exec1.id}::uuid)`;
    expect(
      await sqlState(
        migrator()
          .$executeRaw`INSERT INTO site_visit_property (org_id, site_visit_id, property_id, added_by)
          VALUES (${org.orgId}::uuid, ${id}::uuid, ${ids[10]}::uuid, ${org.users.exec1.id}::uuid)`,
      ),
    ).toMatch(/23514|P2010/);
    const hrRows = await withRole(APP, async (c) => {
      await c.query('BEGIN');
      await c.query(
        `SELECT set_config('app.org_id', $1, true), set_config('app.user_id', $2, true)`,
        [org.orgId, org.users.hr.id],
      );
      const r = await c.query('SELECT count(*)::int AS n FROM site_visit_property');
      await c.query('ROLLBACK');
      return r.rows[0].n as number;
    });
    expect(hrRows).toBe(0);
  });
});

describe('contact details', () => {
  it('the owner of a lead edits name, alternate number, email and contact method', async () => {
    const { a } = A;
    const l = await created(a.exec1);
    const r = await leads.updateContactDetails(a.exec1.ctx, l, {
      version: await versionOf(l),
      fullName: 'Synthetic Renamed Lead',
      alternatePhone: '+971 50 123 4567',
      email: 'Renamed@Example.test',
      preferredContactMethod: 'WHATSAPP',
      preferredLanguage: 'ar',
    });
    expect(r.changed.sort()).toEqual(
      [
        'alternatePhoneE164',
        'email',
        'fullName',
        'preferredContactMethod',
        'preferredLanguage',
      ].sort(),
    );
    expect(await migrator().lead.findUniqueOrThrow({ where: { id: l } })).toMatchObject({
      fullName: 'Synthetic Renamed Lead',
      alternatePhoneE164: '+971501234567',
      preferredContactMethod: 'WHATSAPP',
    });
    const timeline = await leads.getTimeline(a.exec1.ctx, l);
    expect(timeline.find((t) => t.type === 'FIELD_CHANGED')?.summary).toMatchObject({
      fields: expect.arrayContaining(['fullName', 'email']),
    });
    // Nothing changed: no new version, no history entry.
    const v = await versionOf(l);
    expect(
      (
        await leads.updateContactDetails(a.exec1.ctx, l, {
          version: v,
          fullName: 'Synthetic Renamed Lead',
          alternatePhone: '+971501234567',
          email: 'Renamed@Example.test',
          preferredContactMethod: 'WHATSAPP',
          preferredLanguage: 'ar',
        })
      ).changed,
    ).toEqual([]);
    expect(await versionOf(l)).toBe(v);
  });

  it("refuses another lead's number, the main number, stale versions, other people and masking", async () => {
    const { a, org } = A;
    const l = await created(a.exec1);
    const otherPhone = phone();
    await created(a.exec2, { primaryPhone: otherPhone });
    const lead = await migrator().lead.findUniqueOrThrow({ where: { id: l } });
    const base = { version: lead.version, fullName: 'Synthetic Extras Lead' };
    expect(
      await failure(
        leads.updateContactDetails(a.exec1.ctx, l, { ...base, alternatePhone: otherPhone }),
      ),
    ).toEqual({ code: 'VALIDATION_FAILED', fields: ['alternatePhone'] });
    expect(
      await failure(
        leads.updateContactDetails(a.exec1.ctx, l, {
          ...base,
          alternatePhone: lead.primaryPhoneE164,
        }),
      ),
    ).toEqual({ code: 'VALIDATION_FAILED', fields: ['alternatePhone'] });
    expect(
      (
        await failure(
          leads.updateContactDetails(a.exec1.ctx, l, {
            ...base,
            version: base.version + 3,
            fullName: 'X',
          }),
        )
      ).code,
    ).toBe('CONFLICT');
    for (const who of [a.exec2, B.a.owner, a.hr])
      expect(
        (await failure(leads.updateContactDetails(who.ctx, l, { ...base, fullName: 'X' }))).code,
      ).toMatch(/NOT_FOUND|FORBIDDEN/);
    await migrator()
      .$executeRaw`UPDATE organization SET phone_masking = true WHERE id = ${org.orgId}::uuid`;
    try {
      expect(
        (
          await failure(
            leads.updateContactDetails(a.exec1.ctx, l, { ...base, alternatePhone: phone() }),
          )
        ).code,
      ).toBe('RULE_VIOLATION');
      // Without the alternate number the other fields still save.
      expect(
        (
          await leads.updateContactDetails(a.exec1.ctx, l, {
            ...base,
            fullName: 'Synthetic Masked',
          })
        ).changed,
      ).toEqual(['fullName']);
    } finally {
      await migrator()
        .$executeRaw`UPDATE organization SET phone_masking = false WHERE id = ${org.orgId}::uuid`;
    }
  });
});

describe('lead list: tag filter', () => {
  it('lists only leads with the tag, within the caller scope', async () => {
    const { a } = A;
    const tag = await leads.createLeadTag(a.owner.ctx, { name: `Synthetic tag ${seq}` });
    const tagged = await created(a.exec1);
    const untagged = await created(a.exec1);
    await leads.bulkAddTag(a.owner.ctx, { leadIds: [tagged], tagId: tag.id });
    const ids = async (who: Actor) =>
      (await leads.searchLeads(who.ctx, { tag: tag.id })).rows.map((r) => r.id);
    expect(await ids(a.exec1)).toEqual([tagged]);
    expect(await ids(a.exec1)).not.toContain(untagged);
    expect(await ids(a.exec2)).toEqual([]);
    // An executive cannot add tags (Owner/Admin only, as on the website).
    expect(
      (await failure(leads.bulkAddTag(a.exec1.ctx, { leadIds: [untagged], tagId: tag.id }))).code,
    ).toBe('FORBIDDEN');
  });
});

describe('dashboard: per-person table', () => {
  it('carries roles, leaves HR out, and a team filter narrows the people', async () => {
    const { a, org, west } = A;
    const all = await dashboard(a.owner.ctx, { period: 'this_month' });
    const byId = new Map(all.members!.map((m) => [m.userId, m]));
    expect(byId.get(org.users.exec1.id)?.role).toBe('SALES_EXECUTIVE');
    expect(byId.get(org.users.owner.id)?.role).toBe('OWNER');
    expect(byId.has(org.users.hr.id)).toBe(false);
    const team = await dashboard(a.owner.ctx, { period: 'this_month', team: west });
    expect(team.members!.map((m) => m.userId).sort()).toEqual(
      [org.users.exec1.id, org.users.manager.id].sort(),
    );
  });
});
