// SYNTHETIC pilot fixture (tests/support/pilot-fixture.ts; not a brokerage export) through the
// real import job on crm_test: upload verification, analysis, sheet choice, suggested mapping,
// validation with existing-lead matches (primary and alternate phone), the ATTACH policy, the
// import itself, counts, row results, and no cell values in the problem report.
import { beforeAll, describe, expect, it } from 'vitest';
import * as imports from '@/modules/imports';
import { processImportJob } from '@/modules/imports/processor';
import * as leads from '@/modules/leads';
import { migrator } from '../support/db';
import { actorIn, seedOrg, type Actor } from '../support/factory';
import { memoryStorage, type MemoryStorage } from '../support/memory-storage';
import {
  expectedCounts,
  existingLeadPhones,
  fixtureCsv,
  fixtureRows,
  fixtureXlsx,
  type Variant,
} from '../support/pilot-fixture';

let org: Awaited<ReturnType<typeof seedOrg>>;
let owner: Actor;
let exec1: Actor;
let storage: MemoryStorage;
const existing: Record<Variant, string[]> = { csv: [], xlsx: [] };

const job = (id: string) => migrator().importJob.findUniqueOrThrow({ where: { id } });
const step = (id: string) => processImportJob(org.orgId, id, { storage });

beforeAll(async () => {
  storage = memoryStorage();
  org = await seedOrg('PilotFixture');
  owner = await actorIn(org.users.owner, org.orgId);
  exec1 = await actorIn(org.users.exec1, org.orgId);
  // The one named source the fixture uses; "Facebook Ads" deliberately does not exist.
  await migrator().leadSource.create({
    data: { orgId: org.orgId, name: 'Website', channel: 'WEBSITE' },
  });
  for (const v of ['csv', 'xlsx'] as const)
    for (const [i, p] of existingLeadPhones(v).entries()) {
      const r = await leads.createLead(exec1.ctx, {
        fullName: `Synthetic Existing ${v} ${i + 1}`,
        primaryPhone: p,
      });
      if (r.status !== 'created') throw new Error('fixture lead');
      existing[v].push(r.leadId);
    }
});

describe.each(['csv', 'xlsx'] as const)('synthetic pilot fixture through the job: %s', (v) => {
  it('imports with the expected counts, results and existing-lead matches, without leaking values', async () => {
    const body = v === 'csv' ? fixtureCsv() : fixtureXlsx();
    const name = `synthetic_pilot_leads.${v}`;
    const type =
      v === 'csv'
        ? 'text/csv'
        : 'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet';
    const s = await imports.startImport(
      owner.ctx,
      { fileName: name, size: body.byteLength, type },
      storage,
    );
    storage.browserPut(s.upload.url, body, s.upload.headers['content-type']!);
    await imports.confirmUpload(owner.ctx, s.importId, storage);
    const id = s.importId;
    expect(await step(id)).toBe('needs_mapping');

    if (v === 'xlsx') {
      const first = await job(id);
      expect(first.sheetNames).toEqual(['Read me', 'Leads']);
      expect(first.sheetName).toBe('Read me');
      expect(first.mapping).toEqual({}); // nothing on "Read me" looks like a lead column
      await imports.chooseSheet(owner.ctx, id, { sheet: 'Leads', version: first.version });
      expect(await step(id)).toBe('needs_mapping');
    }
    let j = await job(id);
    expect(j.sheetName).toBe(v === 'xlsx' ? 'Leads' : null);
    expect(j.rowsTotal).toBe(29);
    expect(Object.keys(j.mapping as object)).toHaveLength(v === 'csv' ? 17 : 18);
    expect(j.duplicateOfJobId).toBeNull();

    await imports.submitMapping(owner.ctx, id, {
      mapping: j.mapping,
      duplicatePolicy: 'ATTACH',
      assignment: { mode: 'none' },
      dryRun: false,
      version: j.version,
    });
    expect(await step(id)).toBe('ready');
    const want = expectedCounts(v);
    j = await job(id);
    expect({
      total: j.rowsTotal,
      valid: j.rowsValid,
      invalid: j.rowsInvalid,
      duplicateInFile: j.rowsDuplicateInFile,
      empty: j.rowsEmpty,
    }).toEqual({
      total: want.total,
      valid: want.valid,
      invalid: want.invalid,
      duplicateInFile: want.duplicateInFile,
      empty: want.empty,
    });
    expect((await imports.getImport(owner.ctx, id)).counts.existingDuplicates).toBe(want.existing);

    // Row results = exactly the fixture's expectations (row = case + 1).
    const expected: string[] = [];
    for (const fx of fixtureRows(v)) {
      const row = fx.n + 1;
      if (fx.expect.kind === 'INVALID')
        for (const [field, code] of fx.expect.issues)
          expected.push(`${row}|INVALID|${field}|${code}|-|-`);
      if (fx.expect.kind === 'DUPLICATE_IN_FILE')
        expected.push(
          `${row}|DUPLICATE_IN_FILE|primaryPhone|DUPLICATE_IN_FILE|${fx.expect.of + 1}|-`,
        );
    }
    expected.push(`28|DUPLICATE_ATTACHED|primaryPhone|EXISTING_LEAD|-|${existing[v][0]}`);
    expected.push(`29|DUPLICATE_ATTACHED|primaryPhone|EXISTING_LEAD|-|${existing[v][1]}`);
    const toKey = (i: imports.ImportIssue) =>
      `${i.row}|${i.outcome}|${i.field}|${i.code}|${i.relatedRow ?? '-'}|${i.leadId ?? '-'}`;
    const validation = await imports.listImportIssues(owner.ctx, id, { limit: 1000 });
    expect(validation.issues.map(toKey).sort()).toEqual(expected.sort());

    // Nothing written before confirmation; then the import as the uploader.
    const before = await migrator().lead.count({ where: { orgId: org.orgId } });
    await imports.confirmImport(owner.ctx, id, { attest: true, version: j.version });
    expect(await step(id)).toBe('completed');
    j = await job(id);
    expect(j).toMatchObject({
      status: 'COMPLETED_WITH_ERRORS',
      nextRow: 29,
      rowsCreated: want.valid - want.existing,
      rowsAttached: want.existing,
      rowsSkipped: 0,
      rowsFailed: 0,
    });
    expect(await migrator().lead.count({ where: { orgId: org.orgId } })).toBe(
      before + want.valid - want.existing,
    );
    // The existing leads received the enquiries; their own data was not overwritten.
    for (const [k, leadId] of existing[v].entries()) {
      const l = await migrator().lead.findUniqueOrThrow({
        where: { id: leadId },
        include: { enquiries: true },
      });
      expect(l.fullName).toBe(`Synthetic Existing ${v} ${k + 1}`);
      expect(l.enquiries.map((e) => e.externalId)).toContain(`${id}:${28 + k}`);
    }
    // A created lead carries its normalised fields (case 1).
    const c1 = await migrator().lead.findFirstOrThrow({
      where: { enquiries: { some: { externalId: `${id}:2` } } },
    });
    expect(c1).toMatchObject({
      createdBy: org.users.owner.id,
      transactionType: 'BUY',
      propertyType: 'APARTMENT',
      bhkMin: 2,
      preferredLanguage: 'hi',
      preferredLocalities: ['Baner', 'Wakad'],
    });
    expect(c1.budgetMin?.toFixed(2)).toBe('8500000.00');
    expect(c1.budgetMax?.toFixed(2)).toBe('12000000.00');

    // The problem report shows row numbers, headings and codes: no cell values.
    const after = await imports.listImportIssues(owner.ctx, id, { limit: 1000 });
    const report = JSON.stringify(after.issues) + (await imports.importIssuesCsv(owner.ctx, id));
    const secrets = new Set<string>();
    for (const fx of fixtureRows(v))
      for (const [col, val] of Object.entries(fx.values))
        if (
          val !== undefined &&
          ![
            'bhk',
            'purpose',
            'timeline',
            'intent',
            'txn',
            'ptype',
            'language',
            'contact',
            'city',
            'city2',
            'source',
          ].includes(col)
        )
          secrets.add(String(val));
    for (const extra of ['Facebook Ads', 'Penthouse']) secrets.add(extra);
    const leaked = [...secrets].filter((x) => x.length >= 4 && report.includes(x));
    expect(leaked).toEqual([]);
  });
});
