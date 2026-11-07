// Phase 3 slice 7 (migration 0016): FR-060 phone masking and reveal auditing. The Owner-only org
// setting, masked numbers in every query that feeds a page, the audited and capped reveal (app
// and database), roles, scope, other orgs, append-only records, and that revealing changes
// nothing about contact status or outbound eligibility. Synthetic data only.
import { beforeAll, describe, expect, it } from 'vitest';
import * as leads from '@/modules/leads';
import * as orgs from '@/modules/organizations';
import { tenantRunner } from '@/platform/db';
import { DomainError } from '@/platform/errors';
import { migrator, withRole } from '../support/db';
import { actorIn, seedOrg, type Actor } from '../support/factory';

const APP = process.env.TEST_DATABASE_URL!;
type Org = Awaited<ReturnType<typeof seedOrg>>;
type Role = 'owner' | 'admin' | 'manager' | 'exec1' | 'exec2' | 'hr';
let A: Org;
let B: Org;
const a = {} as Record<Role, Actor>;
let ownerB: Actor;

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
const digits = () => String(60_000_000 + ++seq * 7_919).slice(-8);
async function created(by: Actor, input: Record<string, string> = {}) {
  const r = await leads.createLead(by.ctx, {
    fullName: 'Synthetic Masked',
    primaryPhone: `95${digits()}`,
    ...input,
  });
  if (r.status !== 'created') throw new Error('expected a new lead');
  return r.leadId;
}
const row = (id: string) => migrator().lead.findUniqueOrThrow({ where: { id } });
const setMasking = (enabled: boolean, dailyCap = 50, by: Actor = a.owner) =>
  orgs.updatePhoneMasking(by.ctx, { enabled, dailyCap });
const reveals = (leadId: string) =>
  migrator().leadPhoneReveal.findMany({ where: { leadId }, orderBy: { revealedAt: 'asc' } });
const revealAudits = (leadId: string) =>
  migrator().auditLog.findMany({ where: { action: 'lead.phone_revealed', entityId: leadId } });

beforeAll(async () => {
  A = await seedOrg('MaskA');
  B = await seedOrg('MaskB');
  for (const k of ['owner', 'admin', 'manager', 'exec1', 'exec2', 'hr'] as const)
    a[k] = await actorIn(A.users[k], A.orgId);
  ownerB = await actorIn(B.users.owner, B.orgId);
});

describe('org setting (Owner only)', () => {
  it('is off by default: numbers are shown and there is nothing to reveal', async () => {
    const id = await created(a.exec1);
    const full = (await row(id)).primaryPhoneE164;
    expect((await leads.getLead(a.exec1.ctx, id)).primaryPhoneE164).toBe(full);
    expect(await orgs.getPhoneMaskingSettings(a.owner.ctx)).toMatchObject({
      enabled: false,
      dailyCap: 50,
      canManage: true,
    });
    expect(await codeOf(leads.revealLeadPhone(a.exec1.ctx, id))).toBe('RULE_VIOLATION');
    expect(await reveals(id)).toHaveLength(0);
  });

  it('only Owner and Admin see the status and the reveal limit; the other roles see neither', async () => {
    expect(await orgs.getPhoneMaskingSettings(a.admin.ctx)).toMatchObject({
      dailyCap: 50,
      canManage: false,
    });
    for (const k of ['manager', 'exec1', 'hr'] as const) {
      expect(await codeOf(orgs.getPhoneMaskingSettings(a[k].ctx)), k).toBe('FORBIDDEN');
      // The organisation's name, time zone and locale stay readable, without masking fields.
      const org = await orgs.getOrgSettings(a[k].ctx);
      expect(org, k).toMatchObject({ name: A.name, timeZone: 'Asia/Kolkata', locale: 'en-IN' });
      expect(Object.keys(org), k).not.toContain('phoneMasking');
      expect(Object.keys(org), k).not.toContain('phoneRevealDailyCap');
      // No organisation setting can be changed.
      expect(
        await codeOf(
          orgs.updateOrgSettings(a[k].ctx, { name: 'Renamed', timeZone: 'UTC', locale: 'en-IN' }),
        ),
        k,
      ).toBe('FORBIDDEN');
      expect(await codeOf(setMasking(true, 10, a[k])), k).toBe('FORBIDDEN');
    }
  });

  it('only the Owner changes it (app and database), and the change is audited', async () => {
    expect(await codeOf(setMasking(true, 50, a.admin))).toBe('FORBIDDEN');
    expect(await codeOf(setMasking(true, 0))).toBe('VALIDATION_FAILED');
    expect(
      await sqlState(
        asApp(A, A.users.admin.id, `UPDATE organization SET phone_masking = true WHERE id = $1`, [
          A.orgId,
        ]),
      ),
    ).toBe('42501');
    await setMasking(true, 50);
    expect((await orgs.getPhoneMaskingSettings(a.owner.ctx)).enabled).toBe(true);
    const audit = await migrator().auditLog.findFirstOrThrow({
      where: { orgId: A.orgId, action: 'organization.phone_masking_updated' },
      orderBy: { occurredAt: 'desc' },
    });
    expect(audit.metadata).toMatchObject({ enabled: true, dailyCap: 50, previousEnabled: false });
  });
});

describe('masked everywhere a page reads numbers', () => {
  beforeAll(() => setMasking(true, 50));

  it('masks the list, the detail view and the merge preview; stored numbers are unchanged', async () => {
    const alt = `94${digits()}`;
    const id = await created(a.admin, { fullName: 'Synthetic Mask Pair', alternatePhone: alt });
    const dup = await created(a.admin, {
      fullName: 'Synthetic Mask Pair',
      alternatePhone: `93${digits()}`,
    });
    const stored = await row(id);
    const full = [stored.primaryPhoneE164, stored.alternatePhoneE164!];
    const view = await leads.getLead(a.admin.ctx, id);
    expect(view.phoneMasked).toBe(true);
    expect(view.primaryPhoneE164).toBe(leads.maskPhone(full[0]!));
    expect(view.alternatePhoneE164).toBe(leads.maskPhone(full[1]!));
    const list = await leads.searchLeads(a.admin.ctx, { q: 'Synthetic Mask Pair' });
    const preview = await leads.previewMerge(a.admin.ctx, { survivorId: id, mergedId: dup });
    expect(preview.conflicts.find((c) => c.field === 'alternatePhoneE164')).toBeTruthy();
    // No full number anywhere in what these queries return.
    for (const out of [view, list, preview])
      for (const n of full) {
        expect(JSON.stringify(out)).not.toContain(n);
        expect(JSON.stringify(out)).not.toContain(n.slice(3)); // without the country code
      }
    expect(list.rows.every((r) => r.primaryPhoneE164.includes('••••••'))).toBe(true);
    expect(await row(id)).toMatchObject({
      primaryPhoneE164: full[0],
      alternatePhoneE164: full[1],
      phoneLast10: full[0]!.slice(-10),
    });
  });

  it('still searches and finds duplicates by the full number', async () => {
    const p = `92${digits()}`;
    const id = await created(a.exec1, { primaryPhone: p });
    const found = await leads.searchLeads(a.exec1.ctx, { q: p });
    expect(found.rows.map((r) => r.id)).toContain(id);
    const again = await leads.createLead(a.exec2.ctx, { fullName: 'Same number', primaryPhone: p });
    expect(again.status).toBe('duplicate');
  });

  it("masks the Owner's export rows; merges still work on the stored numbers", async () => {
    const id = await created(a.admin, { fullName: 'Synthetic Mask Export' });
    const full = (await row(id)).primaryPhoneE164;
    const rows = await tenantRunner().withTenant(a.owner.ctx.tenant, (tx) =>
      leads.loadExportRows(tx, a.owner.ctx, { q: 'Synthetic Mask Export' }),
    );
    expect(rows.map((r) => r.primaryPhoneE164)).toContain(leads.maskPhone(full));
    expect(JSON.stringify(rows)).not.toContain(full.slice(3)); // export-masking.test.ts: the file
    const s = await created(a.admin, { fullName: 'Synthetic Mask Merge' });
    const m = await created(a.admin, { fullName: 'Synthetic Mask Merge' });
    const preview = await leads.previewMerge(a.admin.ctx, { survivorId: s, mergedId: m });
    await leads.mergeLeads(a.admin.ctx, {
      survivorId: s,
      mergedId: m,
      survivorVersion: preview.survivorVersion,
      mergedVersion: preview.mergedVersion,
    });
    expect((await row(s)).alternatePhoneE164).toBe((await row(m)).primaryPhoneE164);
  });
});

describe('reveal', () => {
  beforeAll(() => setMasking(true, 50));

  it('returns the full numbers to an authorised person and records every reveal', async () => {
    const alt = `91${digits()}`;
    const id = await created(a.exec1, { alternatePhone: alt });
    const stored = await row(id);
    const r = await leads.revealLeadPhone(a.exec1.ctx, id);
    expect(r).toMatchObject({
      primaryPhoneE164: stored.primaryPhoneE164,
      alternatePhoneE164: stored.alternatePhoneE164,
      contactStatus: 'OK',
    });
    await leads.revealLeadPhone(a.exec1.ctx, id); // repeated reveals are recorded separately
    const recs = await reveals(id);
    expect(recs).toHaveLength(2);
    expect(recs.every((x) => x.revealedBy === A.users.exec1.id)).toBe(true);
    const audits = await revealAudits(id);
    expect(audits).toHaveLength(2);
    expect(audits[0]).toMatchObject({ actorUserId: A.users.exec1.id, actorKind: 'USER' });
    expect(audits.map((x) => (x.metadata as { revealId: string }).revealId).sort()).toEqual(
      recs.map((x) => x.id).sort(),
    );
    for (const x of audits) {
      expect(Object.keys(x.metadata as object)).toEqual(['revealId']); // never the number
      expect(JSON.stringify(x.metadata)).not.toContain(stored.primaryPhoneE164.slice(-10));
    }
    // The lead itself is untouched.
    expect(await row(id)).toMatchObject({ version: stored.version, contactStatus: 'OK' });
  });

  it('follows the role matrix and scope, and other orgs see nothing', async () => {
    const id = await created(a.exec1);
    expect(await codeOf(leads.revealLeadPhone(a.exec2.ctx, id))).toBe('NOT_FOUND'); // not theirs
    expect(await codeOf(leads.revealLeadPhone(a.hr.ctx, id))).toBe('FORBIDDEN');
    expect(await codeOf(leads.revealLeadPhone(ownerB.ctx, id))).toBe('NOT_FOUND');
    expect(await codeOf(leads.revealLeadPhone(a.exec1.ctx, 'not-a-uuid'))).toBe('NOT_FOUND');
    expect(await codeOf(leads.revealLeadPhone(a.admin.ctx, id))).toBe('OK');
    expect(
      (await leads.getLead(a.exec2.ctx, id).catch(() => null))?.canRevealPhone,
    ).toBeUndefined();
    expect((await leads.getLead(a.exec1.ctx, id)).canRevealPhone).toBe(true);
    expect(await reveals(id)).toHaveLength(1); // refusals record nothing and return no number
  });

  it('enforces the daily cap per person, in the app and in the database', async () => {
    await setMasking(true, 2);
    try {
      const id = await created(a.manager);
      expect(await codeOf(leads.revealLeadPhone(a.manager.ctx, id))).toBe('OK');
      const second = await leads.revealLeadPhone(a.manager.ctx, id);
      expect(second.remainingToday).toBe(0);
      expect(await codeOf(leads.revealLeadPhone(a.manager.ctx, id))).toBe('RULE_VIOLATION');
      // A direct insert past the cap is refused too, and another person has their own count.
      expect(
        await sqlState(
          asApp(
            A,
            A.users.manager.id,
            `INSERT INTO lead_phone_reveal (org_id, lead_id, revealed_by) VALUES ($1, $2, $3)`,
            [A.orgId, id, A.users.manager.id],
          ),
        ),
      ).toBe('23514');
      expect(await codeOf(leads.revealLeadPhone(a.admin.ctx, id))).toBe('OK');
      expect((await reveals(id)).filter((x) => x.revealedBy === A.users.manager.id)).toHaveLength(
        2,
      );
    } finally {
      await setMasking(true, 50);
    }
  });

  it('serialises parallel reveals against the cap', async () => {
    await setMasking(true, 3);
    try {
      const id = await created(a.exec2);
      const results = await Promise.all(
        Array.from({ length: 6 }, () => codeOf(leads.revealLeadPhone(a.exec2.ctx, id))),
      );
      expect(results.filter((r) => r === 'OK')).toHaveLength(3);
      expect(results.filter((r) => r === 'RULE_VIOLATION')).toHaveLength(3);
      expect(await reveals(id)).toHaveLength(3);
    } finally {
      await setMasking(true, 50);
    }
  });
});

describe('database enforcement (crm_app)', () => {
  beforeAll(() => setMasking(true, 50));

  it('stamps the session user and time, and refuses non-lead roles and other orgs', async () => {
    const id = await created(a.admin);
    const ins = (org: Org, user: string, by: string, extra = '') =>
      asApp(
        org,
        user,
        `INSERT INTO lead_phone_reveal (org_id, lead_id, revealed_by${extra ? ', revealed_at' : ''})
         VALUES ($1, $2, $3${extra})`,
        [A.orgId, id, by],
      );
    expect(await sqlState(ins(A, A.users.hr.id, A.users.hr.id))).toBe('42501');
    expect(await sqlState(ins(A, A.users.exec1.id, A.users.admin.id))).toBe('42501'); // forged actor
    expect(
      await sqlState(ins(A, A.users.admin.id, A.users.admin.id, `, now() - interval '2 days'`)),
    ).toBe('42501'); // back-dated to dodge the cap
    expect(await sqlState(ins(B, B.users.owner.id, B.users.owner.id))).not.toBe('OK');
    expect(await reveals(id)).toHaveLength(0);
  });

  it('keeps reveals append-only and readable only by Owner/Admin or the person', async () => {
    const id = await created(a.exec1);
    await leads.revealLeadPhone(a.exec1.ctx, id);
    const [r] = await reveals(id);
    for (const sql of [
      `UPDATE lead_phone_reveal SET revealed_at = now() - interval '2 days' WHERE id = $1`,
      `DELETE FROM lead_phone_reveal WHERE id = $1`,
    ])
      expect(await sqlState(asApp(A, A.users.owner.id, sql, [r!.id]))).toBe('42501');
    const count = async (org: Org, user: string) =>
      (
        await asApp(org, user, `SELECT count(*)::int AS n FROM lead_phone_reveal WHERE id = $1`, [
          r!.id,
        ])
      ).rows[0].n;
    expect(await count(A, A.users.admin.id)).toBe(1);
    expect(await count(A, A.users.exec1.id)).toBe(1);
    expect(await count(A, A.users.exec2.id)).toBe(0);
    expect(await count(A, A.users.hr.id)).toBe(0);
    expect(await count(B, B.users.owner.id)).toBe(0);
    expect(await reveals(id)).toEqual([r]);
  });

  it('refuses a reveal record while masking is off', async () => {
    const id = await created(a.admin);
    await setMasking(false);
    try {
      expect(
        await sqlState(
          asApp(
            A,
            A.users.admin.id,
            `INSERT INTO lead_phone_reveal (org_id, lead_id, revealed_by) VALUES ($1, $2, $3)`,
            [A.orgId, id, A.users.admin.id],
          ),
        ),
      ).toBe('23514');
    } finally {
      await setMasking(true, 50);
    }
  });
});

describe('contact status is unaffected', () => {
  beforeAll(() => setMasking(true, 50));
  const check = (id: string, channel: leads.OutboundChannel, confirmed = false) =>
    codeOf(
      tenantRunner().withTenant(a.admin.ctx.tenant, (tx) =>
        leads.assertOutboundAllowed(tx, id, channel, { confirmed }),
      ),
    );

  it('revealing a do-not-contact or invalid lead changes nothing and permits nothing', async () => {
    const stop = await created(a.admin);
    const bad = await created(a.admin);
    await leads.changeContactStatus(a.admin.ctx, stop, {
      toStatus: 'DO_NOT_CONTACT',
      version: (await row(stop)).version,
      method: 'VERBAL',
      reason: 'Asked',
    });
    await leads.changeContactStatus(a.admin.ctx, bad, {
      toStatus: 'INVALID',
      version: (await row(bad)).version,
      reason: 'Wrong',
    });
    const before = [await row(stop), await row(bad)];
    expect((await leads.revealLeadPhone(a.admin.ctx, stop)).contactStatus).toBe('DO_NOT_CONTACT');
    expect((await leads.revealLeadPhone(a.admin.ctx, bad)).contactStatus).toBe('INVALID');
    expect([await row(stop), await row(bad)]).toEqual(before);
    for (const ch of leads.OUTBOUND_CHANNELS)
      expect(await check(stop, ch, true)).toBe('RULE_VIOLATION');
    expect(await check(bad, 'INTEGRATION_MESSAGE', true)).toBe('RULE_VIOLATION');
    expect(await check(bad, 'MANUAL_CALL')).toBe('RULE_VIOLATION');
    expect(
      await migrator().leadContactStatusEvent.count({ where: { leadId: { in: [stop, bad] } } }),
    ).toBe(2);
  });
});
