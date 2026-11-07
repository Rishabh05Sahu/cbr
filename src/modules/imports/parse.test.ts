// Parsing against synthetic files built in memory (no real customer files).
import { describe, expect, it } from 'vitest';
import { xlsx, zip } from '../../../tests/support/spreadsheets';
import { inspectFileBytes } from './file-check';
import { importLimits } from './limits';
import { listSheetNames, parseImportFile } from './parse';

const limits = importLimits(20 * 1024 * 1024);
const csv = (s: string) => new TextEncoder().encode(s);

describe('parseImportFile: XLSX', () => {
  it('reads saved values: numbers keep every digit, dates are dates, formulas never run', async () => {
    const file = xlsx({
      Leads: [
        ['Name', 'Phone', 'Budget', 'Enquired', 'Link', 'Calc'],
        [
          'Asha',
          9876543210,
          15000000,
          { date: new Date('2026-01-15T00:00:00Z') },
          { f: 'HYPERLINK("http://example.invalid","Click")', v: 'Click' },
          { f: '1+1' },
        ],
      ],
    });
    expect(inspectFileBytes(file, 'xlsx', limits).ok).toBe(true);
    const r = await parseImportFile(file, 'xlsx', limits);
    expect(r.ok).toBe(true);
    if (!r.ok) return;
    expect(r.value).toMatchObject({
      sheetNames: ['Leads'],
      sheetName: 'Leads',
      headerRow: 1,
      headers: ['Name', 'Phone', 'Budget', 'Enquired', 'Link', 'Calc'],
    });
    const [row] = r.value.rows;
    expect(row!.slice(0, 3)).toEqual(['Asha', '9876543210', '15000000']);
    expect(row![3]).toBeInstanceOf(Date);
    // The cached display value only; a formula with no cached value is empty.
    expect(row![4]).toBe('Click');
    expect(row![5]).toBeNull();
  });

  it('lists sheets in workbook order and reads the chosen one', async () => {
    const file = xlsx({ 'Summary & notes': [['x']], Leads: [['Name'], ['Asha']] });
    expect(listSheetNames(file, limits)).toEqual(['Summary & notes', 'Leads']);
    const r = await parseImportFile(file, 'xlsx', limits, 'Leads');
    expect(r).toMatchObject({ ok: true, value: { sheetName: 'Leads', rows: [['Asha']] } });
    expect(await parseImportFile(file, 'xlsx', limits, 'Missing')).toEqual({
      ok: false,
      code: 'SHEET_NOT_FOUND',
    });
  });

  it('keeps spreadsheet row numbers: header below blank rows, gaps kept, trailing blanks dropped', async () => {
    const file = xlsx({
      S: [null, ['', ''], ['Name', 'Phone', ''], ['A', '1'], null, ['B', '2'], null],
    });
    const r = await parseImportFile(file, 'xlsx', limits);
    expect(r.ok).toBe(true);
    if (!r.ok) return;
    expect(r.value.headerRow).toBe(3);
    expect(r.value.headers).toEqual(['Name', 'Phone']);
    expect(r.value.rows).toHaveLength(3); // rows 4, 5 (blank), 6
    expect(r.value.rows[2]!.slice(0, 2)).toEqual(['B', '2']);
  });

  it('refuses a sheet with no header, too many rows, or unreadable content', async () => {
    expect(await parseImportFile(xlsx({ S: [] }), 'xlsx', limits)).toEqual({
      ok: false,
      code: 'HEADER_MISSING',
    });
    const rows = [['Name'], ...Array.from({ length: 6 }, (_, i) => [`n${i}`])];
    expect(await parseImportFile(xlsx({ S: rows }), 'xlsx', { ...limits, maxRows: 5 })).toEqual({
      ok: false,
      code: 'TOO_MANY_ROWS',
    });
    const broken = zip([
      { name: '[Content_Types].xml', data: '<Types/>' },
      { name: 'xl/workbook.xml', data: '<workbook><sheets><sheet name="S"/></sheets></workbook>' },
      { name: 'xl/worksheets/sheet1.xml', data: '<worksheet><sheetData><row' },
    ]);
    expect(await parseImportFile(broken, 'xlsx', limits)).toMatchObject({
      ok: false,
      code: 'PARSE_FAILED',
    });
  });

  it('reads 100,000 rows within the parse budget', async () => {
    const big = xlsx({
      S: [
        ['Name', 'Phone', 'City'],
        ...Array.from({ length: 100_000 }, (_, i) => [`Lead ${i}`, 9_800_000_000 + i, 'Pune']),
      ],
    });
    expect(big.byteLength).toBeLessThan(limits.maxBytes);
    expect(inspectFileBytes(big, 'xlsx', limits).ok).toBe(true);
    const started = Date.now();
    const r = await parseImportFile(big, 'xlsx', limits);
    expect(r).toMatchObject({ ok: true });
    if (r.ok) expect(r.value.rows).toHaveLength(100_000);
    expect(Date.now() - started).toBeLessThan(limits.parseTimeoutMs);
  }, 60_000);
});

describe('parseImportFile: CSV', () => {
  it('handles BOM, quoted commas and newlines, ragged rows, and keeps text as text', async () => {
    const r = await parseImportFile(
      csv(
        '﻿Name,Phone,Notes\r\nAsha,09876543210,"Wants 2 BHK, near metro\nCall after 6"\r\nRavi,+91 98765 43211\r\n\r\n',
      ),
      'csv',
      limits,
    );
    expect(r).toEqual({
      ok: true,
      value: {
        sheetNames: [],
        sheetName: null,
        headerRow: 1,
        headers: ['Name', 'Phone', 'Notes'],
        rows: [
          ['Asha', '09876543210', 'Wants 2 BHK, near metro\nCall after 6'],
          ['Ravi', '+91 98765 43211'],
        ],
      },
    });
  });

  it('detects semicolon and tab delimiters from the header line', async () => {
    const semi = await parseImportFile(csv('Name;Phone\nAsha;98765 43210\n'), 'csv', limits);
    expect(semi).toMatchObject({ ok: true, value: { rows: [['Asha', '98765 43210']] } });
    const tab = await parseImportFile(csv('Name\tPhone\nAsha\t9876543210\n'), 'csv', limits);
    expect(tab).toMatchObject({ ok: true, value: { headers: ['Name', 'Phone'] } });
  });

  it('formula-looking text stays inert text', async () => {
    const r = await parseImportFile(csv('Name,Phone\n=cmd|calc,9876543210\n'), 'csv', limits);
    expect(r).toMatchObject({ ok: true, value: { rows: [['=cmd|calc', '9876543210']] } });
  });

  it('refuses malformed quoting (with its line), too many rows and an empty file', async () => {
    expect(await parseImportFile(csv('Name,Phone\n"Asha,98765\n'), 'csv', limits)).toMatchObject({
      ok: false,
      code: 'PARSE_FAILED',
    });
    const many = csv('Name\n' + 'x\n'.repeat(6));
    expect(await parseImportFile(many, 'csv', { ...limits, maxRows: 5 })).toEqual({
      ok: false,
      code: 'TOO_MANY_ROWS',
    });
    expect(await parseImportFile(csv('\n\n'), 'csv', limits)).toEqual({
      ok: false,
      code: 'HEADER_MISSING',
    });
  });
});
