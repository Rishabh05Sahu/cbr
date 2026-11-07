import { describe, expect, it } from 'vitest';
import {
  csvCell,
  EXPORT_COLUMNS,
  EXPORT_ROW_CAP,
  exportAuditMetadata,
  exportRowCountAllowed,
  ExportTooLarge,
  leadsToCsv,
  type ExportLeadRow,
} from './export-format';

const row = (patch: Partial<ExportLeadRow> = {}): ExportLeadRow => ({
  id: '01a16c00-0000-7000-8000-000000000001',
  fullName: 'Synthetic Lead 001',
  primaryPhoneE164: '+919000000001',
  alternatePhoneE164: null,
  email: 'synthetic.lead001@example.test',
  stage: 'NEW',
  sourceName: 'Website',
  ownerName: null,
  teamName: null,
  transactionType: 'BUY',
  propertyType: 'APARTMENT',
  bhkMin: 2,
  bhkMax: null,
  budgetMin: '8500000.00',
  budgetMax: null,
  preferredCity: 'Pune',
  preferredLocalities: ['Baner', 'Wakad'],
  createdAt: new Date('2026-10-24T08:00:00Z'),
  archivedAt: null,
  ...patch,
});
const w = {
  requestedByName: 'Synthetic Owner',
  orgName: 'Synthetic Realty',
  at: new Date('2026-10-24T09:30:00Z'),
};

describe('lead export CSV', () => {
  it('starts with the watermark, then the header, then one line per lead', () => {
    const lines = leadsToCsv([row()], w).replace(/^﻿/, '').split('\r\n');
    expect(lines[0]).toBe(
      '"CONFIDENTIAL lead export for Synthetic Realty, requested by Synthetic Owner at 2026-10-24T09:30:00.000Z, 1 rows. Do not share."',
    );
    expect(lines[1]!.split(',')).toEqual(EXPORT_COLUMNS.map((c) => c.header));
    expect(lines[2]).toContain('Synthetic Lead 001');
    expect(lines[2]).toContain('"Baner, Wakad"');
    expect(lines).toHaveLength(4); // trailing CRLF
  });

  it.each([
    ['=HYPERLINK("http://example.invalid")', `"'=HYPERLINK(""http://example.invalid"")"`],
    ['+919000000001', "'+919000000001"],
    ['-2+3', "'-2+3"],
    ['@SUM(A1)', "'@SUM(A1)"],
    ['\tTab', "'\tTab"],
    ['plain', 'plain'],
    ['has "quote", comma', '"has ""quote"", comma"'],
  ])('neutralises %j', (input, out) => {
    expect(csvCell(input)).toBe(out);
  });

  it('a formula hidden in a lead field is exported as inert text', () => {
    const csv = leadsToCsv([row({ fullName: '=cmd|"/c calc"!A0' })], w);
    expect(csv).toContain(`"'=cmd|""/c calc""!A0"`);
    expect(csv).not.toMatch(/(^|,)=cmd/m);
  });

  it('refuses more than the row cap instead of truncating', () => {
    const many = Array.from({ length: EXPORT_ROW_CAP + 1 }, () => row());
    expect(() => leadsToCsv(many, w)).toThrow(ExportTooLarge);
    expect(() => leadsToCsv(many.slice(1), w)).not.toThrow();
  });

  it('audit metadata carries counts only', () => {
    expect(exportAuditMetadata(12)).toEqual({
      rows: 12,
      piiColumns: 4,
      columns: EXPORT_COLUMNS.length,
    });
  });
});

describe('the 50,000-row boundary', () => {
  it('request-time check: 50,000 is allowed, 50,001 is refused', () => {
    expect(exportRowCountAllowed(EXPORT_ROW_CAP)).toBe(true);
    expect(exportRowCountAllowed(EXPORT_ROW_CAP + 1)).toBe(false);
    expect(exportRowCountAllowed(0)).toBe(true);
  });
});
