// FR-060 closeout (ADR-0013 decision 10, amended 2026-10-29): the Owner's lead export follows the
// org's phone masking setting. End to end below the UI (request → worker → private storage →
// single-use download) with the in-memory storage double: masked primary and alternate numbers
// while masking is on, full numbers while it is off, the setting read when the worker builds the
// file, no full number in the file, the download, the job rows, the job list, the outbox event or
// the audit rows, no bulk reveal, and the existing Owner-only, requester-only, tenant, filter,
// watermark and audit rules unchanged. Synthetic data only; crm_test only; no cloud storage.
import { beforeAll, describe, expect, it } from 'vitest';
import * as exportsModule from '@/modules/exports';
import { processExportJob } from '@/modules/exports/processor';
import * as leads from '@/modules/leads';
import { EXPORT_COLUMNS } from '@/modules/leads/export-format';
import * as orgs from '@/modules/organizations';
import { DomainError } from '@/platform/errors';
import { migrator } from '../support/db';
import { actorIn, seedOrg, type Actor } from '../support/factory';
import { memoryStorage } from '../support/memory-storage';

let A: Awaited<ReturnType<typeof seedOrg>>;
let B: Awaited<ReturnType<typeof seedOrg>>;
const a = {} as Record<'owner' | 'admin' | 'manager' | 'exec1', Actor>;
let ownerB: Actor;
const storage = memoryStorage();

let seq = 0;
const phone = (p: string) =>
  `${p}${String(30_000_000 + ++seq * 7_717 + (process.pid % 997)).slice(-8)}`;

async function codeOf(p: Promise<unknown>): Promise<string> {
  try {
    await p;
  } catch (e) {
    if (e instanceof DomainError) return e.code;
    throw e;
  }
  return 'OK';
}

/** A lead with both numbers; returns the stored E.164 values. */
async function lead(by: Actor, fullName: string, city: string) {
  const r = await leads.createLead(by.ctx, {
    fullName,
    primaryPhone: phone('93'),
    alternatePhone: phone('96'),
    preferredCity: city,
  });
  if (r.status !== 'created') throw new Error(`expected created, got ${JSON.stringify(r)}`);
  const l = await migrator().lead.findUniqueOrThrow({ where: { id: r.leadId } });
  return { id: r.leadId, primary: l.primaryPhoneE164, alternate: l.alternatePhoneE164! };
}
type Lead = Awaited<ReturnType<typeof lead>>;
let maskedLead: Lead;
let otherCityLead: Lead;
let otherOrgLead: Lead;

/** Every form of a full number that must not appear: E.164, 10 digits, the hidden six digits. */
const leaksOf = (...ls: Lead[]) =>
  ls.flatMap((l) => [l.primary, l.alternate]).flatMap((n) => [n, n.slice(3), n.slice(3, 9)]);
const leaked = (text: string, ls: Lead[]) => leaksOf(...ls).filter((n) => text.includes(n));

const setMasking = (owner: Actor, enabled: boolean) =>
  orgs.updatePhoneMasking(owner.ctx, { enabled, dailyCap: 50 });
const job = (id: string) => migrator().exportJob.findUniqueOrThrow({ where: { id } });
const build = (id: string, by: Actor) =>
  processExportJob(by.ctx.orgId, id, by.user.id, { storage });
const fileOf = async (id: string) =>
  Buffer.from(storage.objects.get((await job(id)).storageKey)!.body).toString('utf8');
const revealCount = (orgId: string) => migrator().leadPhoneReveal.count({ where: { orgId } });

beforeAll(async () => {
  A = await seedOrg('ExportMaskA');
  B = await seedOrg('ExportMaskB');
  for (const k of ['owner', 'admin', 'manager', 'exec1'] as const)
    a[k] = await actorIn(A.users[k], A.orgId);
  ownerB = await actorIn(B.users.owner, B.orgId);
  maskedLead = await lead(a.exec1, 'Synthetic Export Mask Pune', 'Pune');
  otherCityLead = await lead(a.exec1, 'Synthetic Export Mask Nagpur', 'Nagpur');
  otherOrgLead = await lead(ownerB, 'Synthetic Export Mask Other Org', 'Pune');
});

describe('masking on', () => {
  beforeAll(() => setMasking(a.owner, true));

  it('masks primary and alternate numbers in the generated file and the download', async () => {
    const reveals = await revealCount(A.orgId);
    const r = await exportsModule.requestLeadExport(a.owner.ctx, { city: 'Pune' });
    expect(await build(r.id, a.owner)).toBe('ready');
    const csv = await fileOf(r.id);
    const lines = csv.replace(/^﻿/, '').split('\r\n');
    // Watermark, header and filters as before.
    expect(lines[0]).toContain(`CONFIDENTIAL lead export for ${a.owner.ctx.orgName}`);
    expect(lines[0]).toContain(`requested by ${A.users.owner.name}`);
    expect(lines[1]!.split(',')).toEqual(EXPORT_COLUMNS.map((c) => c.header));
    const row = lines.find((l) => l.includes('Synthetic Export Mask Pune'))!.split(',');
    const col = (h: string) => row[EXPORT_COLUMNS.findIndex((c) => c.header === h)];
    // The established format; "+91 …" is a formula-like cell, so it keeps its apostrophe.
    expect(col('Phone')).toBe(`'${leads.maskPhone(maskedLead.primary)}`);
    expect(col('Alternate phone')).toBe(`'${leads.maskPhone(maskedLead.alternate)}`);
    expect(csv).not.toContain('Synthetic Export Mask Nagpur'); // filter unchanged
    expect(csv).not.toContain('Synthetic Export Mask Other Org'); // tenant unchanged
    expect(leaked(csv, [maskedLead, otherCityLead, otherOrgLead])).toEqual([]);
    expect((await job(r.id)).rowCount).toBe(1);

    const file = await exportsModule.downloadLeadExport(a.owner.ctx, r.id, { storage });
    const body = Buffer.from(file.body).toString('utf8');
    expect(body).toBe(csv);
    expect(leaked(body, [maskedLead])).toEqual([]);

    // No bulk reveal: an export records no reveal and uses none of the Owner's daily cap.
    expect(await revealCount(A.orgId)).toBe(reveals);
  });

  it('no full number in the job row, the job list, the outbox event or the audit rows', async () => {
    const r = await exportsModule.requestLeadExport(a.owner.ctx, { city: 'Pune' });
    await build(r.id, a.owner);
    await exportsModule.downloadLeadExport(a.owner.ctx, r.id, { storage });
    const audits = await migrator().auditLog.findMany({ where: { entityId: r.id } });
    expect(audits.map((x) => x.action).sort()).toEqual([
      'lead.export_downloaded',
      'lead.export_ready',
      'lead.export_requested',
    ]);
    // Audit contents unchanged: counts and filter names, never values.
    const ready = audits.find((x) => x.action === 'lead.export_ready')!;
    expect(ready.metadata).toEqual({
      ...leads.exportAuditMetadata(1),
      bytes: expect.any(Number),
    });
    const event = await migrator().outboxEvent.findFirstOrThrow({
      where: { orgId: A.orgId, payload: { path: ['exportJobId'], equals: r.id } },
    });
    const surfaces = JSON.stringify([
      await job(r.id),
      await exportsModule.listMyExports(a.owner.ctx),
      event.payload,
      audits,
    ]);
    expect(leaked(surfaces, [maskedLead, otherCityLead])).toEqual([]);
  });

  it('only the requesting Owner can request or download; other orgs cannot reach the file', async () => {
    for (const who of [a.admin, a.manager, a.exec1])
      expect(await codeOf(exportsModule.requestLeadExport(who.ctx, {}))).toBe('FORBIDDEN');
    const r = await exportsModule.requestLeadExport(a.owner.ctx, {});
    expect(await build(r.id, a.owner)).toBe('ready');
    expect(await codeOf(exportsModule.downloadLeadExport(a.admin.ctx, r.id, { storage }))).toBe(
      'FORBIDDEN',
    );
    expect(await codeOf(exportsModule.downloadLeadExport(ownerB.ctx, r.id, { storage }))).toBe(
      'NOT_FOUND',
    );
    expect(await codeOf(exportsModule.listMyExports(a.exec1.ctx))).toBe('FORBIDDEN');
    expect((await exportsModule.listMyExports(ownerB.ctx)).map((x) => x.id)).not.toContain(r.id);
    expect((await job(r.id)).status).toBe('READY'); // refused attempts did not use the download
  });
});

describe('masking off', () => {
  it("another org's export with masking off keeps the full numbers, as before", async () => {
    expect((await orgs.getPhoneMaskingSettings(ownerB.ctx)).enabled).toBe(false);
    const r = await exportsModule.requestLeadExport(ownerB.ctx, {});
    expect(await build(r.id, ownerB)).toBe('ready');
    const csv = await fileOf(r.id);
    expect(csv).toContain(`'${otherOrgLead.primary}`);
    expect(csv).toContain(`'${otherOrgLead.alternate}`);
    expect(csv).not.toContain('••••');
    expect(csv).not.toContain('Synthetic Export Mask Pune'); // A's leads never in B's file
  });
});

describe('when the setting is read', () => {
  it('the setting in force when the worker builds the file applies, not at request time', async () => {
    await setMasking(a.owner, false);
    const offAtRequest = await exportsModule.requestLeadExport(a.owner.ctx, { city: 'Nagpur' });
    await setMasking(a.owner, true);
    await build(offAtRequest.id, a.owner);
    const masked = await fileOf(offAtRequest.id);
    expect(masked).toContain(leads.maskPhone(otherCityLead.primary));
    expect(leaked(masked, [otherCityLead])).toEqual([]);

    const onAtRequest = await exportsModule.requestLeadExport(a.owner.ctx, { city: 'Nagpur' });
    await setMasking(a.owner, false);
    await build(onAtRequest.id, a.owner);
    const full = await fileOf(onAtRequest.id);
    expect(full).toContain(`'${otherCityLead.primary}`);
    expect(full).toContain(`'${otherCityLead.alternate}`);
  });
});
