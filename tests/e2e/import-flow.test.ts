// Phase 2 M4 end to end, against the built server, the real worker (outbox → BullMQ → import
// step) and a local fake of the Supabase Storage API (./fake-storage): upload with a signed,
// single-use token, server-side verification, analysis, mapping, validation, confirmation,
// batched import, results page and problems CSV; plus role, anonymous and cross-org refusals
// over HTTP. Synthetic data only.
import { beforeAll, describe, expect, it } from 'vitest';
import { migrator } from '../support/db';
import { PASSWORD, seedOrg } from '../support/factory';
import { E2E_STORAGE_KEY, E2E_STORAGE_URL } from './fake-storage';
import { Browser } from './http';

const I = 'src/modules/imports/actions.ts';
const IMPORTS = '/app/leads/import';

let A: Awaited<ReturnType<typeof seedOrg>>;
let B: Awaited<ReturnType<typeof seedOrg>>;
let owner: Browser;

async function browserFor(user: { email: string }, orgId: string): Promise<Browser> {
  const b = new Browser();
  expect((await b.signIn(user.email, PASSWORD)).status).toBe(200);
  expect((await b.authPost('/organization/set-active', { organizationId: orgId })).status).toBe(
    200,
  );
  return b;
}

async function waitForStatus(id: string, wanted: string[], ms = 45_000) {
  const until = Date.now() + ms;
  let status = '';
  while (Date.now() < until) {
    status = (await migrator().importJob.findUniqueOrThrow({ where: { id } })).status;
    if (wanted.includes(status)) return status;
    await new Promise((r) => setTimeout(r, 300));
  }
  throw new Error(`import ${id} stayed ${status}, wanted ${wanted.join('/')}`);
}

const pageText = async (b: Browser, path: string) => {
  const res = await b.get(path);
  return { status: res.status, html: (await res.text()).replace(/<!-- -->/g, '') };
};

const SECRET_CELL = 'not-a-phone-SECRET-777';
const csv = (phones: string[]) =>
  new TextEncoder().encode(
    ['Name,Mobile', 'E2E One,' + phones[0], 'E2E Bad,' + SECRET_CELL, 'E2E Two,' + phones[1]].join(
      '\n',
    ) + '\n',
  );

beforeAll(async () => {
  A = await seedOrg('E2EImportA');
  B = await seedOrg('E2EImportB');
  owner = await browserFor(A.users.owner, A.orgId);
});

describe('import over HTTP', () => {
  it('upload → verify → analyse → map → validate → confirm → import, with results', async () => {
    const before = await migrator().lead.count({ where: { orgId: A.orgId } });
    const body = csv(['9701234561', '9701234562']);

    const started = await owner.call(IMPORTS, I, 'startImportAction', [
      { fileName: 'e2e.csv', size: body.byteLength, type: 'text/csv', orgId: B.orgId },
    ]);
    expect(started).toMatchObject({ status: 200, ok: true });
    const { importId, upload } = started.data as {
      importId: string;
      upload: { url: string; headers: Record<string, string> };
    };
    // One object in the caller's own org (a forged orgId field is ignored); no key in the reply.
    expect(upload.url.startsWith(`${E2E_STORAGE_URL}/storage/v1/object/upload/sign/`)).toBe(true);
    expect(upload.url).toContain(`orgs/${A.orgId}/imports/${importId}/`);
    expect(started.body).not.toContain(E2E_STORAGE_KEY);

    // The browser's direct PUT; the token is single-use and never allows an overwrite.
    const put = await fetch(upload.url, { method: 'PUT', headers: upload.headers, body });
    expect(put.status).toBe(200);
    const replay = await fetch(upload.url, { method: 'PUT', headers: upload.headers, body });
    expect(replay.status).toBe(400);

    const confirmed = await owner.call(`${IMPORTS}/${importId}`, I, 'confirmUploadAction', [
      importId,
    ]);
    expect(confirmed).toMatchObject({ ok: true });
    await waitForStatus(importId, ['NEEDS_MAPPING']);

    const mapPage = await pageText(owner, `${IMPORTS}/${importId}`);
    expect(mapPage.status).toBe(200);
    expect(mapPage.html).toContain('Map your columns');

    const job = await migrator().importJob.findUniqueOrThrow({ where: { id: importId } });
    expect(job.mapping).toEqual({ fullName: 0, primaryPhone: 1 });
    const mapped = await owner.call(`${IMPORTS}/${importId}`, I, 'submitMappingAction', [
      importId,
      {
        mapping: job.mapping,
        duplicatePolicy: 'ATTACH',
        assignment: { mode: 'none' },
        dryRun: false,
        version: job.version,
      },
    ]);
    expect(mapped).toMatchObject({ ok: true });
    await waitForStatus(importId, ['READY']);

    const ready = await pageText(owner, `${IMPORTS}/${importId}`);
    expect(ready.html).toContain('Ready to import');
    expect(ready.html).toContain('Import 2 rows');
    expect(ready.html).not.toContain(SECRET_CELL);
    // Nothing written before the confirmation.
    expect(await migrator().lead.count({ where: { orgId: A.orgId } })).toBe(before);

    const v = (await migrator().importJob.findUniqueOrThrow({ where: { id: importId } })).version;
    const noAttest = await owner.call(`${IMPORTS}/${importId}`, I, 'confirmImportAction', [
      importId,
      { attest: false, version: v },
    ]);
    expect(noAttest).toMatchObject({ ok: false, code: 'VALIDATION_FAILED' });
    const go = await owner.call(`${IMPORTS}/${importId}`, I, 'confirmImportAction', [
      importId,
      { attest: true, version: v },
    ]);
    expect(go).toMatchObject({ ok: true });
    // A replayed confirmation (double click) changes nothing.
    const again = await owner.call(`${IMPORTS}/${importId}`, I, 'confirmImportAction', [
      importId,
      { attest: true, version: v },
    ]);
    expect(again.ok).toBe(false);

    expect(await waitForStatus(importId, ['COMPLETED', 'COMPLETED_WITH_ERRORS'])).toBe(
      'COMPLETED_WITH_ERRORS',
    );
    expect(await migrator().lead.count({ where: { orgId: A.orgId } })).toBe(before + 2);
    const done = await migrator().importJob.findUniqueOrThrow({ where: { id: importId } });
    expect(done).toMatchObject({ rowsCreated: 2, rowsInvalid: 1, nextRow: 3 });

    const results = await pageText(owner, `${IMPORTS}/${importId}`);
    expect(results.html).toContain('Completed with problems');
    expect(results.html).toContain('New leads created');
    expect(results.html).not.toContain(SECRET_CELL);

    const issues = await owner.get(`${IMPORTS}/${importId}/issues.csv`);
    expect(issues.status).toBe(200);
    expect(issues.headers.get('content-type')).toMatch(/^text\/csv/);
    const text = await issues.text();
    expect(text).toMatch(/^Row,Column,Field,Outcome,Problem/);
    expect(text).toContain('3,Mobile,Phone,INVALID');
    expect(text).not.toContain(SECRET_CELL);
    expect(await migrator().importJob.count({ where: { id: importId } })).toBe(1);
  }, 120_000);

  it('roles, anonymous callers and another org are refused', async () => {
    const body = csv(['9701234571', '9701234572']);
    const started = await owner.call(IMPORTS, I, 'startImportAction', [
      { fileName: 'x.csv', size: body.byteLength, type: 'text/csv' },
    ]);
    const { importId } = started.data as { importId: string };

    const exec = await browserFor(A.users.exec1, A.orgId);
    expect(
      await exec.call(IMPORTS, I, 'startImportAction', [
        { fileName: 'x.csv', size: 10, type: 'text/csv' },
      ]),
    ).toMatchObject({ ok: false, code: 'FORBIDDEN' });
    expect((await exec.get(`${IMPORTS}/${importId}`)).status).toBe(404);

    const anon = new Browser();
    expect(await anon.call(IMPORTS, I, 'cancelImportAction', [importId])).toMatchObject({
      ok: false,
      code: 'UNAUTHENTICATED',
    });
    // The app proxy sends anonymous /app/* requests to sign-in before any handler runs.
    const anonCsv = await anon.get(`${IMPORTS}/${importId}/issues.csv`);
    expect([302, 303, 307]).toContain(anonCsv.status);
    expect(anonCsv.headers.get('location')).toMatch(/\/login/);

    const ownerB = await browserFor(B.users.owner, B.orgId);
    expect((await ownerB.get(`${IMPORTS}/${importId}`)).status).toBe(404);
    expect((await ownerB.get(`${IMPORTS}/${importId}/issues.csv`)).status).toBe(404);
    for (const name of ['cancelImportAction', 'confirmUploadAction', 'resumeImportAction'])
      expect(await ownerB.call(`${IMPORTS}/${importId}`, I, name, [importId])).toMatchObject({
        ok: false,
        code: 'NOT_FOUND',
      });
    expect((await migrator().importJob.findUniqueOrThrow({ where: { id: importId } })).status).toBe(
      'AWAITING_UPLOAD',
    );

    // An Admin of the same org can cancel; the uploader's import then refuses further steps.
    const admin = await browserFor(A.users.admin, A.orgId);
    expect(
      await admin.call(`${IMPORTS}/${importId}`, I, 'cancelImportAction', [importId]),
    ).toMatchObject({ ok: true });
    expect(
      await owner.call(`${IMPORTS}/${importId}`, I, 'confirmUploadAction', [importId]),
    ).toMatchObject({ ok: false, code: 'RULE_VIOLATION' });
  }, 60_000);
});
