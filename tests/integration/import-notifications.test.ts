// "Import finished" in-app notification (migration 0010): the import_job trigger writes one
// 'import.finished' outbox event when a job moves into COMPLETED / COMPLETED_WITH_ERRORS / FAILED,
// and the worker turns it into one IMPORT_FINISHED notification for the job's creator. Covers
// success, row problems, dry run, failure, cancellation (no notice), nothing before the end,
// redelivery and duplicated events, recipient, link, and cross-org isolation. Synthetic data only.
import { beforeAll, describe, expect, it } from 'vitest';
import * as imports from '@/modules/imports';
import { processImportJob } from '@/modules/imports/processor';
import { listNotifications, notifyForEvent, unreadCount } from '@/modules/notifications';
import { DomainError } from '@/platform/errors';
import { handleDomainEvent } from '@/worker/handlers';
import { migrator } from '../support/db';
import { actorIn, seedOrg, type Actor } from '../support/factory';
import { memoryStorage, type MemoryStorage } from '../support/memory-storage';

let A: Awaited<ReturnType<typeof seedOrg>>;
let B: Awaited<ReturnType<typeof seedOrg>>;
let owner: Actor;
let admin: Actor;
let ownerB: Actor;
let storage: MemoryStorage;

let seq = 0;
const phone = () => `96${String(10_000_000 + ++seq * 7_013 + (process.pid % 1000)).slice(-8)}`;
const job = (id: string) => migrator().importJob.findUniqueOrThrow({ where: { id } });
const finishedEvents = (id: string) =>
  migrator().outboxEvent.findMany({
    where: { type: 'import.finished', payload: { path: ['importJobId'], equals: id } },
  });
const noticesFor = (id: string) =>
  migrator().notification.findMany({
    where: { type: 'IMPORT_FINISHED', data: { path: ['importJobId'], equals: id } },
  });

async function swallow(p: Promise<unknown>) {
  try {
    await p;
  } catch (e) {
    if (!(e instanceof DomainError)) throw e;
  }
}

/** Delivers every 'import.finished' event of this job through the real worker handler. */
async function deliver(id: string) {
  for (const e of await finishedEvents(id))
    await handleDomainEvent({ eventId: e.id, orgId: e.orgId, type: e.type, payload: e.payload });
}

/** Upload, map, validate (and optionally import) a CSV as `by`, checking no notice before the end. */
async function runImport(by: Actor, org: string, csv: string, opts: { dryRun?: boolean } = {}) {
  const body = Buffer.from(csv);
  const s = await imports.startImport(
    by.ctx,
    { fileName: 'notify.csv', size: body.byteLength, type: 'text/csv' },
    storage,
  );
  storage.browserPut(s.upload.url, body, s.upload.headers['content-type']!);
  await imports.confirmUpload(by.ctx, s.importId, storage);
  const step = () => processImportJob(org, s.importId, { storage });
  expect(await step()).toBe('needs_mapping');
  const j = await job(s.importId);
  await imports.submitMapping(by.ctx, s.importId, {
    mapping: { fullName: 0, primaryPhone: 1 },
    duplicatePolicy: 'SKIP',
    assignment: { mode: 'none' },
    dryRun: opts.dryRun ?? false,
    version: j.version,
  });
  const validated = await step();
  if (opts.dryRun) return { id: s.importId, validated };
  expect(validated).toBe('ready');
  // Queued, mapped and validated, but not finished: nothing announced yet.
  expect(await finishedEvents(s.importId)).toHaveLength(0);
  await imports.confirmImport(by.ctx, s.importId, {
    attest: true,
    version: (await job(s.importId)).version,
  });
  expect(await step()).toBe('completed');
  return { id: s.importId, validated };
}

beforeAll(async () => {
  storage = memoryStorage();
  A = await seedOrg('NotifyA');
  B = await seedOrg('NotifyB');
  owner = await actorIn(A.users.owner, A.orgId);
  admin = await actorIn(A.users.admin, A.orgId);
  ownerB = await actorIn(B.users.owner, B.orgId);
});

describe('import finished notification', () => {
  it('success: one notice for the creator, with counts and the import link; redelivery adds nothing', async () => {
    const before = await unreadCount(owner.ctx);
    const { id } = await runImport(
      owner,
      A.orgId,
      `Name,Phone\nOk One,${phone()}\nOk Two,${phone()}\n`,
    );
    expect((await job(id)).status).toBe('COMPLETED');
    expect(await finishedEvents(id)).toHaveLength(1);
    await deliver(id);
    await deliver(id); // worker retry / redelivery of the same event
    const n = await noticesFor(id);
    expect(n).toHaveLength(1);
    expect(n[0]).toMatchObject({
      orgId: A.orgId,
      recipientUserId: A.users.owner.id,
      title: 'Your import finished',
      body: '2 new, 0 added to existing leads.',
      link: `/app/leads/import/${id}`,
      data: { importJobId: id, status: 'COMPLETED' },
      readAt: null,
    });
    // Visible through the existing notification list and unread badge, for the creator only.
    expect(await unreadCount(owner.ctx)).toBe(before + 1);
    expect((await listNotifications(owner.ctx)).rows.map((x) => x.link)).toContain(
      `/app/leads/import/${id}`,
    );
    expect((await listNotifications(admin.ctx)).rows.map((x) => x.link)).not.toContain(
      `/app/leads/import/${id}`,
    );

    // Even a duplicated event (a second event id for the same import) cannot add a second notice.
    const e = (await finishedEvents(id))[0]!;
    const dup = await migrator().outboxEvent.create({
      data: { orgId: A.orgId, type: 'import.finished', payload: e.payload as object },
    });
    await notifyForEvent({ eventId: dup.id, orgId: A.orgId, type: dup.type, payload: dup.payload });
    expect(await noticesFor(id)).toHaveLength(1);
  });

  it('row problems: says how many rows need attention; no names, phones or file name', async () => {
    const good = phone();
    const { id } = await runImport(admin, A.orgId, `Name,Phone\nGood Row,${good}\nBad Row,12345\n`);
    expect((await job(id)).status).toBe('COMPLETED_WITH_ERRORS');
    await deliver(id);
    const [n] = await noticesFor(id);
    expect(n).toMatchObject({
      recipientUserId: A.users.admin.id, // the admin started it, so the admin is told
      title: 'Your import finished with problems',
      body: '1 new, 0 added to existing leads. 1 row needs attention.',
      link: `/app/leads/import/${id}`,
    });
    const text = `${n!.title} ${n!.body} ${JSON.stringify(n!.data)}`;
    for (const v of ['Good Row', 'Bad Row', good, '12345', 'notify.csv'])
      expect(text).not.toContain(v);
    expect(await noticesFor(id).then((x) => x.map((y) => y.recipientUserId))).toEqual([
      A.users.admin.id,
    ]);
  });

  it('dry run: announces the would-be counts and that nothing changed', async () => {
    const { id } = await runImport(owner, A.orgId, `Name,Phone\nDry One,${phone()}\n`, {
      dryRun: true,
    });
    expect((await job(id)).status).toBe('COMPLETED');
    await deliver(id);
    expect(await noticesFor(id)).toMatchObject([
      {
        title: 'Your dry run finished',
        body: '1 row would be imported; 0 need attention. Nothing was changed.',
      },
    ]);
  });

  it('failure: a generic notice with the link, no error details', async () => {
    const body = Buffer.from(`Name,Phone\nFail One,${phone()}\n`);
    const s = await imports.startImport(
      owner.ctx,
      { fileName: 'notify.csv', size: body.byteLength + 7, type: 'text/csv' },
      storage,
    );
    storage.browserPut(s.upload.url, body, s.upload.headers['content-type']!);
    await swallow(imports.confirmUpload(owner.ctx, s.importId, storage)); // size mismatch
    expect(await job(s.importId)).toMatchObject({
      status: 'FAILED',
      errorCode: 'UPLOAD_SIZE_MISMATCH',
    });
    expect(await finishedEvents(s.importId)).toHaveLength(1);
    await deliver(s.importId);
    const [n] = await noticesFor(s.importId);
    expect(n).toMatchObject({
      recipientUserId: A.users.owner.id,
      title: 'Your import failed',
      link: `/app/leads/import/${s.importId}`,
      data: { importJobId: s.importId, status: 'FAILED' },
    });
    expect(n!.body).not.toMatch(/SIZE|MISMATCH|bytes/i);
  });

  it('cancellation is not announced, and a finished job never announces twice', async () => {
    const body = Buffer.from(`Name,Phone\nCancel One,${phone()}\n`);
    const s = await imports.startImport(
      owner.ctx,
      { fileName: 'notify.csv', size: body.byteLength, type: 'text/csv' },
      storage,
    );
    await imports.cancelImport(owner.ctx, s.importId);
    expect((await job(s.importId)).status).toBe('CANCELLED');
    expect(await finishedEvents(s.importId)).toHaveLength(0);

    // The trigger only fires on the way INTO a finished state: rewriting a finished status
    // (maintenance access) emits nothing more.
    const done = (await migrator().importJob.findFirst({
      where: { orgId: A.orgId, status: 'COMPLETED', dryRun: false },
      select: { id: true },
    }))!;
    const failed = (await migrator().importJob.findFirst({
      where: { orgId: A.orgId, status: 'FAILED' },
      select: { id: true },
    }))!;
    const before = [
      (await finishedEvents(done.id)).length,
      (await finishedEvents(failed.id)).length,
    ];
    // (Rewritten to the same value: UPDATE OF status still fires, the WHEN clause refuses it.)
    await migrator().$executeRaw`UPDATE import_job SET status = status WHERE id = ${done.id}::uuid`;
    await migrator()
      .$executeRaw`UPDATE import_job SET status = 'FAILED' WHERE id = ${failed.id}::uuid`;
    expect([
      (await finishedEvents(done.id)).length,
      (await finishedEvents(failed.id)).length,
    ]).toEqual(before);
  });

  it('is per organisation: another org neither receives nor can produce it', async () => {
    const { id } = await runImport(ownerB, B.orgId, `Name,Phone\nB One,${phone()}\n`);
    const [e] = await finishedEvents(id);
    expect(e!.orgId).toBe(B.orgId);
    // Handled under org A's tenant, B's job is invisible: nothing is created.
    expect(
      await handleDomainEvent({
        eventId: e!.id,
        orgId: A.orgId,
        type: e!.type,
        payload: e!.payload,
      }),
    ).toBe('skipped');
    expect(await noticesFor(id)).toHaveLength(0);
    await deliver(id);
    expect(await noticesFor(id).then((x) => x.map((y) => [y.orgId, y.recipientUserId]))).toEqual([
      [B.orgId, B.users.owner.id],
    ]);
    expect((await listNotifications(owner.ctx)).rows.map((x) => x.link)).not.toContain(
      `/app/leads/import/${id}`,
    );
  });
});
