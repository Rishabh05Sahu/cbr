// Import-file cleanup (Phase 2 M4, runbook §6). The worker lists due files through the
// crm_cleanup connection (app.import_files_due: org id, job id, storage key; nothing else) and
// hands them here. For each one this module:
//   1. refuses any key that is not exactly orgs/<org>/imports/<job>/<random>.<ext> for that org
//      and job (keyBelongsTo), and any job row (read in that org's tenant transaction) whose key
//      differs;
//   2. deletes the object (idempotent: a missing object is not an error);
//   3. in the org's tenant transaction, ends an unfinished job (waiting → EXPIRED, mid-step →
//      FAILED with FILE_EXPIRED) and records file_deleted_at, once.
// A failure between 2 and 3 leaves the row due, so the next sweep repeats both safely.
import { writeAudit } from '@/modules/audit';
import { tenantRunner } from '@/platform/db';
import { keyBelongsTo, type ObjectStorage } from '@/platform/storage';

export interface DueImportFile {
  orgId: string;
  importJobId: string;
  storageKey: string;
}

export interface SweepResult {
  deleted: number;
  /** Rows refused by the ownership checks (left untouched, reported for investigation). */
  refused: number;
  /** Unfinished jobs ended because their file expired. */
  ended: number;
  /** Storage errors; retried on the next sweep. */
  errors: number;
}

const WAITING = ['AWAITING_UPLOAD', 'UPLOADED', 'NEEDS_MAPPING', 'READY', 'PAUSED'];
const MID_STEP = ['ANALYSING', 'VALIDATING', 'IMPORTING'];

export async function sweepImportFiles(
  due: readonly DueImportFile[],
  storage: ObjectStorage,
): Promise<SweepResult> {
  const result: SweepResult = { deleted: 0, refused: 0, ended: 0, errors: 0 };
  for (const f of due) {
    if (!keyBelongsTo(f.storageKey, f.orgId, 'imports', f.importJobId)) {
      result.refused++;
      continue;
    }
    const tenant = { orgId: f.orgId, userId: null };
    const job = await tenantRunner().withTenant(tenant, (tx) =>
      tx.importJob.findUnique({
        where: { id: f.importJobId },
        select: { storageKey: true, fileDeletedAt: true, purgeFileAfter: true },
      }),
    );
    if (!job || job.storageKey !== f.storageKey) {
      result.refused++;
      continue;
    }
    if (job.fileDeletedAt || job.purgeFileAfter.getTime() > Date.now()) continue;
    try {
      await storage.remove([f.storageKey]);
    } catch {
      result.errors++;
      continue;
    }
    result.deleted++;
    const ended = await tenantRunner().withTenant(tenant, async (tx) => {
      const now = new Date();
      const expired = await tx.importJob.updateMany({
        where: { id: f.importJobId, status: { in: WAITING } },
        data: { status: 'EXPIRED', errorCode: 'FILE_EXPIRED', finishedAt: now, updatedAt: now },
      });
      const failed = await tx.importJob.updateMany({
        where: { id: f.importJobId, status: { in: MID_STEP } },
        data: { status: 'FAILED', errorCode: 'FILE_EXPIRED', finishedAt: now, updatedAt: now },
      });
      await tx.importJob.updateMany({
        where: { id: f.importJobId, fileDeletedAt: null },
        data: { fileDeletedAt: now },
      });
      const n = expired.count + failed.count;
      if (n)
        await writeAudit(tx, f.orgId, {
          action: 'import.expired',
          entityType: 'import_job',
          entityId: f.importJobId,
          actorUserId: null,
          actorKind: 'SYSTEM',
        });
      return n;
    });
    result.ended += ended;
  }
  return result;
}
