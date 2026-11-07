// Cross-org file lookups for the worker's cleanup sweeps (Phase 2 M4 imports, M5 exports). Runs
// on its own connection as crm_cleanup, whose only privileges are EXECUTE on
// app.import_files_due (0005) and app.export_files_due / app.export_file_deleted (0006): it can
// list due (org, job, storage key) triples and mark a due export closed, nothing else. Import
// files are marked deleted afterwards in that org's withTenant() transaction (crm_app).
// Lint: importable from src/platform/** and the worker entrypoint only.
import { cleanupPrisma } from './client';

export interface DueImportFile {
  orgId: string;
  importJobId: string;
  storageKey: string;
}

/** The database caps a call at 500 rows. */
export const IMPORT_FILES_DUE_MAX = 500;

export const isCleanupConfigured = () => cleanupPrisma() !== null;

export interface DueExportFile {
  orgId: string;
  exportJobId: string;
  storageKey: string;
}

/** Export files whose retention has passed (app.export_files_due, migration 0006). */
export async function exportFilesDue(limit: number): Promise<DueExportFile[]> {
  const db = cleanupPrisma();
  if (!db) return [];
  const n = Math.max(0, Math.min(IMPORT_FILES_DUE_MAX, Math.trunc(limit)));
  const rows = await db.$queryRaw<{ org_id: string; export_job_id: string; storage_key: string }[]>`
    SELECT org_id, export_job_id, storage_key FROM app.export_files_due(${n}::integer)`;
  return rows.map((r) => ({
    orgId: r.org_id,
    exportJobId: r.export_job_id,
    storageKey: r.storage_key,
  }));
}

/**
 * Records that a due export's file was deleted and closes the job (app.export_file_deleted: only
 * a due row of that org, once; QUEUED/READY -> EXPIRED, RUNNING -> FAILED; search text dropped).
 * export_job rows are invisible to system tenant sessions (requester_only), hence the definer.
 */
export async function markExportFileDeleted(orgId: string, exportJobId: string): Promise<boolean> {
  const db = cleanupPrisma();
  if (!db) return false;
  const [r] = await db.$queryRaw<{ ok: boolean }[]>`
    SELECT app.export_file_deleted(${orgId}::uuid, ${exportJobId}::uuid) AS ok`;
  return r?.ok === true;
}

/** Import files whose retention has passed, oldest first. Empty when cleanup is not configured. */
export async function importFilesDue(limit: number): Promise<DueImportFile[]> {
  const db = cleanupPrisma();
  if (!db) return [];
  const n = Math.max(0, Math.min(IMPORT_FILES_DUE_MAX, Math.trunc(limit)));
  const rows = await db.$queryRaw<{ org_id: string; import_job_id: string; storage_key: string }[]>`
    SELECT org_id, import_job_id, storage_key FROM app.import_files_due(${n}::integer)`;
  return rows.map((r) => ({
    orgId: r.org_id,
    importJobId: r.import_job_id,
    storageKey: r.storage_key,
  }));
}
