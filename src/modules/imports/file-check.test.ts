// File checks against synthetic files built in memory (no real customer files).
import { describe, expect, it } from 'vitest';
import { zip, type ZipPart as Part } from '../../../tests/support/spreadsheets';
import { checkDeclaredFile, displayFileName, inspectFileBytes } from './file-check';
import { importLimits } from './limits';

const limits = importLimits(20 * 1024 * 1024);

const sheet =
  '<worksheet><sheetData><row><c t="inlineStr"><is><t>Name</t></is></c></row></sheetData></worksheet>';
const workbook = (extra: Part[] = [], sheets = 1): Part[] => [
  { name: '[Content_Types].xml', data: '<Types/>' },
  { name: 'xl/workbook.xml', data: '<workbook/>' },
  ...Array.from({ length: sheets }, (_, i) => ({
    name: `xl/worksheets/sheet${i + 1}.xml`,
    data: sheet,
  })),
  ...extra,
];
const inspect = (bytes: Uint8Array, type: 'csv' | 'xlsx' = 'xlsx') =>
  inspectFileBytes(bytes, type, limits);

describe('checkDeclaredFile (before upload)', () => {
  const ok = { name: 'leads.csv', size: 100, type: 'text/csv' };

  it('accepts CSV and XLSX with the types browsers really send, and returns canonical types', () => {
    expect(checkDeclaredFile(ok, limits)).toMatchObject({
      ok: true,
      value: { fileType: 'csv', contentType: 'text/csv', displayName: 'leads.csv' },
    });
    expect(checkDeclaredFile({ ...ok, type: 'application/vnd.ms-excel' }, limits).ok).toBe(true);
    expect(
      checkDeclaredFile({ name: 'Leads.XLSX', size: 5, type: 'application/octet-stream' }, limits),
    ).toMatchObject({ ok: true, value: { fileType: 'xlsx' } });
  });

  it.each([
    [{ name: 'leads.xlsm' }, 'FILE_MACRO_OR_LEGACY'],
    [{ name: 'leads.xls' }, 'FILE_MACRO_OR_LEGACY'],
    [{ name: 'leads.xlsb' }, 'FILE_MACRO_OR_LEGACY'],
    [{ name: 'leads.exe' }, 'FILE_TYPE_UNSUPPORTED'],
    [{ name: 'leads' }, 'FILE_TYPE_UNSUPPORTED'],
    [{ name: '   ' }, 'FILE_NAME_INVALID'],
    [{ size: 0 }, 'FILE_EMPTY'],
    [{ size: 20 * 1024 * 1024 + 1 }, 'FILE_TOO_LARGE'],
    [{ type: 'application/pdf' }, 'FILE_TYPE_MISMATCH'],
  ])('rejects %j with %s', (patch, code) => {
    expect(checkDeclaredFile({ ...ok, ...patch }, limits)).toEqual({ ok: false, code });
  });

  it('never caps the limit above the Supabase Free object limit', () => {
    expect(importLimits(500 * 1024 * 1024).maxBytes).toBe(50 * 1024 * 1024);
  });

  it('display names drop paths and control/bidi characters', () => {
    expect(displayFileName('C:\\Users\\x\\leads\u202e.csv')).toBe('leads.csv');
    expect(displayFileName('../../etc/leads.csv')).toBe('leads.csv');
  });
});

describe('inspectFileBytes (stored bytes, before parsing)', () => {
  it('accepts a plain workbook and counts worksheets', () => {
    expect(inspect(zip(workbook([], 3)))).toEqual({ ok: true, value: { sheets: 3 } });
  });

  it('rejects macros and ActiveX even under an .xlsx name', () => {
    expect(inspect(zip(workbook([{ name: 'xl/vbaProject.bin', data: 'x' }])))).toEqual({
      ok: false,
      code: 'FILE_MACRO_OR_LEGACY',
    });
    expect(inspect(zip(workbook([{ name: 'xl/activeX/activeX1.xml', data: 'x' }]))).ok).toBe(false);
  });

  it('rejects encrypted or legacy (OLE) files and encrypted zip entries', () => {
    const ole = new Uint8Array([0xd0, 0xcf, 0x11, 0xe0, 0xa1, 0xb1, 0x1a, 0xe1, 0, 0]);
    expect(inspect(ole)).toEqual({ ok: false, code: 'FILE_ENCRYPTED' });
    const enc = zip(workbook().map((p, i) => (i === 2 ? { ...p, encrypted: true } : p)));
    expect(inspect(enc)).toEqual({ ok: false, code: 'FILE_ENCRYPTED' });
  });

  it('rejects files whose content does not match the extension', () => {
    expect(inspect(new TextEncoder().encode('name,phone\n'))).toEqual({
      ok: false,
      code: 'FILE_TYPE_MISMATCH',
    });
    expect(inspect(zip([{ name: 'word/document.xml', data: 'x' }]))).toEqual({
      ok: false,
      code: 'FILE_TYPE_MISMATCH',
    });
    expect(inspect(zip(workbook()), 'csv')).toEqual({ ok: false, code: 'FILE_TYPE_MISMATCH' });
  });

  it('rejects too many sheets, no sheets and truncated archives', () => {
    expect(inspect(zip(workbook([], 21)))).toEqual({ ok: false, code: 'FILE_TOO_MANY_SHEETS' });
    expect(inspect(zip(workbook([], 0)))).toEqual({ ok: false, code: 'FILE_NO_SHEETS' });
    const good = zip(workbook());
    expect(inspect(good.subarray(0, good.length - 30))).toEqual({
      ok: false,
      code: 'FILE_CORRUPT',
    });
  });

  it('stops zip bombs by ratio, by total size, and when declared sizes lie', () => {
    const bomb = '0'.repeat(5 * 1024 * 1024);
    expect(inspect(zip(workbook([{ name: 'xl/sharedStrings.xml', data: bomb }])))).toEqual({
      ok: false,
      code: 'FILE_TOO_COMPLEX',
    });
    // Declares 100 bytes but inflates to ~1 MB: caught while inflating under the cap.
    const liar = { name: 'xl/sharedStrings.xml', data: 'ab'.repeat(512 * 1024), declaredSize: 100 };
    expect(inspect(zip(workbook([liar])))).toEqual({ ok: false, code: 'FILE_CORRUPT' });
    const small = { ...limits, maxUncompressedBytes: 1000 };
    const big = zip(workbook([{ name: 'xl/styles.xml', data: 'x'.repeat(2000), store: true }]));
    expect(inspectFileBytes(big, 'xlsx', small)).toEqual({ ok: false, code: 'FILE_TOO_COMPLEX' });
  });

  it('CSV: UTF-8 only, no binary content', () => {
    const enc = (s: string) => new TextEncoder().encode(s);
    expect(inspect(enc('\ufeffName,Phone\nAsha,98765 43210\n'), 'csv').ok).toBe(true);
    expect(inspect(new Uint8Array([0x4e, 0xe9, 0x0a]), 'csv')).toEqual({
      ok: false,
      code: 'FILE_ENCODING',
    });
    expect(inspect(new Uint8Array([0xff, 0xfe, 0x4e, 0]), 'csv')).toEqual({
      ok: false,
      code: 'FILE_ENCODING',
    });
    expect(inspect(enc('a,b\n\u0000\n'), 'csv')).toEqual({ ok: false, code: 'FILE_TYPE_MISMATCH' });
    expect(inspect(new Uint8Array(), 'csv')).toEqual({ ok: false, code: 'FILE_EMPTY' });
  });
});
