// Lead export generation, worker side (FR-066, D3). Worker-only (lint: WORKER_ONLY).
//
// Identity: the export is built AS ITS REQUESTER. Their context is rebuilt from the database
// (memberContext: ACTIVE membership, ACTIVE org) and must still hold lead.export (Owner) before
// the job is started and again before it is marked READY. export_job rows are visible only to
// the requester (requester_only) and changeable only by an ACTIVE owner (owner_updates), so a
// demoted or suspended requester's job cannot be advanced; it stays unfinished and the cleanup
// sweep closes it when its file is due (at most 1 hour after the request).
//
// Steps: QUEUED -> RUNNING (conditional, so a duplicate message is a no-op) -> rows in one
// statement (scope + the stored list filters; more than 50,000 rows fails EXPORT_TOO_LARGE;
// phone numbers masked if the org's phone masking is on when the file is built, FR-060) ->
// watermarked, formula-safe CSV -> more than 20 MB fails EXPORT_FILE_TOO_LARGE (never truncated)
// -> private upload under orgs/<org>/exports/<job>/ (never overwrites) -> READY with a window of
// at most 15 minutes (never past the purge time) and the search text dropped. Every failure is
// recorded on the job (FAILED + code, search text dropped) instead of being retried blindly.
//
// Recovery (M5): a worker that dies mid-build leaves the job RUNNING. The queue redelivers a
// stalled job (BullMQ lock 60 s, see worker/main.ts), and a RUNNING job whose claim is older than
// CLAIM_LEASE may be claimed again. Every claim bumps `version` and is FENCED by it: READY and
// FAILED apply only while the job still carries the claimant's version, so a stale builder can
// neither publish nor fail the job. Before uploading, the claimant removes any partial object at
// the job's own key (the job is not READY, so nothing was ever downloadable), so at most one file
// exists and the single-use, checksum-verified download is unchanged.
import { createHash } from 'node:crypto';
import { writeAudit } from '@/modules/audit';
import * as leads from '@/modules/leads';
import { memberContext } from '@/platform/auth/member-context';
import { can, type RequestContext } from '@/platform/authz';
import { tenantRunner } from '@/platform/db';
import { keyBelongsTo, StorageError, type ObjectStorage } from '@/platform/storage';

type Member = RequestContext & { kind: 'member' };

/** A RUNNING claim older than this is treated as abandoned (longer than the 60 s queue lock). */
export const CLAIM_LEASE_SECONDS = 90;

export type ExportOutcome = 'ready' | 'failed' | 'noop' | 'not_authorised';

export interface ExportDeps {
  storage: ObjectStorage;
  /** Test hook: runs after the file is uploaded, before the job is marked READY. */
  afterUpload?: () => Promise<void> | void;
}

async function requester(orgId: string, userId: string): Promise<Member | null> {
  const r = await memberContext(userId, orgId);
  return r.ok && can(r.ctx, 'lead.export') ? r.ctx : null;
}

export async function processExportJob(
  orgId: string,
  exportJobId: string,
  requestedBy: string,
  deps: ExportDeps,
): Promise<ExportOutcome> {
  const ctx = await requester(orgId, requestedBy);
  if (!ctx) return 'not_authorised';

  // 1. Claim (QUEUED -> RUNNING, or an abandoned RUNNING claim) at the transaction time.
  const started = await tenantRunner().withTenant(ctx.tenant, async (tx) => {
    const rows = await tx.$queryRaw<
      { storage_key: string; filters: leads.ExportFilters; version: number }[]
    >`
      UPDATE export_job SET status = 'RUNNING', started_at = now(), updated_at = now(),
                            version = version + 1
       WHERE id = ${exportJobId}::uuid AND purge_file_after > now()
         AND (status = 'QUEUED'
              OR (status = 'RUNNING'
                  AND started_at < now() - make_interval(secs => ${CLAIM_LEASE_SECONDS})))
      RETURNING storage_key, filters, version`;
    return rows[0] ?? null;
  });
  if (!started) return 'noop';
  const claim = started.version;
  if (!keyBelongsTo(started.storage_key, orgId, 'exports', exportJobId))
    return fail(ctx, exportJobId, claim, 'EXPORT_KEY_INVALID');

  // 2. Rows and file.
  let body: Buffer;
  let rowCount: number;
  try {
    const built = await tenantRunner().withTenant(ctx.tenant, async (tx) => {
      const rows = await leads.loadExportRows(tx, ctx, started.filters);
      const me = await tx.user.findUniqueOrThrow({
        where: { id: ctx.userId },
        select: { name: true },
      });
      const csv = leads.leadsToCsv(rows, {
        requestedByName: me.name,
        orgName: ctx.orgName,
        at: new Date(),
      });
      return { csv, rows: rows.length };
    });
    body = Buffer.from(built.csv, 'utf8');
    rowCount = built.rows;
    leads.assertExportSize(body.byteLength);
  } catch (e) {
    if (e instanceof leads.ExportTooLarge) return fail(ctx, exportJobId, claim, 'EXPORT_TOO_LARGE');
    if (e instanceof leads.ExportFileTooLarge) return fail(ctx, exportJobId, claim, e.code);
    return fail(ctx, exportJobId, claim, 'EXPORT_BUILD_FAILED');
  }

  // 3. Private upload. A partial object from an abandoned claim is removed first (own key only,
  //    never a READY job's file); put itself never overwrites.
  try {
    await deps.storage.remove([started.storage_key]);
    await deps.storage.put(started.storage_key, body, 'text/csv');
  } catch (e) {
    return fail(
      ctx,
      exportJobId,
      claim,
      e instanceof StorageError && e.code === 'TOO_LARGE'
        ? 'EXPORT_FILE_TOO_LARGE'
        : 'EXPORT_STORAGE_FAILED',
    );
  }
  await deps.afterUpload?.();

  // 4. READY, as a requester who is still an active Owner.
  const still = await requester(orgId, requestedBy);
  if (!still) return 'not_authorised';
  const sha256 = createHash('sha256').update(body).digest();
  const ready = await tenantRunner().withTenant(still.tenant, async (tx) => {
    const n = await tx.$executeRaw`
      UPDATE export_job
         SET status = 'READY', finished_at = now(),
             expires_at = least(now() + interval '15 minutes', purge_file_after),
             row_count = ${rowCount}, sha256 = ${sha256}, filters = filters - 'q',
             updated_at = now(), version = version + 1
       WHERE id = ${exportJobId}::uuid AND status = 'RUNNING' AND version = ${claim}
         AND purge_file_after > now() + interval '1 minute'`;
    if (n === 1)
      await writeAudit(tx, orgId, {
        action: 'lead.export_ready',
        entityType: 'export_job',
        entityId: exportJobId,
        actorUserId: still.userId,
        metadata: { ...leads.exportAuditMetadata(rowCount), bytes: body.byteLength },
      });
    return n === 1;
  });
  return ready ? 'ready' : fail(still, exportJobId, claim, 'EXPORT_EXPIRED_BEFORE_READY');
}

/** Records a failure (unfinished jobs, this claim only), dropping the search text. */
async function fail(
  ctx: Member,
  exportJobId: string,
  claim: number,
  code: string,
): Promise<'failed'> {
  await tenantRunner().withTenant(ctx.tenant, async (tx) => {
    const n = await tx.$executeRaw`
      UPDATE export_job
         SET status = 'FAILED', error_code = ${code}, finished_at = now(), filters = filters - 'q',
             updated_at = now(), version = version + 1
       WHERE id = ${exportJobId}::uuid AND status = 'RUNNING' AND version = ${claim}`;
    if (n === 1)
      await writeAudit(tx, ctx.orgId, {
        action: 'lead.export_failed',
        entityType: 'export_job',
        entityId: exportJobId,
        actorUserId: ctx.userId,
        metadata: { reason: code },
      });
  });
  return 'failed';
}
