// Phase 2 M4 import flow on crm_test: upload authorisation and verification, analysis, sheet
// choice, mapping, validation, dry run, confirmation, batched import as the uploader, pause on
// revoked access and resume, cancellation, crash/retry idempotency, cleanup and cross-org
// isolation. Storage is an in-memory double; the worker step is called directly. Synthetic data.
import { beforeAll, describe, expect, it } from 'vitest';
import * as imports from '@/modules/imports';
import { sweepImportFiles } from '@/modules/imports/cleanup';
import { processImportJob, type ProcessDeps } from '@/modules/imports/processor';
import * as leads from '@/modules/leads';
import * as teams from '@/modules/teams';
import { tenantRunner } from '@/platform/db';
import { importFilesDue } from '@/platform/db/cleanup';
import { DomainError } from '@/platform/errors';
import { migrator } from '../support/db';
import { actorIn, seedOrg, type Actor } from '../support/factory';
import { memoryStorage, type MemoryStorage } from '../support/memory-storage';
import { xlsx } from '../support/spreadsheets';

type Org = Awaited<ReturnType<typeof seedOrg>>;
let A: Org;
let B: Org;
const a = {} as Record<'owner' | 'admin' | 'manager' | 'exec1' | 'hr', Actor>;
let ownerB: Actor;
let north: string;
let storage: MemoryStorage;

let seq = 0;
const phone = () => `96${String(10_000_000 + ++seq * 7_919).slice(-8)}`;
const enc = (s: string) => new TextEncoder().encode(s);
const csv = (rows: string[][]) => enc(rows.map((r) => r.join(',')).join('\n') + '\n');

async function code(p: Promise<unknown>): Promise<string> {
  try {
    await p;
    return 'OK';
  } catch (e) {
    if (e instanceof DomainError) return e.code;
    if (e instanceof Error && e.name === 'ZodError') return 'VALIDATION_FAILED';
    throw e;
  }
}

const job = (id: string) => migrator().importJob.findUniqueOrThrow({ where: { id } });
const countLeads = (orgId: string) => migrator().lead.count({ where: { orgId } });

/** Upload as the browser would: start, PUT to the grant, confirm. */
async function upload(
  actor: Actor,
  body: Uint8Array,
  name = 'leads.csv',
  type = name.endsWith('.csv')
    ? 'text/csv'
    : 'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet',
) {
  const started = await imports.startImport(
    actor.ctx,
    { fileName: name, size: body.byteLength, type },
    storage,
  );
  storage.browserPut(started.upload.url, body, started.upload.headers['content-type']!);
  await imports.confirmUpload(actor.ctx, started.importId, storage);
  return started.importId;
}

const deps = (extra: Partial<ProcessDeps> = {}): ProcessDeps => ({ storage, ...extra });
const step = (org: Org, id: string, extra: Partial<ProcessDeps> = {}) =>
  processImportJob(org.orgId, id, deps(extra));

async function mapped(
  actor: Actor,
  id: string,
  opts: Partial<{ dryRun: boolean; duplicatePolicy: 'ATTACH' | 'SKIP'; assignment: unknown }> = {},
) {
  const j = await job(id);
  await imports.submitMapping(actor.ctx, id, {
    mapping: j.mapping,
    duplicatePolicy: opts.duplicatePolicy ?? 'ATTACH',
    assignment: opts.assignment ?? { mode: 'none' },
    dryRun: opts.dryRun ?? false,
    version: j.version,
  });
}

/** Upload → analyse → map → validate: the job is READY (or a finished dry run). */
async function readyImport(actor: Actor, org: Org, body: Uint8Array, opts = {}) {
  const id = await upload(actor, body);
  expect(await step(org, id)).toBe('needs_mapping');
  await mapped(actor, id, opts);
  await step(org, id);
  return id;
}

async function confirm(actor: Actor, id: string, ack = false) {
  const j = await job(id);
  await imports.confirmImport(actor.ctx, id, {
    attest: true,
    acknowledgeDuplicateFile: ack,
    version: j.version,
  });
}

const bigCsv = (n: number) =>
  csv([['Name', 'Mobile'], ...Array.from({ length: n }, (_, i) => [`Bulk ${i}`, phone()])]);

beforeAll(async () => {
  storage = memoryStorage();
  A = await seedOrg('FlowA');
  B = await seedOrg('FlowB');
  for (const k of ['owner', 'admin', 'manager', 'exec1', 'hr'] as const)
    a[k] = await actorIn(A.users[k], A.orgId);
  ownerB = await actorIn(B.users.owner, B.orgId);
  north = (await teams.createTeam(a.owner.ctx, { name: 'North' })).id;
  for (const m of [A.membership.manager!, A.membership.exec1!])
    await teams.addTeamMember(a.owner.ctx, { teamId: north, membershipId: m, teamRole: 'MEMBER' });
});

describe('upload authorisation and verification', () => {
  it.each(['manager', 'exec1', 'hr'] as const)('%s cannot start an import', async (who) => {
    expect(
      await code(
        imports.startImport(a[who].ctx, { fileName: 'x.csv', size: 10, type: 'text/csv' }, storage),
      ),
    ).toBe('FORBIDDEN');
  });

  it('grants one server-named object in the org, refuses bad files, and keeps names out of keys', async () => {
    const s = await imports.startImport(
      a.owner.ctx,
      { fileName: '../../secret/Leads Q3.csv', size: 20, type: 'text/csv' },
      storage,
    );
    const key = storage.keyOf(s.upload.url);
    expect(key).toMatch(new RegExp(`^orgs/${A.orgId}/imports/${s.importId}/[0-9a-f]{32}\\.csv$`));
    expect(s.upload.headers).toEqual({ 'content-type': 'text/csv', 'x-upsert': 'false' });
    expect((await job(s.importId)).originalFilename).toBe('Leads Q3.csv');
    expect(
      await code(
        imports.startImport(a.owner.ctx, { fileName: 'm.xlsm', size: 5, type: '' }, storage),
      ),
    ).toBe('VALIDATION_FAILED');
    expect(
      await code(
        imports.startImport(
          a.owner.ctx,
          { fileName: 'big.csv', size: 50 * 1024 * 1024, type: 'text/csv' },
          storage,
        ),
      ),
    ).toBe('VALIDATION_FAILED');
    await imports.cancelImport(a.owner.ctx, s.importId);
  });

  it('confirms only an object of the announced size and type, only for the uploader, once', async () => {
    const body = csv([
      ['Name', 'Phone'],
      ['Asha', phone()],
    ]);
    const s = await imports.startImport(
      a.owner.ctx,
      { fileName: 'a.csv', size: body.byteLength, type: 'text/csv' },
      storage,
    );
    // Nothing uploaded yet: refused, the job stays open for a retry.
    expect(await code(imports.confirmUpload(a.owner.ctx, s.importId, storage))).toBe(
      'RULE_VIOLATION',
    );
    expect((await job(s.importId)).status).toBe('AWAITING_UPLOAD');
    storage.browserPut(s.upload.url, body, 'text/csv');
    expect(await code(imports.confirmUpload(a.admin.ctx, s.importId, storage))).toBe('FORBIDDEN');
    await imports.confirmUpload(a.owner.ctx, s.importId, storage);
    // Second call (double click / retry) is harmless; one processing event was emitted.
    expect(await imports.confirmUpload(a.owner.ctx, s.importId, storage)).toEqual({
      status: 'UPLOADED',
    });
    const events = await migrator().outboxEvent.count({
      where: { type: 'import.process_requested', payload: { equals: { importJobId: s.importId } } },
    });
    expect(events).toBe(1);
    await imports.cancelImport(a.owner.ctx, s.importId);

    const short = await imports.startImport(
      a.owner.ctx,
      { fileName: 'b.csv', size: 999, type: 'text/csv' },
      storage,
    );
    storage.browserPut(short.upload.url, body, 'text/csv');
    expect(await code(imports.confirmUpload(a.owner.ctx, short.importId, storage))).toBe(
      'RULE_VIOLATION',
    );
    expect(await job(short.importId)).toMatchObject({
      status: 'FAILED',
      errorCode: 'UPLOAD_SIZE_MISMATCH',
    });

    const typed = await imports.startImport(
      a.owner.ctx,
      { fileName: 'c.csv', size: body.byteLength, type: 'text/csv' },
      storage,
    );
    storage.browserPut(typed.upload.url, body, 'application/x-msdownload');
    expect(await code(imports.confirmUpload(a.owner.ctx, typed.importId, storage))).toBe(
      'RULE_VIOLATION',
    );
    expect(await job(typed.importId)).toMatchObject({ errorCode: 'UPLOAD_TYPE_MISMATCH' });
  });
});

describe('analysis, sheets and mapping', () => {
  it('reads headers, suggests a mapping and counts rows; the hash is recorded', async () => {
    const id = await upload(
      a.owner,
      csv([
        ['Customer Name', 'Mobile No', 'Notes'],
        ['Asha', phone(), 'x'],
      ]),
    );
    expect(await step(A, id)).toBe('needs_mapping');
    const j = await job(id);
    expect(j).toMatchObject({
      status: 'NEEDS_MAPPING',
      headers: ['Customer Name', 'Mobile No', 'Notes'],
      rowsTotal: 1,
      mapping: { fullName: 0, primaryPhone: 1, note: 2 },
    });
    expect(j.sha256).toHaveLength(32);
    // A duplicate event or a second worker finds nothing to do.
    expect(await step(A, id)).toBe('noop');
    await imports.cancelImport(a.owner.ctx, id);
  });

  it('XLSX: lists sheets; choosing another re-reads that sheet only', async () => {
    const book = xlsx({
      Notes: [['Remark'], ['ignore me']],
      Leads: [
        ['Name', 'Phone'],
        ['Ravi', Number(phone())],
      ],
    });
    const id = await upload(a.owner, book, 'book.xlsx');
    expect(await step(A, id)).toBe('needs_mapping');
    let j = await job(id);
    expect(j).toMatchObject({
      sheetNames: ['Notes', 'Leads'],
      sheetName: 'Notes',
      headers: ['Remark'],
    });
    expect(
      await code(imports.chooseSheet(a.owner.ctx, id, { sheet: 'Nope', version: j.version })),
    ).toBe('NOT_FOUND');
    await imports.chooseSheet(a.owner.ctx, id, { sheet: 'Leads', version: j.version });
    expect(await step(A, id)).toBe('needs_mapping');
    j = await job(id);
    expect(j).toMatchObject({ sheetName: 'Leads', headers: ['Name', 'Phone'], rowsTotal: 1 });
    await imports.cancelImport(a.owner.ctx, id);
  });

  it('refuses macro workbooks and unreadable files before parsing', async () => {
    const macro = xlsx({ S: [['Name']] }, [{ name: 'xl/vbaProject.bin', data: 'x' }]);
    const id = await upload(a.owner, macro, 'm.xlsx');
    expect(await step(A, id)).toBe('failed');
    expect(await job(id)).toMatchObject({ status: 'FAILED', errorCode: 'FILE_MACRO_OR_LEGACY' });
    const bad = await upload(a.owner, enc('Name,Phone\n"Asha,1\n'));
    expect(await step(A, bad)).toBe('failed');
    expect((await job(bad)).errorCode).toBe('PARSE_FAILED');
  });

  it('mapping: required fields, stale versions and other users are refused', async () => {
    const id = await upload(
      a.owner,
      csv([
        ['Name', 'Phone'],
        ['Asha', phone()],
      ]),
    );
    await step(A, id);
    const j = await job(id);
    const base = { duplicatePolicy: 'ATTACH', assignment: { mode: 'none' }, dryRun: false };
    expect(
      await code(
        imports.submitMapping(a.owner.ctx, id, {
          ...base,
          mapping: { fullName: 0 },
          version: j.version,
        }),
      ),
    ).toBe('VALIDATION_FAILED');
    expect(
      await code(
        imports.submitMapping(a.owner.ctx, id, {
          ...base,
          mapping: { orgId: 0, fullName: 0, primaryPhone: 1 },
          version: j.version,
        }),
      ),
    ).toBe('VALIDATION_FAILED');
    expect(
      await code(
        imports.submitMapping(a.owner.ctx, id, {
          ...base,
          mapping: j.mapping,
          version: j.version - 1,
        }),
      ),
    ).toBe('CONFLICT');
    expect(
      await code(
        imports.submitMapping(a.admin.ctx, id, { ...base, mapping: j.mapping, version: j.version }),
      ),
    ).toBe('FORBIDDEN');
    await imports.cancelImport(a.owner.ctx, id);
  });

  it('a file swapped in storage after analysis is refused', async () => {
    const body = csv([
      ['Name', 'Phone'],
      ['Asha', phone()],
    ]);
    const id = await upload(a.owner, body);
    await step(A, id);
    const tampered = csv([
      ['Name', 'Phone'],
      ['Evil', phone()],
    ]);
    expect(tampered.byteLength).toBe(body.byteLength);
    storage.tamper((await job(id)).storageKey, tampered);
    await mapped(a.owner, id);
    expect(await step(A, id)).toBe('failed');
    expect((await job(id)).errorCode).toBe('FILE_CHANGED');
  });
});

describe('validation and dry run', () => {
  it('reports invalid rows, in-file and existing duplicates by row, field and code (no values)', async () => {
    const existingPhone = phone();
    const ex = await leads.createLead(a.exec1.ctx, {
      fullName: 'Existing',
      primaryPhone: existingPhone,
    });
    if (ex.status !== 'created') throw new Error('fixture');
    const dup = phone();
    const badPhone = '12345-SECRET';
    const id = await readyImport(
      a.owner,
      A,
      csv([
        ['Name', 'Phone', 'Budget'],
        ['Good One', phone(), '50 L'],
        ['Bad Phone', badPhone, ''],
        ['First', dup, ''],
        ['Second', dup, ''],
        ['', '', ''],
        ['Returning', existingPhone, ''],
        ['Bad Budget', phone(), 'lots'],
      ]),
    );
    expect(await job(id)).toMatchObject({
      status: 'READY',
      rowsTotal: 7,
      rowsValid: 3,
      rowsInvalid: 2,
      rowsDuplicateInFile: 1,
      rowsEmpty: 1,
    });
    const view = await imports.getImport(a.owner.ctx, id);
    expect(view.counts.existingDuplicates).toBe(1);
    const { issues } = await imports.listImportIssues(a.owner.ctx, id);
    expect(issues.map((i) => [i.row, i.outcome, i.field, i.code])).toEqual([
      [3, 'INVALID', 'primaryPhone', expect.stringMatching(/^PHONE_/)],
      [5, 'DUPLICATE_IN_FILE', 'primaryPhone', 'DUPLICATE_IN_FILE'],
      [7, 'DUPLICATE_ATTACHED', 'primaryPhone', 'EXISTING_LEAD'],
      [8, 'INVALID', 'budgetMin', expect.stringMatching(/^BUDGET_/)],
    ]);
    expect(issues[1]!.relatedRow).toBe(4);
    expect(issues[2]!.leadId).toBe(ex.leadId);
    expect(issues[0]!.column).toBe('Phone');
    const csvOut = await imports.importIssuesCsv(a.owner.ctx, id);
    for (const secret of [badPhone, 'SECRET', 'Bad Phone', 'lots', existingPhone])
      expect(JSON.stringify(issues) + csvOut).not.toContain(secret);
    await imports.cancelImport(a.owner.ctx, id);
  });

  it('a dry run validates and reports but never creates leads or attaches enquiries', async () => {
    const existingPhone = phone();
    await leads.createLead(a.exec1.ctx, { fullName: 'Existing', primaryPhone: existingPhone });
    const before = {
      leads: await countLeads(A.orgId),
      enquiries: await migrator().leadEnquiry.count({ where: { orgId: A.orgId } }),
    };
    const id = await readyImport(
      a.owner,
      A,
      csv([
        ['Name', 'Phone'],
        ['New', phone()],
        ['Again', existingPhone],
      ]),
      { dryRun: true },
    );
    expect(await job(id)).toMatchObject({
      status: 'COMPLETED',
      dryRun: true,
      rowsValid: 2,
      rowsCreated: 0,
      rowsAttached: 0,
      nextRow: 0,
    });
    expect(await countLeads(A.orgId)).toBe(before.leads);
    expect(await migrator().leadEnquiry.count({ where: { orgId: A.orgId } })).toBe(
      before.enquiries,
    );
    expect(await code(confirm(a.owner, id))).toBe('RULE_VIOLATION');
    expect(await step(A, id)).toBe('noop');
    // The database itself refuses to start a dry run (CHECK import_job_attested; the trigger
    // also freezes the finished job).
    await expect(
      tenantRunner().withTenant(
        a.owner.ctx.tenant,
        (tx) =>
          tx.$executeRaw`UPDATE import_job SET status = 'IMPORTING', attested_at = now() WHERE id = ${id}::uuid`,
      ),
    ).rejects.toThrow(/is finished|import_job_attested/);
    const fresh = await readyImport(
      a.owner,
      A,
      csv([
        ['Name', 'Phone'],
        ['X', phone()],
      ]),
      { dryRun: true },
    );
    expect((await job(fresh)).status).toBe('COMPLETED');
  });
});

describe('confirm and import', () => {
  it('needs the attestation; imports as the uploader with assignment and duplicate handling', async () => {
    const existingPhone = phone();
    const ex = await leads.createLead(a.exec1.ctx, {
      fullName: 'Existing',
      primaryPhone: existingPhone,
    });
    if (ex.status !== 'created') throw new Error('fixture');
    const before = await countLeads(A.orgId);
    const id = await readyImport(
      a.admin,
      A,
      csv([
        ['Name', 'Phone'],
        ['One', phone()],
        ['Two', phone()],
        ['Back', existingPhone],
        ['Bad', 'x'],
      ]),
      { assignment: { mode: 'round_robin', teamId: north } },
    );
    const j = await job(id);
    expect(
      await code(imports.confirmImport(a.admin.ctx, id, { attest: false, version: j.version })),
    ).toBe('VALIDATION_FAILED');
    expect(await code(confirm(a.owner, id))).toBe('FORBIDDEN'); // not the uploader
    await confirm(a.admin, id);
    expect(await code(confirm(a.admin, id))).toBe('RULE_VIOLATION'); // already started
    expect(await step(A, id)).toBe('completed');
    const done = await job(id);
    expect(done).toMatchObject({
      status: 'COMPLETED_WITH_ERRORS',
      rowsCreated: 2,
      rowsAttached: 1,
      rowsInvalid: 1,
      nextRow: 4,
      attestationVersion: imports.ATTESTATION_VERSION,
    });
    expect(done.attestedAt).not.toBeNull();
    expect(await countLeads(A.orgId)).toBe(before + 2);
    const created = await migrator().lead.findMany({
      where: {
        enquiries: { some: { externalId: { startsWith: `${id}:` } } },
        id: { not: ex.leadId },
      },
      select: { createdBy: true, ownerUserId: true, teamId: true },
    });
    expect(created).toHaveLength(2);
    for (const l of created)
      expect(l).toMatchObject({ createdBy: A.users.admin.id, teamId: north });
    expect(new Set(created.map((l) => l.ownerUserId)).size).toBe(2); // dealt in turn
    expect(
      await migrator().leadEnquiry.count({ where: { leadId: ex.leadId, externalId: `${id}:4` } }),
    ).toBe(1);
    const audit = await migrator().auditLog.findMany({
      where: { entityId: id },
      select: { action: true, actorUserId: true },
    });
    expect(audit.map((x) => x.action).sort()).toEqual(
      ['import.completed', 'import.confirmed', 'import.created'].sort(),
    );
    expect(audit.every((x) => x.actorUserId === A.users.admin.id)).toBe(true);
  });

  it('crash mid-batch: the batch rolls back, a retry resumes from the cursor, nothing is doubled', async () => {
    const before = await countLeads(A.orgId);
    const id = await readyImport(a.owner, A, bigCsv(7));
    await confirm(a.owner, id);
    await expect(
      step(A, id, {
        batchRows: 3,
        inBatch: (n) => {
          if (n === 1) throw new Error('simulated worker crash');
        },
      }),
    ).rejects.toThrow('simulated worker crash');
    expect(await job(id)).toMatchObject({ status: 'IMPORTING', nextRow: 3, rowsCreated: 3 });
    expect(await countLeads(A.orgId)).toBe(before + 3);
    expect(await step(A, id, { batchRows: 3 })).toBe('completed');
    expect(await job(id)).toMatchObject({ status: 'COMPLETED', nextRow: 7, rowsCreated: 7 });
    expect(await countLeads(A.orgId)).toBe(before + 7);
    expect(await step(A, id)).toBe('noop');
    expect(await countLeads(A.orgId)).toBe(before + 7);
  });

  it('a second import cannot start while one is running', async () => {
    const first = await readyImport(a.owner, A, bigCsv(2));
    const second = await readyImport(a.owner, A, bigCsv(2));
    await confirm(a.owner, first);
    expect(await code(confirm(a.owner, second))).toBe('CONFLICT');
    expect(await step(A, first)).toBe('completed');
    await confirm(a.owner, second);
    expect(await step(A, second)).toBe('completed');
  });

  it('the same file again needs an explicit acknowledgement', async () => {
    const body = bigCsv(1);
    const first = await readyImport(a.owner, A, body);
    await confirm(a.owner, first);
    await step(A, first);
    const again = await upload(a.owner, body);
    await step(A, again);
    expect((await job(again)).duplicateOfJobId).toBe(first);
    await mapped(a.owner, again);
    await step(A, again);
    expect(await code(confirm(a.owner, again))).toBe('RULE_VIOLATION');
    await confirm(a.owner, again, true);
    expect(await step(A, again)).toBe('completed');
    expect((await job(again)).rowsAttached).toBe(1); // open lead from the first run
  });
});

describe('uploader revocation, resume and cancel', () => {
  it('pauses before the next batch when the uploader loses access; resumes only for them, once restored', async () => {
    const before = await countLeads(A.orgId);
    const id = await readyImport(a.admin, A, bigCsv(5));
    await confirm(a.admin, id);
    const suspend = (status: 'SUSPENDED' | 'ACTIVE') =>
      migrator().member.update({ where: { id: A.membership.admin! }, data: { status } });
    expect(
      await step(A, id, {
        batchRows: 2,
        afterBatch: async (n) => {
          if (n === 0) await suspend('SUSPENDED');
        },
      }),
    ).toBe('paused');
    expect(await job(id)).toMatchObject({
      status: 'PAUSED',
      errorCode: 'UPLOADER_NOT_AUTHORIZED',
      nextRow: 2,
    });
    expect(await countLeads(A.orgId)).toBe(before + 2);
    // A paused job is never processed, as anyone.
    expect(await step(A, id)).toBe('noop');
    expect(await countLeads(A.orgId)).toBe(before + 2);
    // Only the uploader may resume (another Owner can only cancel).
    expect(await code(imports.resumeImport(a.owner.ctx, id))).toBe('FORBIDDEN');
    await suspend('ACTIVE');
    await imports.resumeImport(a.admin.ctx, id);
    expect(await step(A, id, { batchRows: 2 })).toBe('completed');
    expect(await job(id)).toMatchObject({ status: 'COMPLETED', nextRow: 5, rowsCreated: 5 });
    expect(await countLeads(A.orgId)).toBe(before + 5);
    const paused = await migrator().auditLog.findFirst({
      where: { entityId: id, action: 'import.paused' },
    });
    expect(paused).toMatchObject({ actorKind: 'SYSTEM', actorUserId: null });
  });

  it('if the uploader stays suspended, resuming is impossible and the job can be cancelled', async () => {
    const id = await readyImport(a.admin, A, bigCsv(3));
    await confirm(a.admin, id);
    await migrator().member.update({
      where: { id: A.membership.admin! },
      data: { status: 'SUSPENDED' },
    });
    try {
      expect(await step(A, id)).toBe('paused');
      expect((await job(id)).nextRow).toBe(0);
      expect(await code(imports.cancelImport(a.exec1.ctx, id))).toBe('FORBIDDEN');
      await imports.cancelImport(a.owner.ctx, id);
      expect(await job(id)).toMatchObject({ status: 'CANCELLED' });
    } finally {
      await migrator().member.update({
        where: { id: A.membership.admin! },
        data: { status: 'ACTIVE' },
      });
    }
  });

  it('cancelling during an import stops after the current batch; leads so far are kept', async () => {
    const before = await countLeads(A.orgId);
    const id = await readyImport(a.owner, A, bigCsv(6));
    await confirm(a.owner, id);
    expect(
      await step(A, id, {
        batchRows: 2,
        afterBatch: async (n) => {
          if (n === 0) await imports.cancelImport(a.admin.ctx, id);
        },
      }),
    ).toBe('cancelled');
    expect(await job(id)).toMatchObject({ status: 'CANCELLED', nextRow: 2 });
    expect(await countLeads(A.orgId)).toBe(before + 2);
    expect(await code(imports.cancelImport(a.owner.ctx, id))).toBe('RULE_VIOLATION');
  });
});

describe('cleanup sweep', () => {
  const expire = (id: string) =>
    migrator().importJob.update({
      where: { id },
      data: { purgeFileAfter: new Date(Date.now() - 60_000) },
    });

  it('deletes due files once, marks them, and ends abandoned jobs', async () => {
    const finished = await readyImport(a.owner, A, bigCsv(1), { dryRun: true });
    const waiting = await upload(a.owner, bigCsv(1));
    await step(A, waiting); // NEEDS_MAPPING
    const midStep = await upload(a.owner, bigCsv(1));
    await step(A, midStep);
    await mapped(a.owner, midStep); // VALIDATING, worker never ran
    // A finished job is already due (its file is kept until it finished) and frozen by the
    // guard trigger; only the unfinished ones are backdated here.
    for (const id of [waiting, midStep]) await expire(id);
    const keys = await Promise.all(
      [finished, waiting, midStep].map(async (id) => (await job(id)).storageKey),
    );

    const due = (await importFilesDue(500)).filter((d) =>
      [finished, waiting, midStep].includes(d.importJobId),
    );
    expect(due).toHaveLength(3);
    const r = await sweepImportFiles(due, storage);
    expect(r).toMatchObject({ deleted: 3, refused: 0, ended: 2, errors: 0 });
    for (const k of keys) expect(storage.objects.has(k)).toBe(false);
    expect(await job(finished)).toMatchObject({ status: 'COMPLETED' });
    expect((await job(finished)).fileDeletedAt).not.toBeNull();
    expect(await job(waiting)).toMatchObject({ status: 'EXPIRED', errorCode: 'FILE_EXPIRED' });
    expect(await job(midStep)).toMatchObject({ status: 'FAILED', errorCode: 'FILE_EXPIRED' });
    // Repeated sweeps are harmless.
    expect((await importFilesDue(500)).map((d) => d.importJobId)).not.toContain(finished);
    expect(await sweepImportFiles(due, storage)).toMatchObject({ deleted: 0, refused: 0 });
  });

  it('refuses due entries whose key does not belong to the org and job, and deletes nothing', async () => {
    const id = await upload(a.owner, bigCsv(1));
    const j = await job(id);
    const otherJob = await upload(ownerB, bigCsv(1));
    const forged = [
      { orgId: B.orgId, importJobId: id, storageKey: j.storageKey },
      { orgId: A.orgId, importJobId: otherJob, storageKey: j.storageKey },
      { orgId: B.orgId, importJobId: otherJob, storageKey: j.storageKey.replace(A.orgId, B.orgId) },
      // Well-formed for B's job, but not the key recorded on that job.
      {
        orgId: B.orgId,
        importJobId: otherJob,
        storageKey: (await job(otherJob)).storageKey.replace(
          /[0-9a-f]{32}\.csv$/,
          `${'0'.repeat(32)}.csv`,
        ),
      },
    ];
    await expire(id);
    const r = await sweepImportFiles(forged, storage);
    expect(r).toMatchObject({ deleted: 0, refused: 4 });
    expect(storage.objects.has(j.storageKey)).toBe(true);
    await imports.cancelImport(a.owner.ctx, id);
    await imports.cancelImport(ownerB.ctx, otherJob);
  });
});

describe('cross-organisation isolation', () => {
  it("another org's Owner cannot see or act on an import", async () => {
    const id = await upload(a.owner, bigCsv(1));
    await step(A, id);
    // Each call starts only when awaited: created all at once, the later rejections were
    // reported as unhandled while the earlier ones were still being awaited.
    for (const call of [
      () => imports.getImport(ownerB.ctx, id),
      () => imports.listImportIssues(ownerB.ctx, id),
      () => imports.cancelImport(ownerB.ctx, id),
      () => imports.resumeImport(ownerB.ctx, id),
      () => imports.confirmUpload(ownerB.ctx, id, storage),
      () => imports.chooseSheet(ownerB.ctx, id, { sheet: 'x', version: 1 }),
      () => imports.confirmImport(ownerB.ctx, id, { attest: true, version: 1 }),
    ])
      expect(await code(call())).toBe('NOT_FOUND');
    expect((await imports.listImports(ownerB.ctx)).map((i) => i.id)).not.toContain(id);
    // The worker step runs in the job's own org only: B's org id finds nothing.
    expect(await processImportJob(B.orgId, id, deps())).toBe('noop');
    expect((await job(id)).status).toBe('NEEDS_MAPPING');
    await imports.cancelImport(a.owner.ctx, id);
  });
});
