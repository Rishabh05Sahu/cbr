// Lead exports, web side (FR-066; owner decision D3 of 2026-10-24). Public API: request an export,
// list the caller's own exports, download one (claim-first, single use). The worker side is
// ./processor.ts (generation) and ./cleanup.ts (file deletion); both are worker-only.
//
// Rules (also enforced by migration 0006): Owner only (lead.export; owner_requests /
// owner_updates policies), visible only to the requester (requester_only), at most 50,000 rows
// (refused, never truncated), files under orgs/<org>/exports/<job>/ in private storage, one
// download inside 15 minutes, file purged at most 1 hour after the request, at most 5 requests
// per requester per 24 hours, and the list search text removed once the job finishes (A1).
// Audit entries carry filter names/values without the search text, and row counts.
import { createHash, randomUUID } from 'node:crypto';
import { writeAudit } from '@/modules/audit';
import * as leads from '@/modules/leads';
import { authorize, type RequestContext } from '@/platform/authz';
import { tenantRunner } from '@/platform/db';
import { DomainError, forbidden, notFound, ruleViolation } from '@/platform/errors';
import { emitEvent } from '@/platform/outbox';
import { keyBelongsTo, objectKeyFor, type ObjectStorage } from '@/platform/storage';

const DAY_MS = 24 * 3600_000;

const invalid = (fieldErrors: Record<string, string[]>) =>
  new DomainError('VALIDATION_FAILED', 'Please check the export filters', fieldErrors);

/** Audit metadata is flat and display-safe: arrays joined, the search text never included. */
export function auditFilterMetadata(
  filters: leads.ExportFilters,
): Record<string, string | boolean> {
  const out: Record<string, string | boolean> = {};
  for (const [k, v] of Object.entries(leads.exportAuditFilters(filters)))
    out[`filter_${k}`] = Array.isArray(v) ? v.join(',') : typeof v === 'boolean' ? v : String(v);
  return out;
}

/** Owner-only export request for the lead list's current filters (raw URL search params). */
export async function requestLeadExport(
  ctx: RequestContext,
  params: leads.SearchParams,
): Promise<{ id: string; rows: number }> {
  authorize(ctx, 'lead.export');
  if (ctx.kind !== 'member') throw forbidden();
  const { query, errors } = leads.parseLeadQuery(params);
  if (Object.keys(errors).length)
    throw invalid(Object.fromEntries(Object.entries(errors).map(([k, m]) => [k, [m]])));
  let filters: leads.ExportFilters;
  try {
    filters = leads.exportFilters(query);
  } catch (e) {
    if (e instanceof leads.ExportFiltersTooLarge)
      throw invalid({ q: ['The filters are too long'] });
    throw e;
  }
  const id = randomUUID();
  const storageKey = objectKeyFor(ctx.orgId, 'exports', id, 'csv');
  try {
    return await tenantRunner().withTenant(ctx.tenant, async (tx) => {
      const recent = await tx.exportJob.count({
        where: { requestedBy: ctx.userId, createdAt: { gt: new Date(Date.now() - DAY_MS) } },
      });
      if (recent >= leads.EXPORT_DAILY_LIMIT) throw rateLimited();
      const rows = await leads.countExportRows(tx, ctx, filters);
      if (!leads.exportRowCountAllowed(rows))
        throw ruleViolation(
          `These filters match ${rows} leads; an export can contain at most ${leads.EXPORT_ROW_CAP}. Narrow the filters.`,
        );
      await tx.exportJob.create({
        data: {
          id,
          orgId: ctx.orgId,
          requestedBy: ctx.userId,
          storageKey,
          filters: filters as object,
        },
      });
      await emitEvent(tx, ctx.orgId, {
        type: 'export.requested',
        payload: { exportJobId: id, requestedBy: ctx.userId },
      });
      await writeAudit(tx, ctx.orgId, {
        action: 'lead.export_requested',
        entityType: 'export_job',
        entityId: id,
        actorUserId: ctx.userId,
        metadata: { rows, ...auditFilterMetadata(filters) },
      });
      return { id, rows };
    });
  } catch (e) {
    // The database quota (export_job_quota) is the authority under concurrency.
    if (e instanceof Error && /export limit reached/.test(e.message)) throw rateLimited();
    throw e;
  }
}

const rateLimited = () =>
  new DomainError(
    'RATE_LIMITED',
    `At most ${leads.EXPORT_DAILY_LIMIT} exports per 24 hours. Try again later.`,
  );

export interface ExportJobView {
  id: string;
  status: leads.ExportJobStatus;
  availability: leads.ExportAvailability;
  rowCount: number | null;
  errorCode: string | null;
  createdAt: Date;
  expiresAt: Date | null;
}

/** The caller's own exports, newest first (other people's exports are never visible). */
export async function listMyExports(ctx: RequestContext): Promise<ExportJobView[]> {
  authorize(ctx, 'lead.export');
  return tenantRunner().withTenant(ctx.tenant, async (tx) => {
    const rows = await tx.exportJob.findMany({
      orderBy: { createdAt: 'desc' },
      take: 20,
      select: {
        id: true,
        status: true,
        rowCount: true,
        errorCode: true,
        createdAt: true,
        expiresAt: true,
        purgeFileAfter: true,
        fileDeletedAt: true,
      },
    });
    const now = new Date();
    return rows.map((r) => ({
      id: r.id,
      status: r.status as leads.ExportJobStatus,
      availability: leads.exportAvailability(
        { ...r, status: r.status as leads.ExportJobStatus },
        now,
      ),
      rowCount: r.rowCount,
      errorCode: r.errorCode,
      createdAt: r.createdAt,
      expiresAt: r.expiresAt,
    }));
  });
}

export class ExportDeliveryFailed extends Error {
  override readonly name = 'ExportDeliveryFailed';
}

/**
 * Single-use download. The claim (READY -> DOWNLOADED, inside the window, search text dropped,
 * audited) commits BEFORE any byte is read, so two simultaneous requests cannot both get the
 * file; the bytes are then read from private storage and returned for streaming by the server.
 * A delivery failure after the claim uses up the download (claim-first, owner decision): the
 * Owner requests a new export.
 */
export async function downloadLeadExport(
  ctx: RequestContext,
  exportId: string,
  deps: { storage: ObjectStorage },
): Promise<{ fileName: string; body: Uint8Array }> {
  authorize(ctx, 'lead.export');
  const id = parseExportId(exportId);
  const claimed = await tenantRunner().withTenant(ctx.tenant, async (tx) => {
    let rows: { storage_key: string; row_count: number; sha256: Buffer }[];
    try {
      rows = await tx.$queryRaw`
        UPDATE export_job
           SET status = 'DOWNLOADED', downloaded_at = now(), filters = filters - 'q',
               updated_at = now(), version = version + 1
         WHERE id = ${id}::uuid AND status = 'READY' AND expires_at > now()
           AND purge_file_after > now() AND file_deleted_at IS NULL
        RETURNING storage_key, row_count, sha256`;
    } catch (e) {
      if (e instanceof Error && /download window has closed/.test(e.message)) throw expiredOrUsed();
      throw e;
    }
    const row = rows[0];
    if (!row) {
      const exists = await tx.exportJob.findUnique({ where: { id }, select: { id: true } });
      throw exists ? expiredOrUsed() : notFound('Export not found');
    }
    await writeAudit(tx, ctx.orgId, {
      action: 'lead.export_downloaded',
      entityType: 'export_job',
      entityId: id,
      actorUserId: ctx.userId,
      metadata: { rows: row.row_count },
    });
    return row;
  });
  if (!keyBelongsTo(claimed.storage_key, ctx.orgId, 'exports', id))
    throw new ExportDeliveryFailed('export key does not belong to this export');
  let body: Uint8Array;
  try {
    body = await deps.storage.download(claimed.storage_key, leads.EXPORT_MAX_BYTES);
  } catch {
    throw new ExportDeliveryFailed('export file could not be read');
  }
  const digest = createHash('sha256').update(body).digest();
  if (!digest.equals(Buffer.from(claimed.sha256)))
    throw new ExportDeliveryFailed('export file does not match its checksum');
  return { fileName: `lead-export-${id.slice(0, 8)}.csv`, body };
}

const expiredOrUsed = () =>
  ruleViolation('This export has expired or was already downloaded. Request a new export.');

function parseExportId(id: string): string {
  if (!/^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i.test(id))
    throw notFound('Export not found');
  return id.toLowerCase();
}
