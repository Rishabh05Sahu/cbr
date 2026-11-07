// M6 acceptance, end to end: imports through the BUILT web server and the real worker with the
// import commit strategy selected for the run (E2E_IMPORT_COMMIT_STRATEGY=set for the set-based
// acceptance; tests/e2e/server.ts). The same assertions hold for 'row'. Fake storage
// (./fake-storage) and synthetic data only. Every check reads the persisted state (import job,
// row results, leads, enquiries, cases, spells, notifications), not only HTTP replies.
//
// Scenarios (docs/PHASE-2-M6-LOAD-TEST-PLAN.md §10):
//   1 corpus files reconcile with pilot/synthetic-corpus/manifest.json   2 malformed rows
//   3 existing leads, duplicate phones and e-mails   4 required custom fields (validation and
//   commit time)   5 re-upload   6 worker crash and recovery   7 concurrency   8 round-robin and
//   notifications   9 other orgs and roles   10 row results = database records
import { createHash } from 'node:crypto';
import { readFileSync } from 'node:fs';
import { beforeAll, describe, expect, inject, it } from 'vitest';
import * as leads from '@/modules/leads';
import * as teams from '@/modules/teams';
import { migrator } from '../support/db';
import { actorIn, PASSWORD, seedOrg, type Actor } from '../support/factory';
import * as corpus from '../support/import-corpus';
import * as S from '../support/synthetic-data';
import { Browser } from './http';
import { WORKER_PID_FILE } from './server';

const I = 'src/modules/imports/actions.ts';
const IMPORTS = '/app/leads/import';
const TYPES = {
  csv: 'text/csv',
  xlsx: 'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet',
} as const;

type Org = Awaited<ReturnType<typeof seedOrg>>;
interface File {
  name: string;
  type: 'csv' | 'xlsx';
  bytes: Uint8Array;
  sheet?: string;
}
interface Manifest {
  files: { name: string; sha256: string; expected: Record<string, number> }[];
}
const manifest = JSON.parse(
  readFileSync('pilot/synthetic-corpus/manifest.json', 'utf8'),
) as Manifest;
const corpusFile = (name: string): File => {
  const f = corpus.corpusFiles().find((x) => x.name === name)!;
  const bytes = f.bytes();
  // The test uses exactly the reviewed corpus file.
  expect(createHash('sha256').update(bytes).digest('hex')).toBe(
    manifest.files.find((m) => m.name === name)!.sha256,
  );
  return {
    name,
    type: name.endsWith('.xlsx') ? 'xlsx' : 'csv',
    bytes,
    ...('sheet' in f ? { sheet: f.sheet as string } : {}),
  };
};
const expected = (name: string) => manifest.files.find((m) => m.name === name)!.expected;

const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));

async function browserFor(user: { email: string }, orgId: string): Promise<Browser> {
  const b = new Browser();
  expect((await b.signIn(user.email, PASSWORD)).status).toBe(200);
  expect((await b.authPost('/organization/set-active', { organizationId: orgId })).status).toBe(
    200,
  );
  return b;
}

const job = (id: string) => migrator().importJob.findUniqueOrThrow({ where: { id } });

async function waitForJob(
  id: string,
  ok: (j: Awaited<ReturnType<typeof job>>) => boolean,
  ms = 90_000,
) {
  const until = Date.now() + ms;
  let j = await job(id);
  while (Date.now() < until) {
    if (ok(j)) return j;
    await sleep(200);
    j = await job(id);
  }
  throw new Error(`import ${id} stayed ${j.status} (next_row ${j.nextRow})`);
}
const DONE = ['COMPLETED', 'COMPLETED_WITH_ERRORS', 'FAILED', 'CANCELLED'];

interface ImportOpts {
  duplicatePolicy?: 'ATTACH' | 'SKIP';
  assignment?: unknown;
  /** Stop when READY (the caller confirms). */
  stopAtReady?: boolean;
}

/** Upload → verify → analyse (→ sheet) → map (suggested) → validate → confirm → import. */
async function runImport(b: Browser, file: File, o: ImportOpts = {}) {
  const started = await b.call(IMPORTS, I, 'startImportAction', [
    { fileName: file.name, size: file.bytes.byteLength, type: TYPES[file.type] },
  ]);
  expect(started).toMatchObject({ status: 200, ok: true });
  const { importId: id, upload } = started.data as {
    importId: string;
    upload: { url: string; headers: Record<string, string> };
  };
  const put = await fetch(upload.url, {
    method: 'PUT',
    headers: upload.headers,
    body: new Uint8Array(file.bytes),
  });
  expect(put.status).toBe(200);
  expect(await b.call(`${IMPORTS}/${id}`, I, 'confirmUploadAction', [id])).toMatchObject({
    ok: true,
  });
  let j = await waitForJob(id, (x) => x.status === 'NEEDS_MAPPING' || DONE.includes(x.status));
  expect(j.status).toBe('NEEDS_MAPPING');
  if (file.sheet && j.sheetName !== file.sheet) {
    expect(
      await b.call(`${IMPORTS}/${id}`, I, 'chooseSheetAction', [
        id,
        { sheet: file.sheet, version: j.version },
      ]),
    ).toMatchObject({ ok: true });
    j = await waitForJob(id, (x) => x.status === 'NEEDS_MAPPING' && x.sheetName === file.sheet);
  }
  expect(
    await b.call(`${IMPORTS}/${id}`, I, 'submitMappingAction', [
      id,
      {
        mapping: j.mapping,
        duplicatePolicy: o.duplicatePolicy ?? 'ATTACH',
        assignment: o.assignment ?? { mode: 'none' },
        dryRun: false,
        version: j.version,
      },
    ]),
  ).toMatchObject({ ok: true });
  j = await waitForJob(id, (x) => x.status === 'READY' || DONE.includes(x.status));
  expect(j.status).toBe('READY');
  if (o.stopAtReady) return id;
  expect(await confirm(b, id)).toMatchObject({ ok: true });
  await waitForJob(id, (x) => DONE.includes(x.status), 600_000);
  return id;
}

async function confirm(b: Browser, id: string, acknowledgeDuplicateFile?: boolean) {
  const v = (await job(id)).version;
  return b.call(`${IMPORTS}/${id}`, I, 'confirmImportAction', [
    id,
    { attest: true, version: v, ...(acknowledgeDuplicateFile ? { acknowledgeDuplicateFile } : {}) },
  ]);
}

const results = (id: string, phase?: 'VALIDATE' | 'IMPORT') =>
  migrator().importRowResult.findMany({
    where: { importJobId: id, ...(phase ? { phase } : {}) },
    orderBy: [{ rowNumber: 'asc' }, { field: 'asc' }],
  });
const enquiriesOf = (orgId: string, id: string) =>
  migrator().leadEnquiry.findMany({
    where: { orgId, externalId: { startsWith: `${id}:` }, channelRef: 'IMPORT' },
  });
const dupOpenPhones = async (orgId: string) =>
  (
    await migrator().$queryRaw<{ n: number }[]>`
      SELECT count(*)::int n FROM (
        SELECT primary_phone_e164 FROM lead
         WHERE org_id = ${orgId}::uuid AND stage NOT IN ('WON','LOST')
           AND deleted_at IS NULL AND merged_into_lead_id IS NULL
         GROUP BY 1 HAVING count(*) > 1) d`
  )[0]!.n;

/**
 * Scenario 10: the job's counters, its row results and the database agree, and match the
 * manifest's expectations for the file.
 */
async function reconcile(orgId: string, id: string, exp: Record<string, number>) {
  const j = await job(id);
  expect(j).toMatchObject({
    rowsTotal: exp.total,
    rowsValid: exp.valid,
    rowsInvalid: exp.invalid,
    rowsEmpty: exp.empty,
    rowsDuplicateInFile: exp.duplicateInFile,
    nextRow: exp.total,
  });
  // Every valid row has exactly one commit outcome.
  expect(j.rowsCreated + j.rowsAttached + j.rowsSkipped + j.rowsFailed).toBe(exp.valid);
  const rr = await results(id);
  const rowsWith = (phase: string, outcome: string) =>
    new Set(rr.filter((r) => r.phase === phase && r.outcome === outcome).map((r) => r.rowNumber))
      .size;
  expect(rowsWith('VALIDATE', 'INVALID')).toBe(exp.invalid);
  expect(rowsWith('VALIDATE', 'DUPLICATE_IN_FILE')).toBe(exp.duplicateInFile);
  expect(rowsWith('IMPORT', 'DUPLICATE_ATTACHED')).toBe(j.rowsAttached);
  expect(rowsWith('IMPORT', 'DUPLICATE_SKIPPED')).toBe(j.rowsSkipped);
  expect(rowsWith('IMPORT', 'FAILED')).toBe(j.rowsFailed);
  // One enquiry per created or attached row, keyed by row (no duplicates after any retry).
  const enq = await enquiriesOf(orgId, id);
  expect(enq).toHaveLength(j.rowsCreated + j.rowsAttached);
  expect(new Set(enq.map((e) => e.externalId)).size).toBe(enq.length);
  // Created leads are exactly the leads whose first enquiry came from this import.
  const created = await migrator().lead.count({
    where: {
      orgId,
      enquiries: { some: { externalId: { startsWith: `${id}:` } } },
      createdAt: { gte: j.createdAt },
    },
  });
  expect(created).toBeGreaterThanOrEqual(j.rowsCreated);
  // Attached rows point at the lead their enquiry went to.
  for (const r of rr.filter((x) => x.phase === 'IMPORT' && x.outcome === 'DUPLICATE_ATTACHED')) {
    const e = enq.find((x) => x.externalId === `${id}:${r.rowNumber}`);
    expect(e?.leadId).toBe(r.leadId);
  }
  expect(await dupOpenPhones(orgId)).toBe(0);
  return j;
}

const strategy = inject('importCommitStrategy');

describe(`import acceptance over HTTP (worker strategy: ${strategy})`, () => {
  it('runs with the worker strategy the run selected', () => {
    expect(strategy).toBe(process.env.E2E_IMPORT_COMMIT_STRATEGY || 'set');
  });

  // ---- 1, 2, 4, 10: corpus files ---------------------------------------------------------
  describe('corpus files reconcile with the manifest', () => {
    let A: Org;
    let owner: Browser;
    beforeAll(async () => {
      A = await seedOrg('E2ESetCorpus');
      owner = await browserFor(A.users.owner, A.orgId);
    });

    it('corpus_variants.csv: 500 rows, header and value variants, all created', async () => {
      const before = await migrator().lead.count({ where: { orgId: A.orgId } });
      const id = await runImport(owner, corpusFile('corpus_variants.csv'));
      const j = await reconcile(A.orgId, id, expected('corpus_variants.csv'));
      expect(j).toMatchObject({ status: 'COMPLETED', rowsCreated: 500, rowsFailed: 0 });
      expect(await migrator().lead.count({ where: { orgId: A.orgId } })).toBe(before + 500);
    }, 300_000);

    it('corpus_multisheet.xlsx, sheet "Leads Q4": 150 rows after choosing the sheet', async () => {
      const id = await runImport(owner, corpusFile('corpus_multisheet.xlsx'));
      const j = await reconcile(A.orgId, id, expected('corpus_multisheet.xlsx'));
      expect(j).toMatchObject({ sheetName: 'Leads Q4', rowsCreated: 150 });
    }, 300_000);

    it('corpus_custom_fields.csv: stable row-level codes for every malformed row', async () => {
      const C = await seedOrg('E2ESetCustom');
      const ownerC = await actorIn(C.users.owner, C.orgId);
      for (const d of corpus.CORPUS_CUSTOM_FIELDS)
        await leads.createCustomField(ownerC.ctx, { ...d });
      const b = await browserFor(C.users.owner, C.orgId);
      const id = await runImport(b, corpusFile('corpus_custom_fields.csv'));
      const j = await reconcile(C.orgId, id, expected('corpus_custom_fields.csv'));
      expect(j).toMatchObject({ status: 'COMPLETED_WITH_ERRORS', rowsCreated: 3 });
      // Exactly the issues the corpus defines, row by row (spreadsheet row = case + 1).
      const want: { row: number; outcome: string; field: string; code: string }[] = [];
      for (const r of corpus.customFieldRows()) {
        if (r.expect.kind === 'INVALID')
          for (const [field, code] of r.expect.issues)
            want.push({ row: r.n + 1, outcome: 'INVALID', field, code });
        if (r.expect.kind === 'DUPLICATE_IN_FILE')
          want.push({
            row: r.n + 1,
            outcome: 'DUPLICATE_IN_FILE',
            field: 'primaryPhone',
            code: 'DUPLICATE_IN_FILE',
          });
      }
      const got = (await results(id, 'VALIDATE')).map((r) => ({
        row: r.rowNumber,
        outcome: r.outcome,
        field: r.field!,
        code: r.code,
      }));
      const key = (x: (typeof want)[number]) => `${x.row}|${x.outcome}|${x.field}|${x.code}`;
      expect(got.map(key).sort()).toEqual(want.map(key).sort());
      // The duplicate names its first row; nothing was written for invalid rows.
      const dup = (await results(id, 'VALIDATE')).find((r) => r.outcome === 'DUPLICATE_IN_FILE');
      expect(dup?.relatedRow).toBe(2);
      // Valid rows carry their typed custom values.
      const created = await migrator().lead.findMany({
        where: { orgId: C.orgId, enquiries: { some: { externalId: { startsWith: `${id}:` } } } },
      });
      expect(created).toHaveLength(3);
      for (const l of created)
        expect((l.customFields as Record<string, unknown>).site_city).toEqual(expect.any(String));
    }, 300_000);
  });

  // ---- 3: existing leads, duplicate phones and e-mails -----------------------------------
  describe('existing leads, duplicate phones and e-mails', () => {
    let D: Org;
    let X: Org;
    let owner: Browser;
    let exec1: Actor;
    const ph = (n: number) => S.syntheticMobile(8, n, 7);
    const lead = async (
      orgId: string,
      n: number,
      o: { stage?: 'NEW' | 'LOST'; archived?: boolean; email?: string; ownerUserId?: string } = {},
    ) => {
      const source = (await migrator().leadSource.findFirst({ where: { orgId } }))!.id;
      return migrator().lead.create({
        data: {
          orgId,
          fullName: `Existing ${n}`,
          primaryPhoneE164: `+91${ph(n)}`,
          primaryPhoneRaw: ph(n),
          phoneLast10: ph(n),
          email: o.email ?? null,
          sourceId: source,
          stage: o.stage ?? 'NEW',
          ...(o.stage === 'LOST' ? { lostAt: new Date() } : {}),
          ...(o.archived ? { archivedAt: new Date() } : {}),
          ...(o.ownerUserId ? { ownerUserId: o.ownerUserId } : {}),
          createdAt: new Date(Date.now() - 86_400_000),
        },
      });
    };

    beforeAll(async () => {
      D = await seedOrg('E2ESetDup');
      X = await seedOrg('E2ESetDupOther');
      for (const o of [D, X])
        await migrator().leadSource.create({
          data: { orgId: o.orgId, name: 'Seeded', channel: 'PORTAL' },
        });
      owner = await browserFor(D.users.owner, D.orgId);
      exec1 = await actorIn(D.users.exec1, D.orgId);
    });

    it('attaches to open leads without changing them, links returning customers, opens e-mail cases; other orgs never match', async () => {
      const open = await lead(D.orgId, 1, {
        email: 'dup.one@example.test',
        ownerUserId: D.users.exec1.id,
      });
      const archived = await lead(D.orgId, 2, { archived: true });
      const closed = await lead(D.orgId, 3, { stage: 'LOST' });
      const elsewhere = await lead(X.orgId, 4, { email: 'dup.two@example.test' });
      // The spell an owned lead always has (M3).
      await migrator().$executeRaw`
        INSERT INTO lead_assignment_history (org_id, lead_id, user_id, started_at, source)
        VALUES (${D.orgId}::uuid, ${open.id}::uuid, ${D.users.exec1.id}::uuid, now(), 'BULK')`;
      const snapshot = async () =>
        Promise.all(
          [open.id, archived.id, closed.id, elsewhere.id].map((id) =>
            migrator().lead.findUniqueOrThrow({ where: { id } }),
          ),
        );
      const before = await snapshot();
      const file: File = {
        name: 'dups.csv',
        type: 'csv',
        bytes: corpus.csv([
          ['Name', 'Mobile', 'Email'],
          ['Row Two', ph(1), ''], // row 2: open lead → attached
          ['Row Three', ph(2), ''], // row 3: archived open lead → attached, review case
          ['Row Four', ph(3), ''], // row 4: closed lead → new lead, returning customer
          ['Row Five', ph(4), 'dup.two@example.test'], // row 5: other org's phone and e-mail → new
          ['Row Six', ph(6), 'DUP.ONE@example.test'], // row 6: e-mail of the open lead → case
          ['Row Seven', ph(7), 'shared.new@example.test'], // rows 7, 8: same new e-mail → case
          ['Row Eight', ph(8), 'Shared.New@example.test'],
        ]),
      };
      const id = await runImport(owner, file);
      const j = await reconcile(D.orgId, id, {
        total: 7,
        valid: 7,
        invalid: 0,
        empty: 0,
        duplicateInFile: 0,
      });
      expect(j).toMatchObject({ rowsCreated: 5, rowsAttached: 2 });
      const rr = await results(id, 'IMPORT');
      expect(rr.map((r) => [r.rowNumber, r.outcome, r.leadId])).toEqual([
        [2, 'DUPLICATE_ATTACHED', open.id],
        [3, 'DUPLICATE_ATTACHED', archived.id],
      ]);
      // Attaching never overwrites the existing leads (every column identical).
      expect(await snapshot()).toEqual(before);
      // The archived lead stays archived; its enquiry waits for a decision.
      expect(
        await migrator().leadDuplicateMatch.count({
          where: {
            orgId: D.orgId,
            leadId: archived.id,
            matchType: 'ARCHIVED_ENQUIRY',
            status: 'OPEN',
          },
        }),
      ).toBe(1);
      const byRow = async (row: number) =>
        (await migrator().leadEnquiry.findFirstOrThrow({ where: { externalId: `${id}:${row}` } }))
          .leadId;
      // Returning customer: the new lead links to the closed one.
      expect(
        (await migrator().lead.findUniqueOrThrow({ where: { id: await byRow(4) } })).previousLeadId,
      ).toBe(closed.id);
      // Another org's lead with the same phone and e-mail is invisible: new lead, no case.
      const five = await byRow(5);
      expect(five).not.toBe(elsewhere.id);
      expect(await migrator().leadDuplicateMatch.count({ where: { leadId: five } })).toBe(0);
      // E-mail cases: row 6 with the open lead; row 8 with row 7 (case-insensitive).
      const pair = async (a: string, b: string) =>
        migrator().leadDuplicateMatch.count({
          where: {
            orgId: D.orgId,
            matchType: 'EMAIL',
            OR: [
              { leadId: a, candidateLeadId: b },
              { leadId: b, candidateLeadId: a },
            ],
          },
        });
      expect(await pair(await byRow(6), open.id)).toBe(1);
      expect(await pair(await byRow(8), await byRow(7))).toBe(1);
      // The open lead's owner hears about the returning enquiry (worker → notification).
      const until = Date.now() + 30_000;
      let n = 0;
      while (Date.now() < until && n === 0) {
        n = await migrator().notification.count({
          where: { orgId: D.orgId, recipientUserId: exec1.user.id, type: 'LEAD_RETURNING_ENQUIRY' },
        });
        if (n === 0) await sleep(300);
      }
      expect(n).toBe(1);
    }, 300_000);

    it('SKIP policy: a matching row is skipped and writes nothing', async () => {
      const open = await lead(D.orgId, 20);
      const enquiriesBefore = await migrator().leadEnquiry.count({ where: { leadId: open.id } });
      const id = await runImport(
        owner,
        {
          name: 'skip.csv',
          type: 'csv',
          bytes: corpus.csv([
            ['Name', 'Mobile'],
            ['Skip Me', ph(20)],
            ['New One', ph(21)],
          ]),
        },
        { duplicatePolicy: 'SKIP' },
      );
      const j = await reconcile(D.orgId, id, {
        total: 2,
        valid: 2,
        invalid: 0,
        empty: 0,
        duplicateInFile: 0,
      });
      expect(j).toMatchObject({ rowsSkipped: 1, rowsCreated: 1 });
      expect(await migrator().leadEnquiry.count({ where: { leadId: open.id } })).toBe(
        enquiriesBefore,
      );
    }, 300_000);
  });

  // ---- 4 (commit time): a required field added after validation -------------------------
  it('a required custom field added after validation fails the rows at commit, nothing written', async () => {
    const R = await seedOrg('E2ESetRequired');
    const b = await browserFor(R.users.owner, R.orgId);
    const ownerR = await actorIn(R.users.owner, R.orgId);
    const rows = [1, 2, 3].map((n) => [`Required ${n}`, S.syntheticMobile(8, 100 + n, 8)]);
    const id = await runImport(
      b,
      { name: 'req.csv', type: 'csv', bytes: corpus.csv([['Name', 'Mobile'], ...rows]) },
      { stopAtReady: true },
    );
    await leads.createCustomField(ownerR.ctx, {
      key: 'site_city',
      label: 'Site City',
      type: 'text',
      required: true,
    });
    expect(await confirm(b, id)).toMatchObject({ ok: true });
    const j = await waitForJob(id, (x) => DONE.includes(x.status));
    expect(j).toMatchObject({ status: 'COMPLETED_WITH_ERRORS', rowsCreated: 0, rowsFailed: 3 });
    const failed = await results(id, 'IMPORT');
    expect(failed.map((r) => [r.rowNumber, r.outcome, r.field, r.code])).toEqual([
      [2, 'FAILED', 'CF_site_city', 'CUSTOM_FIELD_REQUIRED'],
      [3, 'FAILED', 'CF_site_city', 'CUSTOM_FIELD_REQUIRED'],
      [4, 'FAILED', 'CF_site_city', 'CUSTOM_FIELD_REQUIRED'],
    ]);
    expect(await migrator().lead.count({ where: { orgId: R.orgId } })).toBe(0);
  }, 300_000);

  // ---- 5: re-upload -----------------------------------------------------------------------
  it('re-uploading the same file: flagged, refused without acknowledgement, then attaches only', async () => {
    const U = await seedOrg('E2ESetReupload');
    const b = await browserFor(U.users.owner, U.orgId);
    const file = corpusFile('corpus_variants.csv');
    const first = await runImport(b, file);
    await reconcile(U.orgId, first, expected('corpus_variants.csv'));
    const leadsAfterFirst = await migrator().lead.count({ where: { orgId: U.orgId } });

    const second = await runImport(b, file, { stopAtReady: true });
    expect((await job(second)).duplicateOfJobId).toBe(first);
    expect(await confirm(b, second)).toMatchObject({ ok: false, code: 'RULE_VIOLATION' });
    expect(await confirm(b, second, true)).toMatchObject({ ok: true });
    await waitForJob(second, (x) => DONE.includes(x.status), 600_000);
    const j = await reconcile(U.orgId, second, expected('corpus_variants.csv'));
    expect(j).toMatchObject({ rowsCreated: 0, rowsAttached: 500 });
    expect(await migrator().lead.count({ where: { orgId: U.orgId } })).toBe(leadsAfterFirst);
  }, 600_000);

  // ---- 6: worker crash and recovery --------------------------------------------------------
  it('a worker killed mid-import: committed batches stay, the rest completes once, no duplicates', async () => {
    const K = await seedOrg('E2ESetCrash');
    const b = await browserFor(K.users.owner, K.orgId);
    const ROWS = 6000;
    const bytes = corpus.csv([
      ['Name', 'Mobile', 'Email'],
      ...Array.from({ length: ROWS }, (_, i) => [
        `Crash Row ${i}`,
        S.syntheticMobile(9, i, 3),
        i % 2 ? `crash.${i}@example.test` : '',
      ]),
    ]);
    const id = await runImport(b, { name: 'crash.csv', type: 'csv', bytes }, { stopAtReady: true });
    expect(await confirm(b, id)).toMatchObject({ ok: true });
    // Kill the worker after the first committed batch, before the last.
    await waitForJob(id, (x) => x.nextRow > 0 || DONE.includes(x.status), 120_000);
    const pid = Number(readFileSync(WORKER_PID_FILE, 'utf8'));
    const atKill = await job(id);
    expect(atKill.status).toBe('IMPORTING'); // otherwise the file was too small to interrupt
    process.kill(pid, 'SIGKILL');
    await sleep(2000); // the dead connection's open batch is rolled back by Postgres
    const frozen = await job(id);
    // Progress is atomic with the leads: committed rows = cursor, in whole batches.
    expect(frozen.nextRow % 200 === 0 || frozen.nextRow === ROWS).toBe(true);
    expect(await enquiriesOf(K.orgId, id)).toHaveLength(frozen.nextRow);
    // The supervisor starts a replacement; the queue redelivers the stalled step after its lock.
    expect(Number(readFileSync(WORKER_PID_FILE, 'utf8'))).not.toBe(pid);
    const done = await waitForJob(id, (x) => DONE.includes(x.status), 420_000);
    expect(done.status).toBe('COMPLETED');
    await reconcile(K.orgId, id, {
      total: ROWS,
      valid: ROWS,
      invalid: 0,
      empty: 0,
      duplicateInFile: 0,
    });
    expect(done.rowsCreated).toBe(ROWS);
    expect(await migrator().lead.count({ where: { orgId: K.orgId } })).toBe(ROWS);
  }, 600_000);

  // ---- 7: concurrency ----------------------------------------------------------------------
  describe('concurrency', () => {
    const file = (name: string, from: number, n: number, block: 6 | 7 | 8 | 9 = 7): File => ({
      name,
      type: 'csv',
      bytes: corpus.csv([
        ['Name', 'Mobile', 'Email'],
        ...Array.from({ length: n }, (_, k) => [
          `Concurrent ${from + k}`,
          S.syntheticMobile(block, from + k, 4),
          `conc.${from + k}@example.test`,
        ]),
      ]),
    });

    it('one import runs per organisation: a second confirmation is refused, then succeeds later', async () => {
      const O = await seedOrg('E2ESetOneRunning');
      const b = await browserFor(O.users.owner, O.orgId);
      const x = await runImport(b, file('x.csv', 0, 3000), { stopAtReady: true });
      const y = await runImport(b, file('y.csv', 3000, 50), { stopAtReady: true });
      const [cx, cy] = await Promise.all([confirm(b, x), confirm(b, y)]);
      expect([cx.ok, cy.ok].filter(Boolean)).toHaveLength(1);
      expect([cx, cy].find((c) => !c.ok)).toMatchObject({ code: 'CONFLICT' });
      const loser = cx.ok ? y : x;
      await waitForJob(cx.ok ? x : y, (j) => DONE.includes(j.status), 300_000);
      expect(await confirm(b, loser)).toMatchObject({ ok: true });
      await waitForJob(loser, (j) => DONE.includes(j.status), 300_000);
      expect(await migrator().lead.count({ where: { orgId: O.orgId } })).toBe(3050);
      expect(await dupOpenPhones(O.orgId)).toBe(0);
    }, 600_000);

    it('two organisations import overlapping phones and e-mails at once: each gets its own leads', async () => {
      const [P, Q] = [await seedOrg('E2ESetConcP'), await seedOrg('E2ESetConcQ')];
      const [bp, bq] = [
        await browserFor(P.users.owner, P.orgId),
        await browserFor(Q.users.owner, Q.orgId),
      ];
      const f = file('same.csv', 5000, 2000);
      const [p, q] = await Promise.all([
        runImport(bp, f, { stopAtReady: true }),
        runImport(bq, f, { stopAtReady: true }),
      ]);
      await Promise.all([confirm(bp, p), confirm(bq, q)]);
      await Promise.all([
        waitForJob(p, (j) => DONE.includes(j.status), 300_000),
        waitForJob(q, (j) => DONE.includes(j.status), 300_000),
      ]);
      for (const [o, id] of [
        [P, p],
        [Q, q],
      ] as const) {
        const j = await reconcile(o.orgId, id, {
          total: 2000,
          valid: 2000,
          invalid: 0,
          empty: 0,
          duplicateInFile: 0,
        });
        expect(j.rowsCreated).toBe(2000);
        expect(await migrator().leadDuplicateMatch.count({ where: { orgId: o.orgId } })).toBe(0);
      }
    }, 600_000);

    it('manual creates racing an import for the same phones: exactly one lead per phone', async () => {
      const M = await seedOrg('E2ESetRace');
      const b = await browserFor(M.users.owner, M.orgId);
      const admin = await actorIn(M.users.admin, M.orgId);
      const N = 2000;
      const id = await runImport(b, file('race.csv', 9000, N), { stopAtReady: true });
      const raced = Array.from({ length: 40 }, (_, k) => 9000 + k * 50);
      expect(await confirm(b, id)).toMatchObject({ ok: true });
      const manual = await Promise.all(
        raced.map((n) =>
          leads.createLead(admin.ctx, {
            fullName: `Manual ${n}`,
            primaryPhone: S.syntheticMobile(7, n, 4),
          }),
        ),
      );
      await waitForJob(id, (j) => DONE.includes(j.status), 300_000);
      const j = await reconcile(M.orgId, id, {
        total: N,
        valid: N,
        invalid: 0,
        empty: 0,
        duplicateInFile: 0,
      });
      const manualCreated = manual.filter((r) => r.status === 'created').length;
      expect(j.rowsCreated + j.rowsAttached).toBe(N);
      expect(j.rowsAttached).toBe(manualCreated);
      expect(await migrator().lead.count({ where: { orgId: M.orgId } })).toBe(N);
    }, 600_000);
  });

  // ---- 8: round-robin assignment and notifications ---------------------------------------
  it('round-robin import: owners in turn, spells and one digest per assignee', async () => {
    const T = await seedOrg('E2ESetRoundRobin');
    const ownerT = await actorIn(T.users.owner, T.orgId);
    const team = (await teams.createTeam(ownerT.ctx, { name: 'North' })).id;
    const members = ['manager', 'exec1', 'exec2'] as const;
    for (const m of members)
      await teams.addTeamMember(ownerT.ctx, {
        teamId: team,
        membershipId: T.membership[m]!,
        teamRole: 'MEMBER',
      });
    const b = await browserFor(T.users.owner, T.orgId);
    const rows = Array.from({ length: 9 }, (_, k) => [`Robin ${k}`, S.syntheticMobile(6, k, 5)]);
    const id = await runImport(
      b,
      { name: 'rr.csv', type: 'csv', bytes: corpus.csv([['Name', 'Mobile'], ...rows]) },
      { assignment: { mode: 'round_robin', teamId: team } },
    );
    await reconcile(T.orgId, id, { total: 9, valid: 9, invalid: 0, empty: 0, duplicateInFile: 0 });
    const created = await migrator().lead.findMany({
      where: { orgId: T.orgId },
      include: { assignments: true },
    });
    const perOwner = new Map<string, number>();
    for (const l of created) {
      expect(l).toMatchObject({ stage: 'ASSIGNED', teamId: team });
      expect(l.assignments).toMatchObject([
        { userId: l.ownerUserId, source: 'IMPORT', endedAt: null },
      ]);
      perOwner.set(l.ownerUserId!, (perOwner.get(l.ownerUserId!) ?? 0) + 1);
    }
    expect([...perOwner.values()].sort()).toEqual([3, 3, 3]);
    expect(new Set(perOwner.keys())).toEqual(new Set(members.map((m) => T.users[m].id)));
    const until = Date.now() + 30_000;
    let digests: { recipientUserId: string; data: unknown }[] = [];
    while (Date.now() < until && digests.length < 3) {
      digests = await migrator().notification.findMany({
        where: { orgId: T.orgId, type: 'LEADS_ASSIGNED_DIGEST' },
      });
      if (digests.length < 3) await sleep(300);
    }
    expect(digests.map((d) => [d.recipientUserId, d.data]).sort()).toEqual(
      members.map((m) => [T.users[m].id, { count: 3 }]).sort(),
    );
  }, 300_000);

  // ---- 9: other organisations and roles ----------------------------------------------------
  it('other organisations and non-importing roles can neither start nor see an import', async () => {
    const A = await seedOrg('E2ESetRolesA');
    const B = await seedOrg('E2ESetRolesB');
    const owner = await browserFor(A.users.owner, A.orgId);
    const id = await runImport(
      owner,
      {
        name: 'roles.csv',
        type: 'csv',
        bytes: corpus.csv([
          ['Name', 'Mobile'],
          ['Role Check', S.syntheticMobile(6, 999, 6)],
        ]),
      },
      { stopAtReady: true },
    );
    for (const role of ['manager', 'exec1', 'hr'] as const) {
      const b = await browserFor(A.users[role], A.orgId);
      expect(
        await b.call(IMPORTS, I, 'startImportAction', [
          { fileName: 'x.csv', size: 10, type: 'text/csv' },
        ]),
      ).toMatchObject({ ok: false, code: 'FORBIDDEN' });
      expect(await confirm(b, id)).toMatchObject({ ok: false });
    }
    const ownerB = await browserFor(B.users.owner, B.orgId);
    expect((await ownerB.get(`${IMPORTS}/${id}`)).status).toBe(404);
    expect(await confirm(ownerB, id)).toMatchObject({ ok: false, code: 'NOT_FOUND' });
    // Nothing ran: still READY, no lead anywhere.
    expect((await job(id)).status).toBe('READY');
    expect(await migrator().lead.count({ where: { orgId: { in: [A.orgId, B.orgId] } } })).toBe(0);
    expect(await owner.call(`${IMPORTS}/${id}`, I, 'cancelImportAction', [id])).toMatchObject({
      ok: true,
    });
  }, 300_000);
});
