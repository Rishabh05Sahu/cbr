// Lead-source management (Owner/Admin, org.settings.manage) and how imports resolve source names:
// normalized names, duplicates by case and spacing, authorization, tenant isolation, and an
// import whose Source column names an existing source with different case/spacing and an
// unknown one. Synthetic data only; crm_test only.
import { beforeAll, describe, expect, it } from 'vitest';
import * as imports from '@/modules/imports';
import { processImportJob } from '@/modules/imports/processor';
import * as leads from '@/modules/leads';
import { DomainError } from '@/platform/errors';
import { migrator } from '../support/db';
import { actorIn, seedOrg, type Actor } from '../support/factory';
import { memoryStorage, type MemoryStorage } from '../support/memory-storage';

let A: Awaited<ReturnType<typeof seedOrg>>;
let B: Awaited<ReturnType<typeof seedOrg>>;
const a = {} as Record<'owner' | 'admin' | 'manager' | 'exec1', Actor>;
let ownerB: Actor;
let storage: MemoryStorage;

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
const source = (id: string) => migrator().leadSource.findUniqueOrThrow({ where: { id } });

let seq = 0;
const phone = () => `98${String(70_000_000 + ++seq * 4_111 + (process.pid % 1000)).slice(-8)}`;

beforeAll(async () => {
  storage = memoryStorage();
  A = await seedOrg('SourcesA');
  B = await seedOrg('SourcesB');
  for (const k of ['owner', 'admin', 'manager', 'exec1'] as const)
    a[k] = await actorIn(A.users[k], A.orgId);
  ownerB = await actorIn(B.users.owner, B.orgId);
});

describe('managing lead sources', () => {
  it('Owner and Admin add sources; the name is stored normalized; audit is written', async () => {
    const { id } = await leads.createLeadSource(a.owner.ctx, {
      name: '  99   Acres ',
      channel: 'PORTAL',
    });
    expect(await source(id)).toMatchObject({
      orgId: A.orgId,
      name: '99 Acres',
      channel: 'PORTAL',
      isActive: true,
    });
    expect(
      await migrator().auditLog.count({ where: { action: 'lead_source.created', entityId: id } }),
    ).toBe(1);
    const byAdmin = await leads.createLeadSource(a.admin.ctx, {
      name: 'MagicBricks',
      channel: 'PORTAL',
    });
    // Listed for settings (Owner/Admin) and offered on the lead form to every member.
    expect((await leads.listLeadSourcesForSettings(a.admin.ctx)).map((s) => s.name)).toEqual(
      expect.arrayContaining(['99 Acres', 'MagicBricks']),
    );
    expect((await leads.listLeadSources(a.exec1.ctx)).map((s) => s.id)).toEqual(
      expect.arrayContaining([id, byAdmin.id]),
    );
  });

  it('refuses a duplicate that differs only by case or spacing, also against older unnormalized rows', async () => {
    for (const name of ['99 acres', '99 ACRES', ' 99  acres', '99\tAcres'])
      expect(await codeOf(leads.createLeadSource(a.owner.ctx, { name, channel: 'OTHER' }))).toBe(
        'CONFLICT',
      );
    // A row written before normalization existed (only the case-insensitive index protects it).
    await migrator().leadSource.create({
      data: { orgId: A.orgId, name: 'Housing  Portal', channel: 'PORTAL' },
    });
    expect(
      await codeOf(
        leads.createLeadSource(a.owner.ctx, { name: 'housing portal', channel: 'PORTAL' }),
      ),
    ).toBe('CONFLICT');
    const err = await leads
      .createLeadSource(a.owner.ctx, { name: 'MAGICBRICKS', channel: 'PORTAL' })
      .catch((e: unknown) => e);
    expect(err).toBeInstanceOf(DomainError);
    expect((err as DomainError).message).toMatch(/"MagicBricks" already exists/);
  });

  it('validates the name and channel', async () => {
    for (const input of [
      { name: '   ', channel: 'PORTAL' },
      { name: 'x'.repeat(101), channel: 'PORTAL' },
      { name: 'Valid Name', channel: 'BILLBOARD' },
      { name: 'Valid Name' },
    ])
      expect(await codeOf(leads.createLeadSource(a.owner.ctx, input))).toBe('VALIDATION_FAILED');
  });

  it('managers and executives cannot add or list them for management', async () => {
    for (const who of [a.manager, a.exec1]) {
      expect(
        await codeOf(
          leads.createLeadSource(who.ctx, { name: `Nope ${who.ctx.userId}`, channel: 'OTHER' }),
        ),
      ).toBe('FORBIDDEN');
      expect(await codeOf(leads.listLeadSourcesForSettings(who.ctx))).toBe('FORBIDDEN');
    }
  });

  it('is per organisation: another org neither sees nor collides with these names', async () => {
    expect((await leads.listLeadSourcesForSettings(ownerB.ctx)).map((s) => s.name)).not.toContain(
      '99 Acres',
    );
    const { id } = await leads.createLeadSource(ownerB.ctx, {
      name: '99 Acres',
      channel: 'PORTAL',
    });
    expect((await source(id)).orgId).toBe(B.orgId);
    expect((await leads.listLeadSourcesForSettings(a.owner.ctx)).map((s) => s.id)).not.toContain(
      id,
    );
    // The org id cannot be smuggled in: the source belongs to the caller's org.
    const smuggled = await leads.createLeadSource(ownerB.ctx, {
      name: 'Smuggled',
      channel: 'OTHER',
      orgId: A.orgId,
    });
    expect((await source(smuggled.id)).orgId).toBe(B.orgId);
  });
});

describe('imports resolve source names', () => {
  it('matches case/spacing variants of an existing source; reports an unknown name clearly', async () => {
    const known = (await leads.listLeadSourcesForSettings(a.owner.ctx)).find(
      (s) => s.name === '99 Acres',
    )!;
    const [p1, p2, p3] = [phone(), phone(), phone()];
    const csv = Buffer.from(
      `Name,Phone,Source\nSynthetic One,${p1},  99  ACRES \nSynthetic Two,${p2},Not A Source\nSynthetic Three,${p3},\n`,
    );
    const s = await imports.startImport(
      a.owner.ctx,
      { fileName: 'sources.csv', size: csv.byteLength, type: 'text/csv' },
      storage,
    );
    storage.browserPut(s.upload.url, csv, s.upload.headers['content-type']!);
    await imports.confirmUpload(a.owner.ctx, s.importId, storage);
    const step = () => processImportJob(A.orgId, s.importId, { storage });
    expect(await step()).toBe('needs_mapping');
    let j = await migrator().importJob.findUniqueOrThrow({ where: { id: s.importId } });
    expect(j.mapping).toMatchObject({ source: 2 });
    await imports.submitMapping(a.owner.ctx, s.importId, {
      mapping: j.mapping,
      duplicatePolicy: 'SKIP',
      assignment: { mode: 'none' },
      dryRun: false,
      version: j.version,
    });
    expect(await step()).toBe('ready');
    j = await migrator().importJob.findUniqueOrThrow({ where: { id: s.importId } });
    expect({ valid: j.rowsValid, invalid: j.rowsInvalid }).toEqual({ valid: 2, invalid: 1 });
    const issues = (await imports.listImportIssues(a.owner.ctx, s.importId, { limit: 100 })).issues;
    expect(issues.map((i) => `${i.row}|${i.field}|${i.code}`)).toEqual(['3|source|SOURCE_UNKNOWN']);

    await imports.confirmImport(a.owner.ctx, s.importId, { attest: true, version: j.version });
    expect(await step()).toBe('completed');
    const created = await migrator().lead.findMany({
      where: { orgId: A.orgId, primaryPhoneE164: { in: [`+91${p1}`, `+91${p3}`] } },
      select: { primaryPhoneE164: true, sourceId: true },
    });
    const bySource = Object.fromEntries(created.map((l) => [l.primaryPhoneE164, l.sourceId]));
    expect(bySource[`+91${p1}`]).toBe(known.id); // "  99  ACRES " → "99 Acres"
    expect(bySource[`+91${p3}`]).toBe(j.defaultSourceId); // blank → the job's default source
    expect(
      await migrator().lead.count({ where: { orgId: A.orgId, primaryPhoneE164: `+91${p2}` } }),
    ).toBe(0);
  });
});
