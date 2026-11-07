// Export job rules (FR-066, owner decision D3 of 2026-10-24) shared by the request command, the
// worker, the download route and the UI. Pure. Migration 0006 enforces the same limits in the
// database (export_job CHECKs, export_job_guard, export_job_quota, owner/requester policies); the
// table, worker and route wait for its approval (docs/PHASE-2-M5-PROPOSAL.md).
//
// - Owner only (lead.export), visible only to the requester.
// - At most EXPORT_ROW_CAP rows (export-format.ts), refused rather than truncated.
// - One download, within 15 minutes of the file being ready, and never after the file's purge
//   time; the file is purged at most one hour after the job was created.
// - The download is claimed (READY -> DOWNLOADED) before any byte is sent and streamed through the
//   server; no reusable signed URL is handed out, so the link cannot be used twice.
import type { LeadQuery } from './list-query';

export const EXPORT_DOWNLOAD_WINDOW_MS = 15 * 60_000;
export const EXPORT_RETENTION_MS = 60 * 60_000;
export const EXPORT_DAILY_LIMIT = 5;
/**
 * Largest export file. The private bucket refuses objects over 20 MB (runbook §4), so the worker
 * fails a larger file with EXPORT_FILE_TOO_LARGE instead of truncating it.
 */
export const EXPORT_MAX_BYTES = 20 * 1024 * 1024;
/** Serialised size cap for stored filters (mirrors export_job_filters in 0006). */
export const EXPORT_FILTERS_MAX_BYTES = 4096;

export type ExportJobStatus = 'QUEUED' | 'RUNNING' | 'READY' | 'DOWNLOADED' | 'EXPIRED' | 'FAILED';

/** When a job created at `createdAt` must have its file purged. */
export const purgeDeadline = (createdAt: Date) =>
  new Date(createdAt.getTime() + EXPORT_RETENTION_MS);

/** The download deadline a finished export gets: 15 minutes, never past the file's purge time. */
export function downloadDeadline(finishedAt: Date, purgeFileAfter: Date): Date {
  return new Date(
    Math.min(finishedAt.getTime() + EXPORT_DOWNLOAD_WINDOW_MS, purgeFileAfter.getTime()),
  );
}

export interface ExportJobView {
  status: ExportJobStatus;
  expiresAt: Date | null;
  purgeFileAfter: Date;
  fileDeletedAt: Date | null;
}

export type ExportAvailability = 'PREPARING' | 'AVAILABLE' | 'USED' | 'EXPIRED' | 'FAILED';

/** What the requester can do with a job now. A READY job past its window shows as expired. */
export function exportAvailability(job: ExportJobView, now: Date): ExportAvailability {
  switch (job.status) {
    case 'QUEUED':
    case 'RUNNING':
      return now < job.purgeFileAfter ? 'PREPARING' : 'EXPIRED';
    case 'READY':
      return job.expiresAt && now < job.expiresAt && now < job.purgeFileAfter && !job.fileDeletedAt
        ? 'AVAILABLE'
        : 'EXPIRED';
    case 'DOWNLOADED':
      return 'USED';
    case 'EXPIRED':
      return 'EXPIRED';
    case 'FAILED':
      return 'FAILED';
  }
}

export type ExportFilters = Partial<Omit<LeadQuery, 'sort' | 'cursor'>>;

export class ExportFiltersTooLarge extends Error {
  override readonly name = 'ExportFiltersTooLarge';
}

/**
 * The filters stored on the job: the lead list's validated filters (what the Owner sees is what is
 * exported) without paging and without empty values.
 */
export function exportFilters(query: LeadQuery): ExportFilters {
  const out: Record<string, unknown> = {};
  for (const [k, v] of Object.entries(query)) {
    if (k === 'sort' || k === 'cursor') continue;
    if (v === null || (Array.isArray(v) && v.length === 0)) continue;
    out[k] = v;
  }
  if (Buffer.byteLength(JSON.stringify(out), 'utf8') > EXPORT_FILTERS_MAX_BYTES)
    throw new ExportFiltersTooLarge('Export filters are too large');
  return out as ExportFilters;
}

/**
 * The audit entry's copy of the filters. The free-text search can be a name or phone number, so
 * only its presence is recorded, never its text.
 */
export function exportAuditFilters(filters: ExportFilters): Record<string, unknown> {
  const { q, ...rest } = filters;
  return q ? { ...rest, search: true } : rest;
}

/**
 * The filters as stored once the job finishes (DOWNLOADED, EXPIRED or FAILED): without the search
 * text. The database refuses a terminal status while `q` is still stored (export_job_guard A1).
 */
export function withoutSearch(filters: ExportFilters): ExportFilters {
  const rest = { ...filters };
  delete rest.q;
  return rest;
}

export class ExportFileTooLarge extends Error {
  override readonly name = 'ExportFileTooLarge';
  readonly code = 'EXPORT_FILE_TOO_LARGE';
  constructor(readonly bytes: number) {
    super(`Export file of ${bytes} bytes exceeds the ${EXPORT_MAX_BYTES}-byte limit`);
  }
}

/** The worker fails the job (error code EXPORT_FILE_TOO_LARGE) rather than upload a cut file. */
export function assertExportSize(bytes: number): void {
  if (bytes > EXPORT_MAX_BYTES) throw new ExportFileTooLarge(bytes);
}
