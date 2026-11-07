// Lead rows for an export (FR-066), inside the caller's transaction and scope. Used by the export
// module (request: count; worker: rows). The filters are the lead list's validated filters, so an
// export contains exactly what the Owner filtered; merged tombstones are never exported.
//
// Phone masking (FR-060, ADR-0013 amendment of 2026-10-29): while the org's phone_masking setting
// is on, both phone columns leave this module masked with the same phoneDisplay used by the lead
// list and detail, so the generated file never holds a full number. The setting is read when the
// rows are loaded, i.e. when the worker builds the file (jobs reload state; they never carry
// snapshots, system-architecture §Jobs). There is no bulk reveal: full numbers come only from
// revealLeadPhone, one audited, capped reveal at a time.
import type { RequestContext } from '@/platform/authz';
import { authorize } from '@/platform/authz';
import type { Prisma, Tx } from '@/platform/db';
import { scopeFilter } from './access';
import { EXPORT_ROW_CAP, ExportTooLarge, type ExportLeadRow } from './export-format';
import type { ExportFilters } from './export-job';
import type { LeadQuery } from './list-query';
import { filterWhere } from './list-where';
import { phoneDisplay, phoneMaskingPolicy } from './phone-masking';

const EMPTY: LeadQuery = {
  q: null,
  stages: [],
  intents: [],
  propertyTypes: [],
  owner: null,
  teamId: null,
  sourceId: null,
  city: null,
  createdFrom: null,
  createdTo: null,
  assignedFrom: null,
  assignedTo: null,
  budgetFrom: null,
  budgetTo: null,
  followUpDue: null,
  archived: 'active',
  sort: 'oldest',
  cursor: null,
};

async function exportWhere(
  tx: Tx,
  ctx: RequestContext,
  filters: ExportFilters,
): Promise<Prisma.LeadWhereInput> {
  const scope = authorize(ctx, 'lead.export');
  const { timeZone } = await tx.organization.findFirstOrThrow({ select: { timeZone: true } });
  return {
    AND: [
      await scopeFilter(tx, ctx, scope),
      { mergedIntoLeadId: null },
      ...filterWhere({ ...EMPTY, ...filters, sort: 'oldest', cursor: null }, timeZone),
    ],
  };
}

export async function countExportRows(
  tx: Tx,
  ctx: RequestContext,
  filters: ExportFilters,
): Promise<number> {
  return tx.lead.count({ where: await exportWhere(tx, ctx, filters) });
}

/**
 * Every matching lead, oldest first, in one statement (one consistent snapshot). More than
 * EXPORT_ROW_CAP rows throws ExportTooLarge: an export is refused, never truncated. Phone numbers
 * are masked while the org's phone masking is on.
 */
export async function loadExportRows(
  tx: Tx,
  ctx: RequestContext,
  filters: ExportFilters,
): Promise<ExportLeadRow[]> {
  const phone = phoneDisplay(await phoneMaskingPolicy(tx, ctx.orgId)); // FR-060
  const rows = await tx.lead.findMany({
    where: await exportWhere(tx, ctx, filters),
    orderBy: { id: 'asc' },
    take: EXPORT_ROW_CAP + 1,
    select: {
      id: true,
      fullName: true,
      primaryPhoneE164: true,
      alternatePhoneE164: true,
      email: true,
      stage: true,
      transactionType: true,
      propertyType: true,
      bhkMin: true,
      bhkMax: true,
      budgetMin: true,
      budgetMax: true,
      preferredCity: true,
      preferredLocalities: true,
      createdAt: true,
      archivedAt: true,
      source: { select: { name: true } },
      owner: { select: { user: { select: { name: true } } } },
      team: { select: { name: true } },
    },
  });
  if (rows.length > EXPORT_ROW_CAP) throw new ExportTooLarge(rows.length);
  return rows.map((r) => ({
    id: r.id,
    fullName: r.fullName,
    primaryPhoneE164: phone(r.primaryPhoneE164),
    alternatePhoneE164: phone(r.alternatePhoneE164),
    email: r.email,
    stage: r.stage,
    sourceName: r.source.name,
    ownerName: r.owner?.user.name ?? null,
    teamName: r.team?.name ?? null,
    transactionType: r.transactionType,
    propertyType: r.propertyType,
    bhkMin: r.bhkMin,
    bhkMax: r.bhkMax,
    budgetMin: r.budgetMin?.toFixed(2) ?? null,
    budgetMax: r.budgetMax?.toFixed(2) ?? null,
    preferredCity: r.preferredCity,
    preferredLocalities: r.preferredLocalities,
    createdAt: r.createdAt,
    archivedAt: r.archivedAt,
  }));
}
