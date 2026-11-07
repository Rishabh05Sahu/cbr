// FR-041 saved import mapping templates (migration 0009) through the real import job: save a
// validated mapping (headings only), apply it to a compatible reordered file, warn on missing,
// ambiguous and stale entries without guessing, duplicate names, authorization, tenant isolation,
// delete, and the database rules (RLS forced, no UPDATE for crm_app). Synthetic data only.
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
let portalSource: string;
let templateId: string;

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

let seq = 0;
const phone = () => `97${String(30_000_000 + ++seq * 5_101 + (process.pid % 1000)).slice(-8)}`;

/** Uploads a CSV and runs the job to the mapping step. */
async function upload(by: Actor, org: string, csv: string) {
  const body = Buffer.from(csv);
  const s = await imports.startImport(
    by.ctx,
    { fileName: 'templates.csv', size: body.byteLength, type: 'text/csv' },
    storage,
  );
  storage.browserPut(s.upload.url, body, s.upload.headers['content-type']!);
  await imports.confirmUpload(by.ctx, s.importId, storage);
  const step = () => processImportJob(org, s.importId, { storage });
  expect(await step()).toBe('needs_mapping');
  return { id: s.importId, step };
}
const job = (id: string) => migrator().importJob.findUniqueOrThrow({ where: { id } });
const submit = async (by: Actor, id: string, mapping: Record<string, unknown>) =>
  imports.submitMapping(by.ctx, id, {
    mapping,
    duplicatePolicy: 'SKIP',
    assignment: { mode: 'none' },
    dryRun: false,
    version: (await job(id)).version,
  });

beforeAll(async () => {
  storage = memoryStorage();
  A = await seedOrg('TemplatesA');
  B = await seedOrg('TemplatesB');
  for (const k of ['owner', 'admin', 'manager', 'exec1'] as const)
    a[k] = await actorIn(A.users[k], A.orgId);
  ownerB = await actorIn(B.users.owner, B.orgId);
  portalSource = (await leads.createLeadSource(a.owner.ctx, { name: '99acres', channel: 'PORTAL' }))
    .id;
});

describe('saving a template', () => {
  it('saves a validated mapping as headings only (no positions, no cell values), with audit', async () => {
    const [p1, p2] = [phone(), phone()];
    const { id, step } = await upload(
      a.owner,
      A.orgId,
      `Customer Name,Mobile No.,Lead Source,Remarks\nSynthetic One,${p1},99acres,x\nSynthetic Two,${p2},99acres,y\n`,
    );
    // Before validation there is nothing reviewed to save.
    expect(
      await codeOf(imports.saveMappingTemplate(a.owner.ctx, { importId: id, name: 'Too early' })),
    ).toBe('RULE_VIOLATION');
    await submit(a.owner, id, { fullName: 0, primaryPhone: 1, source: 2 });
    expect(await step()).toBe('ready');

    templateId = (
      await imports.saveMappingTemplate(a.owner.ctx, {
        importId: id,
        name: '  99acres   export ',
        sourceId: portalSource,
      })
    ).id;
    const row = await migrator().importMappingTemplate.findUniqueOrThrow({
      where: { id: templateId },
    });
    expect(row).toMatchObject({
      orgId: A.orgId,
      name: '99acres export',
      sourceId: portalSource,
      createdBy: A.users.owner.id,
      mapping: { fullName: 'Customer Name', primaryPhone: 'Mobile No.', source: 'Lead Source' },
    });
    const stored = JSON.stringify(row.mapping);
    for (const v of [p1, p2, 'Synthetic One', 'x']) expect(stored).not.toContain(v);
    expect(
      await migrator().auditLog.count({
        where: { action: 'import_template.created', entityId: templateId },
      }),
    ).toBe(1);
    expect((await imports.listMappingTemplates(a.admin.ctx)).map((t) => t.name)).toContain(
      '99acres export',
    );

    // Duplicate names ignoring case and spacing; invalid names; a source that is not active here.
    for (const name of ['99ACRES EXPORT', ' 99acres  export'])
      expect(await codeOf(imports.saveMappingTemplate(a.admin.ctx, { importId: id, name }))).toBe(
        'CONFLICT',
      );
    for (const name of ['   ', 'x'.repeat(101)])
      expect(await codeOf(imports.saveMappingTemplate(a.admin.ctx, { importId: id, name }))).toBe(
        'VALIDATION_FAILED',
      );
    const otherOrgSource = (
      await leads.createLeadSource(ownerB.ctx, { name: 'B only', channel: 'OTHER' })
    ).id;
    expect(
      await codeOf(
        imports.saveMappingTemplate(a.admin.ctx, {
          importId: id,
          name: 'Wrong source',
          sourceId: otherOrgSource,
        }),
      ),
    ).toBe('VALIDATION_FAILED');
  });
});

describe('applying a template', () => {
  it('maps a compatible file with reordered, restyled headings, and the mapping validates', async () => {
    const [p1, p2] = [phone(), phone()];
    const { id, step } = await upload(
      a.admin,
      A.orgId,
      `LEAD SOURCE,Extra,customer name,MOBILE NO\n99acres,a,Synthetic Three,${p1}\n99acres,b,Synthetic Four,${p2}\n`,
    );
    const t = await imports.templateForImport(a.admin.ctx, id, templateId);
    expect(t).toMatchObject({
      name: '99acres export',
      warnings: [],
      sourceId: portalSource,
      mapping: { source: 0, fullName: 2, primaryPhone: 3 },
    });
    // Applying wrote nothing; the job still has its own suggestion until the user submits.
    expect((await job(id)).status).toBe('NEEDS_MAPPING');
    await submit(a.admin, id, t.mapping);
    expect(await step()).toBe('ready');
    expect(await job(id)).toMatchObject({ rowsValid: 2, rowsInvalid: 0 });
  });

  it('warns on missing and ambiguous headings and leaves them unmapped; submitting stays refused', async () => {
    const { id } = await upload(
      a.owner,
      A.orgId,
      `Customer Name,Customer Name,Phone Number\nX One,X Two,${phone()}\n`,
    );
    const t = await imports.templateForImport(a.owner.ctx, id, templateId);
    expect(t.mapping).toEqual({});
    expect(t.warnings).toEqual(
      expect.arrayContaining([
        { code: 'HEADER_AMBIGUOUS', field: 'fullName', header: 'Customer Name' },
        { code: 'HEADER_MISSING', field: 'primaryPhone', header: 'Mobile No.' },
        { code: 'HEADER_MISSING', field: 'source', header: 'Lead Source' },
        { code: 'REQUIRED_UNMAPPED', field: 'fullName' },
        { code: 'REQUIRED_UNMAPPED', field: 'primaryPhone' },
      ]),
    );
    expect(await codeOf(submit(a.owner, id, t.mapping))).toBe('VALIDATION_FAILED');
  });

  it('skips stale entries (fields that no longer exist) with a warning', async () => {
    const stale = await migrator().importMappingTemplate.create({
      data: {
        orgId: A.orgId,
        name: 'Stale',
        createdBy: A.users.owner.id,
        mapping: {
          fullName: 'Customer Name',
          primaryPhone: 'Mobile No.',
          'custom:gone': 'Remarks',
        },
      },
    });
    const { id } = await upload(
      a.owner,
      A.orgId,
      `Customer Name,Mobile No.,Remarks\nStale One,${phone()},r\n`,
    );
    const t = await imports.templateForImport(a.owner.ctx, id, stale.id);
    expect(t.mapping).toEqual({ fullName: 0, primaryPhone: 1 });
    expect(t.warnings).toEqual([
      { code: 'FIELD_UNKNOWN', field: 'custom:gone', header: 'Remarks' },
    ]);
  });
});

describe('access', () => {
  it('managers and executives cannot list, save, apply or delete templates', async () => {
    const { id } = await upload(a.owner, A.orgId, `Customer Name,Mobile No.\nAcc One,${phone()}\n`);
    for (const who of [a.manager, a.exec1]) {
      expect(await codeOf(imports.listMappingTemplates(who.ctx))).toBe('FORBIDDEN');
      expect(
        await codeOf(imports.saveMappingTemplate(who.ctx, { importId: id, name: 'Nope' })),
      ).toBe('FORBIDDEN');
      expect(await codeOf(imports.templateForImport(who.ctx, id, templateId))).toBe('FORBIDDEN');
      expect(await codeOf(imports.deleteMappingTemplate(who.ctx, templateId))).toBe('FORBIDDEN');
    }
  });

  it('is per organisation: another org cannot see, apply, delete or collide with it', async () => {
    expect((await imports.listMappingTemplates(ownerB.ctx)).map((t) => t.id)).not.toContain(
      templateId,
    );
    const { id: jobB, step } = await upload(
      ownerB,
      B.orgId,
      `Customer Name,Mobile No.\nB One,${phone()}\n`,
    );
    expect(await codeOf(imports.templateForImport(ownerB.ctx, jobB, templateId))).toBe('NOT_FOUND');
    expect(await codeOf(imports.deleteMappingTemplate(ownerB.ctx, templateId))).toBe('NOT_FOUND');
    // Nor can org A apply its template to org B's import.
    expect(await codeOf(imports.templateForImport(a.owner.ctx, jobB, templateId))).toBe(
      'NOT_FOUND',
    );
    await submit(ownerB, jobB, { fullName: 0, primaryPhone: 1 });
    expect(await step()).toBe('ready');
    const b = await imports.saveMappingTemplate(ownerB.ctx, {
      importId: jobB,
      name: '99acres export',
      orgId: A.orgId,
    } as never);
    expect(
      (await migrator().importMappingTemplate.findUniqueOrThrow({ where: { id: b.id } })).orgId,
    ).toBe(B.orgId);
    // Saving from another org's import is impossible: the job is not visible.
    expect(
      await codeOf(imports.saveMappingTemplate(a.owner.ctx, { importId: jobB, name: 'Theirs' })),
    ).toBe('NOT_FOUND');
  });

  it('deletes with audit; a deleted template is gone and cannot be applied', async () => {
    const { id, step } = await upload(
      a.owner,
      A.orgId,
      `Customer Name,Mobile No.\nDel One,${phone()}\n`,
    );
    await submit(a.owner, id, { fullName: 0, primaryPhone: 1 });
    expect(await step()).toBe('ready');
    const t = await imports.saveMappingTemplate(a.owner.ctx, { importId: id, name: 'Short lived' });
    await imports.deleteMappingTemplate(a.admin.ctx, t.id);
    expect(await migrator().importMappingTemplate.count({ where: { id: t.id } })).toBe(0);
    expect(
      await migrator().auditLog.count({
        where: { action: 'import_template.deleted', entityId: t.id },
      }),
    ).toBe(1);
    expect(await codeOf(imports.templateForImport(a.owner.ctx, id, t.id))).toBe('NOT_FOUND');
    expect(await codeOf(imports.deleteMappingTemplate(a.owner.ctx, t.id))).toBe('NOT_FOUND');
  });
});

describe('which import statuses can be saved (server-side, not page visibility)', () => {
  let n = 0;
  const save = (id: string) =>
    codeOf(imports.saveMappingTemplate(a.owner.ctx, { importId: id, name: `Status check ${++n}` }));
  const status = async (id: string) => (await job(id)).status;
  /** Uploads, submits a mapping (the job is then VALIDATING) and returns the step runner. */
  async function mapped(csv: string, dryRun = false) {
    const u = await upload(a.owner, A.orgId, csv);
    await imports.submitMapping(a.owner.ctx, u.id, {
      mapping: { fullName: 0, primaryPhone: 1 },
      duplicatePolicy: 'SKIP',
      assignment: { mode: 'none' },
      dryRun,
      version: (await job(u.id)).version,
    });
    return u;
  }

  it('refuses a mapping that is still validating, or whose validation failed', async () => {
    const { id } = await mapped(`Name,Phone\nStatus One,${phone()}\n`);
    expect(await status(id)).toBe('VALIDATING');
    expect((await job(id)).mapping).not.toBeNull();
    expect(await save(id)).toBe('RULE_VIOLATION');
    // A validation failure ends the job as FAILED (as the processor does), mapping kept.
    await migrator().importJob.update({
      where: { id },
      data: { status: 'FAILED', errorCode: 'VALIDATION_FAILED', finishedAt: new Date() },
    });
    expect(await save(id)).toBe('RULE_VIOLATION');
  });

  it('accepts IMPORTING and PAUSED; refuses the same mapping once cancelled', async () => {
    const { id, step } = await mapped(`Name,Phone\nStatus Two,${phone()}\n`);
    expect(await step()).toBe('ready');
    await imports.confirmImport(a.owner.ctx, id, {
      attest: true,
      version: (await job(id)).version,
    });
    expect(await status(id)).toBe('IMPORTING');
    expect(await save(id)).toBe('OK');
    await migrator().importJob.update({ where: { id }, data: { status: 'PAUSED' } });
    expect(await save(id)).toBe('OK');
    await imports.cancelImport(a.owner.ctx, id);
    expect(await status(id)).toBe('CANCELLED');
    expect(await save(id)).toBe('RULE_VIOLATION');
  });

  it('accepts COMPLETED (dry run) and COMPLETED_WITH_ERRORS', async () => {
    const dry = await mapped(`Name,Phone\nStatus Three,${phone()}\n`, true);
    await dry.step();
    expect(await status(dry.id)).toBe('COMPLETED');
    expect(await save(dry.id)).toBe('OK');

    const bad = await mapped(`Name,Phone\nStatus Four,${phone()}\nStatus Bad,12345\n`);
    expect(await bad.step()).toBe('ready');
    await imports.confirmImport(a.owner.ctx, bad.id, {
      attest: true,
      version: (await job(bad.id)).version,
    });
    expect(await bad.step()).toBe('completed');
    expect(await status(bad.id)).toBe('COMPLETED_WITH_ERRORS');
    expect(await save(bad.id)).toBe('OK');
  });
});

describe('database rules (migration 0009)', () => {
  it('RLS enabled and forced; crm_app may select, insert and delete but never update', async () => {
    const [rls] = await migrator().$queryRaw<{ rls: boolean; forced: boolean }[]>`
      SELECT relrowsecurity AS rls, relforcerowsecurity AS forced
        FROM pg_class WHERE oid = 'public.import_mapping_template'::regclass`;
    expect(rls).toEqual({ rls: true, forced: true });
    const [p] = await migrator().$queryRaw<
      { sel: boolean; ins: boolean; del: boolean; upd: boolean; auth: boolean }[]
    >`
      SELECT has_table_privilege('crm_app', 'public.import_mapping_template', 'SELECT') AS sel,
             has_table_privilege('crm_app', 'public.import_mapping_template', 'INSERT') AS ins,
             has_table_privilege('crm_app', 'public.import_mapping_template', 'DELETE') AS del,
             has_any_column_privilege('crm_app', 'public.import_mapping_template', 'UPDATE') AS upd,
             has_table_privilege('crm_auth', 'public.import_mapping_template', 'SELECT') AS auth`;
    expect(p).toEqual({ sel: true, ins: true, del: true, upd: false, auth: false });
  });
});
