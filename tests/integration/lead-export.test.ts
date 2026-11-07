// Phase 2 M5 Slice 4: lead exports end to end below the UI (request → worker → download →
// cleanup) with the in-memory storage double. Owner-only, requester-only, quota, filters and
// scope, watermark and formula safety, search text removal, claim-first single use, integrity,
// demoted/suspended requesters, storage failures and the crm_cleanup sweep.
// Synthetic data only; crm_test only; no cloud storage.
import { Job } from 'bullmq';
import { beforeAll, describe, expect, it } from 'vitest';
import * as exportsModule from '@/modules/exports';
import { sweepExportFiles } from '@/modules/exports/cleanup';
import { processExportJob } from '@/modules/exports/processor';
import * as leads from '@/modules/leads';
import { exportFilesDue, markExportFileDeleted } from '@/platform/db/cleanup';
import { DomainError } from '@/platform/errors';
import { QUEUE, queue, type ExportJobMessage } from '@/platform/queue';
import { StorageError, type ObjectStorage } from '@/platform/storage';
import { handleDomainEvent } from '@/worker/handlers';
import { migrator } from '../support/db';
import { actorIn, seedOrg, type Actor } from '../support/factory';
import { memoryStorage } from '../support/memory-storage';

let A: Awaited<ReturnType<typeof seedOrg>>;
let B: Awaited<ReturnType<typeof seedOrg>>;
let Q: Awaited<ReturnType<typeof seedOrg>>;
let C: Awaited<ReturnType<typeof seedOrg>>; // its own quota for the lost-authorisation case
const a = {} as Record<'owner' | 'admin' | 'manager' | 'exec1', Actor>;
let ownerB: Actor;
let ownerQ: Actor;
const storage = memoryStorage();

let seq = 0;
const phone = () => `90${String(70_000_000 + ++seq * 6_043 + (process.pid % 1000)).slice(-8)}`;

async function codeOf(p: Promise<unknown>): Promise<string> {
  try {
    await p;
  } catch (e) {
    if (e instanceof DomainError) return e.code;
    if (e instanceof exportsModule.ExportDeliveryFailed) return 'DELIVERY_FAILED';
    throw e;
  }
  return 'OK';
}

async function newLead(by: Actor, input: Record<string, string> = {}): Promise<string> {
  const r = await leads.createLead(by.ctx, {
    fullName: 'Synthetic Customer',
    primaryPhone: phone(),
    ...input,
  });
  if (r.status !== 'created') throw new Error(`expected created, got ${JSON.stringify(r)}`);
  return r.leadId;
}
const job = (id: string) => migrator().exportJob.findUniqueOrThrow({ where: { id } });
const build = (
  id: string,
  by: Actor = a.owner,
  s: ObjectStorage = storage,
  afterUpload?: () => Promise<void>,
) =>
  processExportJob(by.ctx.orgId, id, by.user.id, {
    storage: s,
    ...(afterUpload ? { afterUpload } : {}),
  });
const text = (body: Uint8Array) => Buffer.from(body).toString('utf8');
const setRole = (org: string, userId: string, role: string) =>
  migrator().member.updateMany({ where: { organizationId: org, userId }, data: { role } });

beforeAll(async () => {
  A = await seedOrg('ExportA');
  B = await seedOrg('ExportB');
  Q = await seedOrg('ExportQ');
  C = await seedOrg('ExportC');
  for (const k of ['owner', 'admin', 'manager', 'exec1'] as const)
    a[k] = await actorIn(A.users[k], A.orgId);
  ownerB = await actorIn(B.users.owner, B.orgId);
  ownerQ = await actorIn(Q.users.owner, Q.orgId);
  // A's data: Pune leads (one with a formula-like name), a Mumbai lead, a merged tombstone.
  await newLead(a.exec1, { preferredCity: 'Pune', fullName: 'Synthetic Pune One' });
  await newLead(a.exec1, {
    preferredCity: 'Pune',
    fullName: '=HYPERLINK("http://example.invalid")',
  });
  await newLead(a.exec1, { preferredCity: 'Mumbai', fullName: 'Synthetic Mumbai' });
  const [s, m] = [
    await newLead(a.exec1, { preferredCity: 'Pune', fullName: 'Synthetic Survivor' }),
    await newLead(a.exec1, { preferredCity: 'Pune', fullName: 'Synthetic Tombstone' }),
  ];
  const v = async (id: string) =>
    (await migrator().lead.findUniqueOrThrow({ where: { id } })).version;
  await leads.mergeLeads(a.owner.ctx, {
    survivorId: s,
    mergedId: m,
    survivorVersion: await v(s),
    mergedVersion: await v(m),
    resolutions: { fullName: 'survivor' },
  });
  await newLead(ownerB, { preferredCity: 'Pune', fullName: 'Synthetic Other Org' });
});

describe('request', () => {
  it('Owner only; audit has filters and counts but never the search text', async () => {
    for (const who of [a.admin, a.manager, a.exec1])
      expect(await codeOf(exportsModule.requestLeadExport(who.ctx, {}))).toBe('FORBIDDEN');
    const r = await exportsModule.requestLeadExport(a.owner.ctx, { city: 'Pune', q: 'Synthetic' });
    const j = await job(r.id);
    expect(j).toMatchObject({
      status: 'QUEUED',
      requestedBy: A.users.owner.id,
      filters: { city: 'Pune', q: 'Synthetic' },
    });
    expect(j.storageKey).toMatch(
      new RegExp(`^orgs/${A.orgId}/exports/${r.id}/[0-9a-f]{32}\\.csv$`),
    );
    const audit = await migrator().auditLog.findFirstOrThrow({
      where: { action: 'lead.export_requested', entityId: r.id },
    });
    expect(audit.metadata).toMatchObject({
      filter_city: 'Pune',
      filter_search: true,
      rows: r.rows,
    });
    expect(JSON.stringify(audit.metadata)).not.toContain('Synthetic');
    expect(
      await migrator().outboxEvent.count({ where: { orgId: A.orgId, type: 'export.requested' } }),
    ).toBeGreaterThan(0);
  });

  it('the outbox event is routed to the exports queue, deduplicated by event id', async () => {
    const r = await exportsModule.requestLeadExport(ownerQ.ctx, {});
    const ev = await migrator().outboxEvent.findFirstOrThrow({
      where: {
        orgId: Q.orgId,
        type: 'export.requested',
        payload: { path: ['exportJobId'], equals: r.id },
      },
    });
    const evt = { eventId: ev.id, orgId: ev.orgId, type: ev.type, payload: ev.payload };
    expect(await handleDomainEvent(evt)).toBe('export-queued');
    expect(await handleDomainEvent(evt)).toBe('export-queued'); // redelivery: same job id
    const job = await Job.fromId<ExportJobMessage>(queue(QUEUE.exports), `evt-${ev.id}`);
    expect(job?.data).toEqual({ orgId: Q.orgId, exportJobId: r.id, requestedBy: Q.users.owner.id });
    await job?.remove();
    await expect(handleDomainEvent({ ...evt, payload: { exportJobId: 'nope' } })).rejects.toThrow();
  });

  it('invalid filters are refused', async () => {
    expect(
      await codeOf(exportsModule.requestLeadExport(a.owner.ctx, { stage: 'NOT_A_STAGE' })),
    ).toBe('VALIDATION_FAILED');
  });

  it('5 requests per 24 hours; concurrent requests cannot exceed it', async () => {
    // One request was made by the routing test above.
    for (let i = 0; i < 3; i++) await exportsModule.requestLeadExport(ownerQ.ctx, {});
    const results = await Promise.all(
      [1, 2, 3].map(() => codeOf(exportsModule.requestLeadExport(ownerQ.ctx, {}))),
    );
    expect(results.sort()).toEqual(['OK', 'RATE_LIMITED', 'RATE_LIMITED']);
    expect(await migrator().exportJob.count({ where: { orgId: Q.orgId } })).toBe(5);
  });
});

describe('generation and download', () => {
  it('builds a watermarked, formula-safe CSV of exactly the filtered, in-scope, live leads', async () => {
    const r = await exportsModule.requestLeadExport(a.owner.ctx, { city: 'Pune', q: 'Synthetic' });
    expect(await build(r.id)).toBe('ready');
    const j = await job(r.id);
    expect(j.status).toBe('READY');
    // Search text dropped once built; the archive view (M5) is part of the stored filters.
    expect(j.filters).toEqual({ city: 'Pune', archived: 'active' });
    expect(j.expiresAt!.getTime() - j.finishedAt!.getTime()).toBeLessThanOrEqual(15 * 60_000);
    const csv = text(storage.objects.get(j.storageKey)!.body);
    const lines = csv.replace(/^﻿/, '').split('\r\n');
    expect(lines[0]).toContain(`requested by ${A.users.owner.name}`);
    expect(lines[0]).toContain('CONFIDENTIAL lead export');
    expect(csv).toContain('Synthetic Pune One');
    expect(csv).toContain('Synthetic Survivor');
    expect(csv).not.toContain('Synthetic Tombstone'); // merged leads are not exported
    expect(csv).not.toContain('Synthetic Mumbai'); // filter
    expect(csv).not.toContain('Synthetic Other Org'); // tenant
    expect(csv).not.toContain('HYPERLINK'); // not matched by the search "Synthetic"
    expect(j.rowCount).toBe(2);
    expect(await build(r.id)).toBe('noop'); // duplicate message
  });

  it('neutralises formulas in exported cells', async () => {
    const r = await exportsModule.requestLeadExport(a.owner.ctx, { city: 'Pune' });
    await build(r.id);
    const csv = text(storage.objects.get((await job(r.id)).storageKey)!.body);
    expect(csv).toContain(`"'=HYPERLINK(""http://example.invalid"")"`);
    expect(csv).not.toMatch(/(^|,)=HYPERLINK/m);
  });

  it('downloads once, for the requester only; the claim is audited', async () => {
    const r = await exportsModule.requestLeadExport(a.owner.ctx, { city: 'Pune' });
    await build(r.id);
    await setRole(A.orgId, A.users.admin.id, 'owner');
    const otherOwner = await actorIn(A.users.admin, A.orgId);
    try {
      expect(
        await codeOf(exportsModule.downloadLeadExport(otherOwner.ctx, r.id, { storage })),
      ).toBe('NOT_FOUND');
    } finally {
      await setRole(A.orgId, A.users.admin.id, 'admin');
    }
    expect(await codeOf(exportsModule.downloadLeadExport(a.admin.ctx, r.id, { storage }))).toBe(
      'FORBIDDEN',
    );
    expect(await codeOf(exportsModule.downloadLeadExport(ownerB.ctx, r.id, { storage }))).toBe(
      'NOT_FOUND',
    );
    const file = await exportsModule.downloadLeadExport(a.owner.ctx, r.id, { storage });
    expect(text(file.body)).toContain('Synthetic Pune One');
    expect(file.fileName).toMatch(/^lead-export-[0-9a-f]{8}\.csv$/);
    expect(await job(r.id)).toMatchObject({ status: 'DOWNLOADED' });
    expect(await codeOf(exportsModule.downloadLeadExport(a.owner.ctx, r.id, { storage }))).toBe(
      'RULE_VIOLATION',
    );
    expect(
      await migrator().auditLog.count({
        where: { action: 'lead.export_downloaded', entityId: r.id },
      }),
    ).toBe(1);
  });

  it('two simultaneous downloads: exactly one gets the file', async () => {
    const r = await exportsModule.requestLeadExport(a.owner.ctx, { city: 'Pune' });
    await build(r.id);
    const results = await Promise.all([
      codeOf(exportsModule.downloadLeadExport(a.owner.ctx, r.id, { storage })),
      codeOf(exportsModule.downloadLeadExport(a.owner.ctx, r.id, { storage })),
    ]);
    expect(results.sort()).toEqual(['OK', 'RULE_VIOLATION']);
  });

  it('a tampered file is not delivered (and the single download is used: claim-first)', async () => {
    const ownerC = await actorIn(C.users.owner, C.orgId); // A's Owner has used the daily quota
    const r = await exportsModule.requestLeadExport(ownerC.ctx, {});
    expect(await build(r.id, ownerC)).toBe('ready');
    storage.tamper((await job(r.id)).storageKey, Buffer.from('tampered'));
    expect(await codeOf(exportsModule.downloadLeadExport(ownerC.ctx, r.id, { storage }))).toBe(
      'DELIVERY_FAILED',
    );
    expect((await job(r.id)).status).toBe('DOWNLOADED');
  });

  it('the daily quota applies to the requester (A’s Owner has made 5 requests)', async () => {
    expect(await codeOf(exportsModule.requestLeadExport(a.owner.ctx, {}))).toBe('RATE_LIMITED');
  });

  it('lists only the caller’s own exports with their availability', async () => {
    const mine = await exportsModule.listMyExports(a.owner.ctx);
    expect(mine.length).toBeGreaterThan(0);
    expect(
      mine.every((x) =>
        ['PREPARING', 'AVAILABLE', 'USED', 'EXPIRED', 'FAILED'].includes(x.availability),
      ),
    ).toBe(true);
    expect(await exportsModule.listMyExports(ownerB.ctx)).toEqual([]);
    expect(await codeOf(exportsModule.listMyExports(a.admin.ctx))).toBe('FORBIDDEN');
  });
});

describe('failures and lost authorisation', () => {
  it('storage refusing the file fails the job clearly (no truncation), search text dropped', async () => {
    const tooLarge: ObjectStorage = {
      ...storage,
      put: async () => Promise.reject(new StorageError('TOO_LARGE', 413)),
    };
    const r = await exportsModule.requestLeadExport(ownerB.ctx, { q: 'Synthetic' });
    expect(await build(r.id, ownerB, tooLarge)).toBe('failed');
    expect(await job(r.id)).toMatchObject({
      status: 'FAILED',
      errorCode: 'EXPORT_FILE_TOO_LARGE',
      filters: {},
    });
    const down: ObjectStorage = {
      ...storage,
      put: async () => Promise.reject(new StorageError('UNAVAILABLE', 503)),
    };
    const r2 = await exportsModule.requestLeadExport(ownerB.ctx, {});
    expect(await build(r2.id, ownerB, down)).toBe('failed');
    expect((await job(r2.id)).errorCode).toBe('EXPORT_STORAGE_FAILED');
    expect(await codeOf(exportsModule.downloadLeadExport(ownerB.ctx, r2.id, { storage }))).toBe(
      'RULE_VIOLATION',
    );
  });

  it('a demoted or suspended requester’s export is not built', async () => {
    const ownerC = await actorIn(C.users.owner, C.orgId);
    const r = await exportsModule.requestLeadExport(ownerC.ctx, {});
    await setRole(C.orgId, C.users.owner.id, 'admin');
    try {
      expect(await build(r.id, ownerC)).toBe('not_authorised');
    } finally {
      await setRole(C.orgId, C.users.owner.id, 'owner');
    }
    await migrator().member.update({
      where: { id: C.membership.owner! },
      data: { status: 'SUSPENDED' },
    });
    try {
      expect(await build(r.id, ownerC)).toBe('not_authorised');
    } finally {
      await migrator().member.update({
        where: { id: C.membership.owner! },
        data: { status: 'ACTIVE' },
      });
    }
    expect((await job(r.id)).status).toBe('QUEUED');
  });
});

describe('cleanup (crm_cleanup)', () => {
  it('deletes due files, closes their jobs, drops the search text; refuses foreign keys', async () => {
    // A job whose requester is demoted after the upload: RUNNING with a stored file.
    const r = await exportsModule.requestLeadExport(ownerB.ctx, { q: 'Synthetic' });
    expect(
      await build(r.id, ownerB, storage, () =>
        setRole(B.orgId, B.users.owner.id, 'admin').then(() => undefined),
      ),
    ).toBe('not_authorised');
    await setRole(B.orgId, B.users.owner.id, 'owner');
    const running = await job(r.id);
    expect(running.status).toBe('RUNNING');
    expect(storage.objects.has(running.storageKey)).toBe(true);
    // A queued job; both made due (retention may only shrink, so the schema owner can do this).
    const q = await exportsModule.requestLeadExport(ownerB.ctx, {});
    await migrator().exportJob.updateMany({
      where: { id: { in: [r.id, q.id] } },
      data: { purgeFileAfter: new Date(Date.now() - 1000) },
    });
    const due = (await exportFilesDue(500)).filter((d) => [r.id, q.id].includes(d.exportJobId));
    expect(due).toHaveLength(2);
    const forged = { ...due[0]!, orgId: A.orgId };
    const result = await sweepExportFiles([forged, ...due], storage, markExportFileDeleted);
    expect(result).toEqual({ deleted: 2, refused: 1, errors: 0 });
    expect(storage.objects.has(running.storageKey)).toBe(false);
    expect(await job(r.id)).toMatchObject({
      status: 'FAILED',
      errorCode: 'EXPIRED_BEFORE_READY',
      filters: {},
    });
    expect((await job(r.id)).fileDeletedAt).not.toBeNull();
    expect((await job(q.id)).status).toBe('EXPIRED');
    expect((await exportFilesDue(500)).map((d) => d.exportJobId)).not.toContain(r.id);
  });
});
