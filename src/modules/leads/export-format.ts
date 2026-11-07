// Lead export file format (FR-066; threat model T5, T6). Pure: turns already-authorised lead
// rows into CSV text. The export job (export_job table, worker, private storage, single-use
// 15-minute download, audit, rate limit) waits for migration 0006 (docs/PHASE-2-M5-PROPOSAL.md).
//
// - Watermark: the first line names the requester, the org and the time (T5), so a leaked file
//   identifies its source. It is a full CSV row, so spreadsheet apps show it.
// - Spreadsheet-formula injection (T6): any cell starting with = + - @ tab or CR is prefixed with
//   an apostrophe, so it is shown as text, never evaluated. This includes "+91…" phone numbers.
// - Row cap: an export never exceeds EXPORT_ROW_CAP rows; the job refuses larger selections
//   instead of truncating silently.

export const EXPORT_ROW_CAP = 50_000;

export interface ExportLeadRow {
  id: string;
  fullName: string;
  /** Masked (maskPhone) while the org's phone masking is on (loadExportRows, FR-060). */
  primaryPhoneE164: string;
  alternatePhoneE164: string | null;
  email: string | null;
  stage: string;
  sourceName: string;
  ownerName: string | null;
  teamName: string | null;
  transactionType: string | null;
  propertyType: string | null;
  bhkMin: number | null;
  bhkMax: number | null;
  budgetMin: string | null;
  budgetMax: string | null;
  preferredCity: string | null;
  preferredLocalities: readonly string[];
  createdAt: Date;
  archivedAt: Date | null;
}

export interface ExportColumn {
  header: string;
  /** Personal data (database-design §4: PII registry) — counted in the audit entry. */
  pii: boolean;
  value: (r: ExportLeadRow) => string | number | null;
}

const iso = (d: Date | null) => (d ? d.toISOString() : null);

export const EXPORT_COLUMNS: readonly ExportColumn[] = [
  { header: 'Lead ID', pii: false, value: (r) => r.id },
  { header: 'Name', pii: true, value: (r) => r.fullName },
  { header: 'Phone', pii: true, value: (r) => r.primaryPhoneE164 },
  { header: 'Alternate phone', pii: true, value: (r) => r.alternatePhoneE164 },
  { header: 'Email', pii: true, value: (r) => r.email },
  { header: 'Stage', pii: false, value: (r) => r.stage },
  { header: 'Source', pii: false, value: (r) => r.sourceName },
  { header: 'Owner', pii: false, value: (r) => r.ownerName },
  { header: 'Team', pii: false, value: (r) => r.teamName },
  { header: 'Transaction', pii: false, value: (r) => r.transactionType },
  { header: 'Property type', pii: false, value: (r) => r.propertyType },
  { header: 'BHK (min)', pii: false, value: (r) => r.bhkMin },
  { header: 'BHK (max)', pii: false, value: (r) => r.bhkMax },
  { header: 'Budget min (INR)', pii: false, value: (r) => r.budgetMin },
  { header: 'Budget max (INR)', pii: false, value: (r) => r.budgetMax },
  { header: 'City', pii: false, value: (r) => r.preferredCity },
  { header: 'Localities', pii: false, value: (r) => r.preferredLocalities.join(', ') },
  { header: 'Created at', pii: false, value: (r) => iso(r.createdAt) },
  { header: 'Archived at', pii: false, value: (r) => iso(r.archivedAt) },
];

export class ExportTooLarge extends Error {
  override readonly name = 'ExportTooLarge';
  constructor(readonly rows: number) {
    super(`Export of ${rows} rows exceeds the ${EXPORT_ROW_CAP}-row cap`);
  }
}

/** The request-time check: a selection larger than the cap is refused (never truncated). */
export function exportRowCountAllowed(rows: number): boolean {
  return Number.isInteger(rows) && rows >= 0 && rows <= EXPORT_ROW_CAP;
}

/** Neutralises formula-like text and quotes for CSV (RFC 4180). */
export function csvCell(v: string | number | null): string {
  let s = v === null ? '' : String(v);
  if (/^[=+\-@\t\r]/.test(s)) s = `'${s}`;
  return /[",\r\n]/.test(s) ? `"${s.replace(/"/g, '""')}"` : s;
}

export interface Watermark {
  requestedByName: string;
  orgName: string;
  at: Date;
}

export const watermarkLine = (w: Watermark, rows: number) =>
  `CONFIDENTIAL lead export for ${w.orgName}, requested by ${w.requestedByName} at ${w.at.toISOString()}, ${rows} rows. Do not share.`;

/** CSV text (UTF-8 BOM, CRLF) with the watermark row first, then the header and the rows. */
export function leadsToCsv(rows: readonly ExportLeadRow[], w: Watermark): string {
  if (rows.length > EXPORT_ROW_CAP) throw new ExportTooLarge(rows.length);
  const lines = [
    csvCell(watermarkLine(w, rows.length)),
    EXPORT_COLUMNS.map((c) => csvCell(c.header)).join(','),
  ];
  for (const r of rows) lines.push(EXPORT_COLUMNS.map((c) => csvCell(c.value(r))).join(','));
  return `﻿${lines.join('\r\n')}\r\n`;
}

/** Audit detail for an export (security-and-threat-model: filters + row count). No values. */
export const exportAuditMetadata = (rows: number) => ({
  rows,
  piiColumns: EXPORT_COLUMNS.filter((c) => c.pii).length,
  columns: EXPORT_COLUMNS.length,
});
