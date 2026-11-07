// Export-file cleanup (Phase 2 M5; D3: files purged at most 1 hour after the request).
// Worker-only (lint: WORKER_ONLY). The worker lists due files through the crm_cleanup connection
// (app.export_files_due: org id, job id, storage key; nothing else) and passes them here with
// the marker (app.export_file_deleted, also crm_cleanup only). For each one:
//   1. refuse any key that is not exactly orgs/<org>/exports/<job>/<random>.csv for that org and
//      job (keyBelongsTo);
//   2. delete the object (idempotent: a missing object is not an error);
//   3. mark it: the definer function updates only a due row of that org, once, closes an
//      unfinished job (QUEUED/READY -> EXPIRED, RUNNING -> FAILED) and drops the search text.
// export_job rows are invisible to system tenant sessions (requester_only), so unlike imports
// the marking cannot happen in a crm_app transaction. A failure between 2 and 3 leaves the row
// due, so the next sweep repeats both safely.
import { keyBelongsTo, type ObjectStorage } from '@/platform/storage';

export interface DueExportFile {
  orgId: string;
  exportJobId: string;
  storageKey: string;
}

export interface ExportSweepResult {
  deleted: number;
  refused: number;
  errors: number;
}

export async function sweepExportFiles(
  due: readonly DueExportFile[],
  storage: ObjectStorage,
  markDeleted: (orgId: string, exportJobId: string) => Promise<boolean>,
): Promise<ExportSweepResult> {
  const result: ExportSweepResult = { deleted: 0, refused: 0, errors: 0 };
  for (const f of due) {
    if (!keyBelongsTo(f.storageKey, f.orgId, 'exports', f.exportJobId)) {
      result.refused++;
      continue;
    }
    try {
      await storage.remove([f.storageKey]);
    } catch {
      result.errors++;
      continue;
    }
    if (await markDeleted(f.orgId, f.exportJobId)) result.deleted++;
    else result.refused++; // no longer due or not in that org: nothing marked
  }
  return result;
}
