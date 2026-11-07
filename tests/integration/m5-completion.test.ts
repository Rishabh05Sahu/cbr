// Phase 2 M5 completion on crm_test: archive view, bulk archive (FR-063), automatic duplicate
// detection through real workflows, custom fields in imports (CSV and XLSX, dry run, commit-time
// re-check, direct API), and export-worker recovery with fencing. Synthetic data only.
import { randomUUID } from 'node:crypto';
import { beforeAll, describe, expect, it } from 'vitest';
import * as exportsModule from '@/modules/exports';
import { processExportJob } from '@/modules/exports/processor';
import * as imports from '@/modules/imports';
import { processImportJob } from '@/modules/imports/processor';
import * as leads from '@/modules/leads';
import { DomainError } from '@/platform/errors';
import { migrator } from '../support/db';
import { actorIn, seedOrg, type Actor } from '../support/factory';
import { memoryStorage } from '../support/memory-storage';
import { xlsx } from '../support/spreadsheets';

type Org = Awaited<ReturnType<typeof seedOrg>>;
let A: Org;
let B: Org;
const a = {} as Record<'owner' | 'admin' | 'manager' | 'exec1', Actor>;
let ownerB: Actor;
const storage = memoryStorage();

let seq = 0;
const phone = () => `88${String(80_000_000 + ++seq * 6_047 + (process.pid % 1000)).slice(-8)}`;

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

async function newLead(by: Actor, input: Record<string, unknown> = {}): Promise<string> {
  const r = await leads.createLead(by.ctx, {
    fullName: 'Synthetic Customer',
    primaryPhone: phone(),
    ...input,
  });
  if (r.status !== 'created') throw new Error(`expected created, got ${JSON.stringify(r)}`);
  return r.leadId;
}
const row = (id: string) => migrator().lead.findUniqueOrThrow({ where: { id } });
const item = async (id: string) => ({ id, version: (await row(id)).version });

beforeAll(async () => {
  A = await seedOrg('M5A');
  B = await seedOrg('M5B');
  for (const k of ['owner', 'admin', 'manager', 'exec1'] as const)
    a[k] = await actorIn(A.users[k], A.orgId);
  ownerB = await actorIn(B.users.owner, B.orgId);
});

// -------------------------------------------------------------------------------------------------
describe('archive view in the lead list', () => {
  it('archived leads are hidden by default, listed on request; merged leads never list', async () => {
    const live = await newLead(a.exec1, { fullName: 'Synthetic Live View' });
    const arch = await newLead(a.exec1, { fullName: 'Synthetic Archived View' });
    await leads.archiveLead(a.owner.ctx, arch, { version: (await row(arch)).version });
    const names = async (archived?: string) =>
      (
        await leads.searchLeads(a.owner.ctx, { q: 'Synthetic', ...(archived ? { archived } : {}) })
      ).rows.map((r) => r.fullName);
    expect(await names()).toContain('Synthetic Live View');
    expect(await names()).not.toContain('Synthetic Archived View');
    expect(await names('archived')).toEqual(expect.arrayContaining(['Synthetic Archived View']));
    expect(await names('archived')).not.toContain('Synthetic Live View');
    expect(await names('all')).toEqual(
      expect.arrayContaining(['Synthetic Live View', 'Synthetic Archived View']),
    );
    expect(live).toBeDefined();
  });
});

// -------------------------------------------------------------------------------------------------
describe('bulk archive (FR-063)', () => {
  it('Owner/Admin archive a selection atomically with one audit entry listing the ids', async () => {
    const ids = [await newLead(a.exec1), await newLead(a.exec1), await newLead(a.exec1)];
    const r = await leads.bulkArchiveLeads(a.admin.ctx, {
      items: await Promise.all(ids.map(item)),
      reason: 'Synthetic: campaign closed',
    });
    expect(r).toEqual({ archived: 3 });
    for (const id of ids) expect((await row(id)).archivedAt).not.toBeNull();
    expect(
      await migrator().leadActivity.count({ where: { leadId: { in: ids }, type: 'ARCHIVED' } }),
    ).toBe(3);
    const audit = await migrator().auditLog.findFirstOrThrow({
      where: { orgId: A.orgId, action: 'lead.bulk_archived', actorUserId: A.users.admin.id },
      orderBy: { occurredAt: 'desc' },
    });
    expect(audit.metadata).toMatchObject({ count: 3, leadIds: [...ids].sort().join(',') });
    expect(JSON.stringify(audit.metadata)).not.toContain('Synthetic'); // ids and counts only
  });

  it('Sales Managers and Executives cannot bulk archive', async () => {
    const id = await newLead(a.exec1);
    for (const who of [a.manager, a.exec1])
      expect(await codeOf(leads.bulkArchiveLeads(who.ctx, { items: [await item(id)] }))).toBe(
        'FORBIDDEN',
      );
  });

  it('a stale or ineligible lead refuses the whole selection (nothing archived)', async () => {
    const [x, y] = [await newLead(a.exec1), await newLead(a.exec1)];
    const stale = await failure(
      leads.bulkArchiveLeads(a.owner.ctx, { items: [await item(x), { id: y, version: 99 }] }),
    );
    expect(stale).toEqual({ code: 'CONFLICT', fields: ['leadIds'] });
    await leads.archiveLead(a.owner.ctx, y, { version: (await row(y)).version });
    expect(
      await codeOf(leads.bulkArchiveLeads(a.owner.ctx, { items: [await item(x), await item(y)] })),
    ).toBe('RULE_VIOLATION');
    expect((await row(x)).archivedAt).toBeNull();
  });

  it('other orgs’ leads, empty and oversized selections are refused', async () => {
    const theirs = await newLead(ownerB);
    expect(
      await codeOf(
        leads.bulkArchiveLeads(a.owner.ctx, {
          items: [await item(await newLead(a.exec1)), await item(theirs)],
        }),
      ),
    ).toBe('NOT_FOUND');
    expect((await row(theirs)).archivedAt).toBeNull();
    expect(await codeOf(leads.bulkArchiveLeads(a.owner.ctx, { items: [] }))).toBe(
      'VALIDATION_FAILED',
    );
    const many = Array.from({ length: leads.BULK_ARCHIVE_MAX + 1 }, () => ({
      id: randomUUID(),
      version: 1,
    }));
    expect(await codeOf(leads.bulkArchiveLeads(a.owner.ctx, { items: many }))).toBe(
      'VALIDATION_FAILED',
    );
  });

  it('two overlapping bulk archives at once: one wins, the other archives nothing', async () => {
    const ids = [await newLead(a.exec1), await newLead(a.exec1)];
    const items = await Promise.all(ids.map(item));
    const results = await Promise.all([
      codeOf(leads.bulkArchiveLeads(a.owner.ctx, { items })),
      codeOf(leads.bulkArchiveLeads(a.admin.ctx, { items })),
    ]);
    expect(results.filter((r) => r === 'OK')).toHaveLength(1);
    expect(results.filter((r) => r !== 'OK')[0]).toMatch(/^(CONFLICT|RULE_VIOLATION)$/);
    expect(
      await migrator().leadActivity.count({ where: { leadId: { in: ids }, type: 'ARCHIVED' } }),
    ).toBe(2);
  });
});

// -------------------------------------------------------------------------------------------------
describe('automatic duplicate detection (exact email)', () => {
  const cases = (leadId: string) =>
    migrator().leadDuplicateMatch.findMany({
      where: { OR: [{ leadId }, { candidateLeadId: leadId }], matchType: 'EMAIL' },
    });

  it('manual create with an existing lead’s email (any case) opens one EMAIL case, revealing nothing', async () => {
    const first = await newLead(a.exec1, { email: 'synthetic.dup1@example.test' });
    const r = await leads.createLead(a.manager.ctx, {
      fullName: 'Synthetic Other',
      primaryPhone: phone(),
      email: 'Synthetic.DUP1@example.test',
    });
    expect(r.status).toBe('created');
    expect(JSON.stringify(r)).not.toContain(first);
    const c = await cases(first);
    expect(c).toHaveLength(1);
    expect(c[0]).toMatchObject({
      candidateLeadId: first,
      status: 'OPEN',
      detectedBy: A.users.manager.id,
    });
    // It appears in the review queue for deciders.
    expect((await leads.listDuplicateCases(a.owner.ctx)).map((x) => x.id)).toContain(c[0]!.id);
  });

  it('an imported row with an existing email opens a case too; another org never matches', async () => {
    const first = await newLead(a.exec1, { email: 'synthetic.dup2@example.test' });
    await newLead(ownerB, { email: 'synthetic.dup2@example.test' });
    const src = (await row(first)).sourceId;
    const prepared = leads.prepareLead(
      leads.createInput.parse({
        fullName: 'Imported',
        primaryPhone: phone(),
        email: 'synthetic.dup2@example.test',
      }),
    );
    if (!prepared.ok) throw new Error('fixture');
    const [out] = await leads.importLeadBatch(
      a.owner.ctx,
      [{ row: 2, lead: prepared.lead, sourceId: src }],
      {
        importId: randomUUID(),
        duplicatePolicy: 'ATTACH',
        assignment: { mode: 'none' },
      },
    );
    expect(out!.outcome).toBe('CREATED');
    const c = await cases(first);
    expect(c).toHaveLength(1);
    expect(c[0]!.leadId).toBe(out!.leadId);
  });

  it('concurrent creates with the same new email open exactly one case', async () => {
    const email = `synthetic.race${seq}@example.test`;
    const [x, y] = await Promise.all([newLead(a.exec1, { email }), newLead(a.manager, { email })]);
    const c = await migrator().leadDuplicateMatch.findMany({
      where: {
        matchType: 'EMAIL',
        OR: [{ leadId: { in: [x, y] } }, { candidateLeadId: { in: [x, y] } }],
      },
    });
    expect(c).toHaveLength(1);
  });

  it('a shared name alone opens nothing; "_" in an email is not a wildcard', async () => {
    const n = await newLead(a.exec1, {
      fullName: 'Synthetic Same Name',
      email: 'syn_x@example.test',
    });
    const m = await newLead(a.exec1, {
      fullName: 'Synthetic Same Name',
      email: 'synAx@example.test',
    });
    expect(await cases(n)).toHaveLength(0);
    expect(await cases(m)).toHaveLength(0);
  });
});

// -------------------------------------------------------------------------------------------------
describe('custom fields in imports', () => {
  let C: Org;
  let ownerC: Actor;
  const enc = (s: string) => new TextEncoder().encode(s);
  const job = (id: string) => migrator().importJob.findUniqueOrThrow({ where: { id } });

  async function upload(body: Uint8Array, name: string) {
    const type = name.endsWith('.csv')
      ? 'text/csv'
      : 'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet';
    const s = await imports.startImport(
      ownerC.ctx,
      { fileName: name, size: body.byteLength, type },
      storage,
    );
    storage.browserPut(s.upload.url, body, s.upload.headers['content-type']!);
    await imports.confirmUpload(ownerC.ctx, s.importId, storage);
    return s.importId;
  }
  const step = (id: string) => processImportJob(C.orgId, id, { storage });
  async function map(id: string, extra: Record<string, unknown> = {}, dryRun = false) {
    const j = await job(id);
    return imports.submitMapping(ownerC.ctx, id, {
      mapping: { ...(j.mapping as object), ...extra },
      duplicatePolicy: 'ATTACH',
      assignment: { mode: 'none' },
      dryRun,
      version: j.version,
    });
  }
  async function confirm(id: string) {
    const j = await job(id);
    await imports.confirmImport(ownerC.ctx, id, {
      attest: true,
      acknowledgeDuplicateFile: true,
      version: j.version,
    });
  }
  const issues = async (id: string) =>
    (await imports.listImportIssues(ownerC.ctx, id, { limit: 100 })).issues.map(
      (i) => `${i.row}:${i.field}:${i.code}`,
    );

  beforeAll(async () => {
    C = await seedOrg('M5Import');
    ownerC = await actorIn(C.users.owner, C.orgId);
    await leads.createCustomField(ownerC.ctx, {
      key: 'site_city',
      label: 'Site City',
      type: 'text',
      required: true,
    });
    await leads.createCustomField(ownerC.ctx, {
      key: 'family_size',
      label: 'Family Size',
      type: 'number',
    });
  });

  it('a required custom field must be mapped', async () => {
    const id = await upload(enc(`Name,Mobile,Family Size\nA,${phone()},4\n`), 'nocity.csv');
    expect(await step(id)).toBe('needs_mapping');
    expect(await failure(map(id))).toMatchObject({
      code: 'VALIDATION_FAILED',
      fields: ['Site City'],
    });
  });

  it.each(['csv', 'xlsx'] as const)(
    '%s: valid values stored typed; missing/invalid ones are row problems; dry run writes nothing',
    async (kind) => {
      const [p1, p2, p3] = [phone(), phone(), phone()];
      const rows: (string | number)[][] = [
        ['Name', 'Mobile', 'Site City', 'Family Size'],
        ['Synthetic Good', p1, 'Pune', 4],
        ['Synthetic Missing', p2, '', 3],
        ['Synthetic Bad', p3, 'Mumbai', 'four'],
      ];
      const body =
        kind === 'csv'
          ? enc(rows.map((r) => r.join(',')).join('\n') + '\n')
          : xlsx({ Leads: rows });
      // Dry run first: nothing is written.
      const dry = await upload(body, `cf.${kind}`);
      expect(await step(dry)).toBe('needs_mapping');
      expect((await job(dry)).mapping).toMatchObject({
        'custom:site_city': 2,
        'custom:family_size': 3,
      });
      await map(dry, {}, true);
      await step(dry);
      expect(await issues(dry)).toEqual(
        expect.arrayContaining([
          '3:CF_site_city:CUSTOM_FIELD_REQUIRED',
          '4:CF_family_size:CUSTOM_FIELD_INVALID',
        ]),
      );
      expect(
        await migrator().lead.count({
          where: { orgId: C.orgId, primaryPhoneE164: { in: [p1, p2, p3].map((p) => `+91${p}`) } },
        }),
      ).toBe(0);
      const di = await imports.listImportIssues(ownerC.ctx, dry, { limit: 10 });
      expect(di.issues.find((i) => i.field === 'CF_site_city')).toMatchObject({
        column: 'Site City',
        fieldLabel: 'Site City',
      });

      // Real run: only the valid row becomes a lead, with typed values.
      const real = await upload(body, `cf2.${kind}`);
      await step(real);
      await map(real);
      await step(real);
      await confirm(real);
      while ((await job(real)).status === 'IMPORTING') await step(real);
      const created = await migrator().lead.findMany({
        where: { orgId: C.orgId, primaryPhoneE164: { in: [p1, p2, p3].map((p) => `+91${p}`) } },
      });
      expect(created).toHaveLength(1);
      expect(created[0]!.customFields).toEqual({ site_city: 'Pune', family_size: 4 });
    },
  );

  it('definitions changed after validation: the commit re-checks and reports the row FAILED', async () => {
    const p = phone();
    const id = await upload(
      enc(`Name,Mobile,Site City,Family Size\nSynthetic Late,${p},Pune,4\n`),
      'late.csv',
    );
    await step(id);
    await map(id);
    await step(id);
    // The number field is archived after validation: its value is no longer accepted.
    const f = await migrator().customFieldDefinition.findFirstOrThrow({
      where: { orgId: C.orgId, key: 'family_size' },
    });
    await leads.setCustomFieldArchived(ownerC.ctx, f.id, true, { version: f.version });
    try {
      await confirm(id);
      while ((await job(id)).status === 'IMPORTING') await step(id);
      expect(
        await migrator().lead.count({ where: { orgId: C.orgId, primaryPhoneE164: `+91${p}` } }),
      ).toBe(0);
      expect(await issues(id)).toContain('2:CF_family_size:CUSTOM_FIELD_INVALID');
    } finally {
      const g = await migrator().customFieldDefinition.findUniqueOrThrow({ where: { id: f.id } });
      await leads.setCustomFieldArchived(ownerC.ctx, f.id, false, { version: g.version });
    }
  });

  it('the direct batch API cannot bypass a required custom field', async () => {
    const src = (await migrator().leadSource.findFirstOrThrow({ where: { orgId: C.orgId } })).id;
    const prepared = leads.prepareLead(
      leads.createInput.parse({ fullName: 'Direct', primaryPhone: phone() }),
    );
    if (!prepared.ok) throw new Error('fixture');
    const out = await leads.importLeadBatch(
      ownerC.ctx,
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

// -------------------------------------------------------------------------------------------------
describe('export-worker recovery', () => {
  let E: Org;
  let ownerE: Actor;
  const job = (id: string) => migrator().exportJob.findUniqueOrThrow({ where: { id } });
  const build = (id: string, afterUpload?: () => Promise<void>) =>
    processExportJob(E.orgId, id, E.users.owner.id, {
      storage,
      ...(afterUpload ? { afterUpload } : {}),
    });
  const backdate = (id: string) =>
    migrator()
      .$executeRaw`UPDATE export_job SET started_at = now() - interval '5 minutes' WHERE id = ${id}::uuid`;

  beforeAll(async () => {
    E = await seedOrg('M5Export');
    ownerE = await actorIn(E.users.owner, E.orgId);
    await newLead(ownerE, { fullName: 'Synthetic Export Row' });
  });

  it('a crash mid-build is recovered after the lease, with one file and a valid checksum', async () => {
    const r = await exportsModule.requestLeadExport(ownerE.ctx, {});
    await expect(
      build(r.id, async () => {
        throw new Error('simulated worker crash');
      }),
    ).rejects.toThrow('simulated worker crash');
    const crashed = await job(r.id);
    expect(crashed.status).toBe('RUNNING');
    expect(storage.objects.has(crashed.storageKey)).toBe(true);
    expect(await build(r.id)).toBe('noop'); // lease not expired: a live builder is not overtaken
    await backdate(r.id);
    expect(await build(r.id)).toBe('ready');
    const file = await exportsModule.downloadLeadExport(ownerE.ctx, r.id, { storage });
    expect(Buffer.from(file.body).toString('utf8')).toContain('Synthetic Export Row');
    expect([...storage.objects.keys()].filter((k) => k.includes(`/exports/${r.id}/`))).toHaveLength(
      1,
    );
  });

  it('a stale builder cannot publish or fail a job another worker re-claimed (fencing)', async () => {
    const r = await exportsModule.requestLeadExport(ownerE.ctx, {});
    let second: string | undefined;
    const first = await build(r.id, async () => {
      // While the first builder is "slow", its claim expires and another worker takes over.
      await backdate(r.id);
      second = await build(r.id);
    });
    expect(second).toBe('ready');
    expect(first).toBe('failed'); // its READY/FAILED were fenced out: nothing it wrote applies
    const j = await job(r.id);
    expect(j.status).toBe('READY');
    expect(j.errorCode).toBeNull();
    // The file served is the one the winning claim checksummed.
    expect(await codeOf(exportsModule.downloadLeadExport(ownerE.ctx, r.id, { storage }))).toBe(
      'OK',
    );
  });
});
