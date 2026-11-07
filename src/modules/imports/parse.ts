// Spreadsheet parsing (FR-040, FR-041, OD-08). Runs only in the worker, and only on bytes that
// already passed inspectFileBytes (size, encoding, zip structure and zip-bomb limits). The
// readers return saved cell values: formulas are never evaluated (a formula without a cached
// value reads as empty), macro files were refused earlier, and nothing is fetched. Failures
// become fixed codes; reader messages (which can quote sheet names or cell text) are never
// surfaced or logged.
import { parse as parseCsv } from 'csv-parse/sync';
import { readSheet, SheetNotFoundError } from 'read-excel-file/node';
import type { ImportFileType } from './file-check';
import type { ImportLimits } from './limits';
import { cellText, type Cell } from './rows';
import { listZipEntries, readZipEntry } from './zip';

export { PARSE_MESSAGES } from './messages';

export type ParseCode =
  'PARSE_FAILED' | 'PARSE_TIMEOUT' | 'SHEET_NOT_FOUND' | 'HEADER_MISSING' | 'TOO_MANY_ROWS';

export interface ParsedFile {
  /** XLSX worksheets in workbook order; empty for CSV. */
  sheetNames: string[];
  /** The worksheet read; null for CSV. */
  sheetName: string | null;
  /** 1-based spreadsheet row of the header. */
  headerRow: number;
  headers: string[];
  /** Data rows after the header: rows[i] is spreadsheet row headerRow + 1 + i. */
  rows: Cell[][];
}

export type ParseResult =
  { ok: true; value: ParsedFile } | { ok: false; code: ParseCode; row?: number };

/** The header is the first row with any text, within this many rows from the top. */
export const HEADER_SEARCH_ROWS = 20;
/** Longest CSV record (all fields of one row) the reader buffers. */
const CSV_MAX_RECORD_CHARS = 65_536;
const SHEET_NAME_MAX = 100;

/**
 * Parses one worksheet (XLSX: `sheet`, else the first) or the CSV. Row and column limits apply
 * to the header and data rows; cell length is checked per row by validateRow.
 */
export async function parseImportFile(
  bytes: Uint8Array,
  fileType: ImportFileType,
  limits: Pick<
    ImportLimits,
    'maxRows' | 'maxSheets' | 'maxZipEntries' | 'maxUncompressedBytes' | 'parseTimeoutMs'
  >,
  sheet?: string | null,
): Promise<ParseResult> {
  const maxRecords = limits.maxRows + HEADER_SEARCH_ROWS + 1;
  let sheetNames: string[] = [];
  let sheetName: string | null = null;
  let grid: Cell[][];
  try {
    if (fileType === 'csv') {
      grid = await withBudget(
        Promise.resolve().then(() => readCsv(bytes, maxRecords)),
        limits,
      );
    } else {
      sheetNames = listSheetNames(bytes, limits);
      if (sheetNames.length === 0) return { ok: false, code: 'PARSE_FAILED' };
      sheetName = sheet ?? sheetNames[0]!;
      if (!sheetNames.includes(sheetName)) return { ok: false, code: 'SHEET_NOT_FOUND' };
      grid = (await withBudget(
        readSheet(Buffer.from(bytes.buffer, bytes.byteOffset, bytes.byteLength), sheetName, {
          // Keep numbers as their saved text: phone numbers and budgets keep every digit.
          parseNumber: (s: string) => s,
          trim: false,
        }),
        limits,
      )) as Cell[][];
    }
  } catch (e) {
    if (e instanceof BudgetExceeded) return { ok: false, code: 'PARSE_TIMEOUT' };
    if (e instanceof SheetNotFoundError) return { ok: false, code: 'SHEET_NOT_FOUND' };
    const line = (e as { lines?: unknown }).lines;
    return typeof line === 'number'
      ? { ok: false, code: 'PARSE_FAILED', row: line }
      : { ok: false, code: 'PARSE_FAILED' };
  }

  const headerIndex = grid
    .slice(0, HEADER_SEARCH_ROWS)
    .findIndex((r) => r.some((c) => cellText(c) !== ''));
  if (headerIndex < 0) return { ok: false, code: 'HEADER_MISSING' };
  const headerCells = grid[headerIndex]!.map(cellText);
  let width = headerCells.length;
  while (width > 0 && headerCells[width - 1] === '') width--;

  let end = grid.length;
  while (end > headerIndex + 1 && grid[end - 1]!.every((c) => cellText(c) === '')) end--;
  if (end - headerIndex - 1 > limits.maxRows) return { ok: false, code: 'TOO_MANY_ROWS' };

  return {
    ok: true,
    value: {
      sheetNames,
      sheetName,
      headerRow: headerIndex + 1,
      headers: headerCells.slice(0, width),
      rows: grid.slice(headerIndex + 1, end),
    },
  };
}

/** Worksheet names from xl/workbook.xml, in workbook order, via the bounds-checked zip reader. */
export function listSheetNames(
  bytes: Uint8Array,
  limits: Pick<ImportLimits, 'maxSheets' | 'maxZipEntries' | 'maxUncompressedBytes'>,
): string[] {
  const entry = listZipEntries(bytes, limits.maxZipEntries).find(
    (e) => e.name === 'xl/workbook.xml',
  );
  if (!entry) return [];
  const xml = new TextDecoder().decode(readZipEntry(bytes, entry, limits.maxUncompressedBytes));
  const names: string[] = [];
  for (const m of xml.matchAll(/<(?:[A-Za-z_][\w.-]*:)?sheet\b([^>]*?)\/?>/g)) {
    const name = /\bname\s*=\s*"([^"]*)"/.exec(m[1]!)?.[1];
    if (name === undefined) continue;
    names.push(
      decodeXml(name)
        .replace(/[\p{Cc}\p{Cf}]/gu, '')
        .slice(0, SHEET_NAME_MAX),
    );
    if (names.length > limits.maxSheets) break;
  }
  return names;
}

function decodeXml(s: string): string {
  return s.replace(/&(#x[0-9a-f]+|#\d+|amp|lt|gt|quot|apos);/gi, (_, ent: string) => {
    const e = ent.toLowerCase();
    if (e === 'amp') return '&';
    if (e === 'lt') return '<';
    if (e === 'gt') return '>';
    if (e === 'quot') return '"';
    if (e === 'apos') return "'";
    const code = e.startsWith('#x') ? parseInt(e.slice(2), 16) : parseInt(e.slice(1), 10);
    return code > 0 && code <= 0x10ffff ? String.fromCodePoint(code) : '';
  });
}

/** CSV as text records. The delimiter is the most frequent of `,` `;` and tab on the first line. */
function readCsv(bytes: Uint8Array, maxRecords: number): Cell[][] {
  const text = new TextDecoder('utf-8', { fatal: true }).decode(bytes);
  const firstLine = text.slice(0, text.search(/\r?\n|$/));
  const delimiter = [',', ';', '\t'].reduce((best, d) =>
    firstLine.split(d).length > firstLine.split(best).length ? d : best,
  );
  return parseCsv(text, {
    bom: true,
    delimiter,
    relax_column_count: true,
    skip_empty_lines: false,
    max_record_size: CSV_MAX_RECORD_CHARS,
    to: maxRecords,
  }) as string[][];
}

class BudgetExceeded extends Error {}

/** Wall-clock budget for one parse. Bounded input sizes keep the reader itself finite. */
async function withBudget<T>(work: Promise<T>, limits: { parseTimeoutMs: number }): Promise<T> {
  let timer: NodeJS.Timeout | undefined;
  const budget = new Promise<never>((_, reject) => {
    timer = setTimeout(() => reject(new BudgetExceeded()), limits.parseTimeoutMs);
  });
  try {
    return await Promise.race([work, budget]);
  } finally {
    clearTimeout(timer);
  }
}
