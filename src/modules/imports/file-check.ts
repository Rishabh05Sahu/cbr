// Import file checks (FR-040, threat model T6). Two stages:
//   1. checkDeclaredFile: before an upload is authorised, on the browser-declared name, size and
//      type. Cheap; trusted for nothing except refusing obviously wrong files early.
//   2. inspectFileBytes: on the stored bytes, before any parser runs: signature (magic bytes),
//      encoding, and for XLSX the zip structure, macros, encryption, sheet count and real
//      decompressed sizes.
// Codes are stable and shown to users with a fixed message; no file content is echoed.
import type { ImportLimits } from './limits';
import { listZipEntries, readZipEntry, ZipFormatError } from './zip';

export type ImportFileType = 'csv' | 'xlsx';

export const CONTENT_TYPES: Record<ImportFileType, string> = {
  csv: 'text/csv',
  xlsx: 'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet',
};

/** What browsers report for these files (Windows often says application/vnd.ms-excel for CSV). */
const DECLARED_TYPES: Record<ImportFileType, readonly string[]> = {
  csv: ['', 'text/csv', 'application/csv', 'text/plain', 'application/vnd.ms-excel'],
  xlsx: ['', CONTENT_TYPES.xlsx, 'application/octet-stream', 'application/zip'],
};

export type FileCheckCode =
  | 'FILE_EMPTY'
  | 'FILE_TOO_LARGE'
  | 'FILE_NAME_INVALID'
  | 'FILE_TYPE_UNSUPPORTED'
  | 'FILE_MACRO_OR_LEGACY'
  | 'FILE_TYPE_MISMATCH'
  | 'FILE_ENCRYPTED'
  | 'FILE_CORRUPT'
  | 'FILE_TOO_COMPLEX'
  | 'FILE_TOO_MANY_SHEETS'
  | 'FILE_NO_SHEETS'
  | 'FILE_ENCODING';

export const FILE_CHECK_MESSAGES: Record<FileCheckCode, string> = {
  FILE_EMPTY: 'The file is empty.',
  FILE_TOO_LARGE: 'The file is larger than the allowed upload size.',
  FILE_NAME_INVALID: 'The file name is not usable. Rename the file and try again.',
  FILE_TYPE_UNSUPPORTED: 'Only .csv and .xlsx files can be imported.',
  FILE_MACRO_OR_LEGACY:
    'Macro-enabled and old Excel formats (.xlsm, .xls, .xlsb) are not accepted. Save as .xlsx or CSV.',
  FILE_TYPE_MISMATCH: 'The file contents do not match its extension.',
  FILE_ENCRYPTED: 'Password-protected files cannot be imported. Remove the password and re-save.',
  FILE_CORRUPT: 'The file is damaged or not a valid spreadsheet.',
  FILE_TOO_COMPLEX: 'The file is too large or complex to import safely. Split it and try again.',
  FILE_TOO_MANY_SHEETS: 'The workbook has too many worksheets. Keep only the sheet to import.',
  FILE_NO_SHEETS: 'The workbook has no worksheets.',
  FILE_ENCODING: 'Save the CSV as "CSV UTF-8" and try again.',
};

export type FileCheck<T> = { ok: true; value: T } | { ok: false; code: FileCheckCode };

const fail = (code: FileCheckCode) => ({ ok: false, code }) as const;

export interface DeclaredFile {
  name: string;
  size: number;
  type: string;
}

export interface AcceptedFile {
  fileType: ImportFileType;
  /** Canonical type the server grants and later verifies; never the browser's claim. */
  contentType: string;
  /** Display-only name (no path, no control characters, ≤ 200 chars). Never a storage key. */
  displayName: string;
}

/** Display-safe file name: last path segment, printable characters only. */
export function displayFileName(name: string): string {
  const last = name.split(/[\\/]/).pop() ?? '';
  const clean = last.replace(/[\u0000-\u001f\u007f-\u009f‪-‮⁦-⁩]/g, '').trim();
  return clean.length > 200 ? clean.slice(0, 200) : clean;
}

export function checkDeclaredFile(f: DeclaredFile, limits: ImportLimits): FileCheck<AcceptedFile> {
  const displayName = displayFileName(f.name);
  if (!displayName) return fail('FILE_NAME_INVALID');
  const ext = /\.([a-z0-9]{1,8})$/i.exec(displayName)?.[1]?.toLowerCase();
  if (ext === 'xlsm' || ext === 'xls' || ext === 'xlsb' || ext === 'xltm')
    return fail('FILE_MACRO_OR_LEGACY');
  if (ext !== 'csv' && ext !== 'xlsx') return fail('FILE_TYPE_UNSUPPORTED');
  if (!Number.isSafeInteger(f.size) || f.size <= 0) return fail('FILE_EMPTY');
  if (f.size > limits.maxBytes) return fail('FILE_TOO_LARGE');
  if (!DECLARED_TYPES[ext].includes(f.type.toLowerCase().split(';')[0]!.trim()))
    return fail('FILE_TYPE_MISMATCH');
  return { ok: true, value: { fileType: ext, contentType: CONTENT_TYPES[ext], displayName } };
}

const startsWith = (b: Uint8Array, sig: number[]) => sig.every((x, i) => b[i] === x);
const ZIP = [0x50, 0x4b, 0x03, 0x04];
const OLE = [0xd0, 0xcf, 0x11, 0xe0, 0xa1, 0xb1, 0x1a, 0xe1]; // .xls and encrypted OOXML

export interface InspectedFile {
  /** Worksheet entry count for XLSX; 1 for CSV. */
  sheets: number;
}

/**
 * Checks stored bytes before parsing. XLSX: a well-formed zip with an OOXML workbook, no VBA or
 * ActiveX parts, no encrypted entries, at most `maxSheets` worksheets, and every entry inflating
 * to exactly its declared size within the total and ratio limits. CSV: UTF-8 text without NUL
 * bytes. Nothing is executed or fetched.
 */
export function inspectFileBytes(
  bytes: Uint8Array,
  fileType: ImportFileType,
  limits: ImportLimits,
): FileCheck<InspectedFile> {
  if (bytes.byteLength === 0) return fail('FILE_EMPTY');
  if (bytes.byteLength > limits.maxBytes) return fail('FILE_TOO_LARGE');
  if (fileType === 'csv') {
    if (startsWith(bytes, ZIP) || startsWith(bytes, OLE)) return fail('FILE_TYPE_MISMATCH');
    if (startsWith(bytes, [0xff, 0xfe]) || startsWith(bytes, [0xfe, 0xff]))
      return fail('FILE_ENCODING');
    if (bytes.includes(0)) return fail('FILE_TYPE_MISMATCH');
    try {
      new TextDecoder('utf-8', { fatal: true }).decode(bytes);
    } catch {
      return fail('FILE_ENCODING');
    }
    return { ok: true, value: { sheets: 1 } };
  }

  if (startsWith(bytes, OLE)) return fail('FILE_ENCRYPTED');
  if (!startsWith(bytes, ZIP)) return fail('FILE_TYPE_MISMATCH');
  try {
    const entries = listZipEntries(bytes, limits.maxZipEntries);
    const names = new Set(entries.map((e) => e.name));
    if (!names.has('[Content_Types].xml') || !names.has('xl/workbook.xml'))
      return fail('FILE_TYPE_MISMATCH');
    if (entries.some((e) => /(^|\/)vbaProject\.bin$|^xl\/activeX\//i.test(e.name)))
      return fail('FILE_MACRO_OR_LEGACY');
    if (entries.some((e) => e.encrypted)) return fail('FILE_ENCRYPTED');
    const sheets = entries.filter((e) => /^xl\/worksheets\/sheet\d+\.xml$/.test(e.name)).length;
    if (sheets === 0) return fail('FILE_NO_SHEETS');
    if (sheets > limits.maxSheets) return fail('FILE_TOO_MANY_SHEETS');
    let total = 0;
    for (const e of entries) {
      total += e.uncompressedSize;
      if (total > limits.maxUncompressedBytes) return fail('FILE_TOO_COMPLEX');
      if (e.uncompressedSize > Math.max(e.compressedSize, 1) * limits.maxCompressionRatio)
        return fail('FILE_TOO_COMPLEX');
    }
    // Declared sizes can lie: inflate everything under a hard cap and compare.
    for (const e of entries) {
      if (e.name.endsWith('/')) continue;
      readZipEntry(bytes, e, limits.maxUncompressedBytes);
    }
    return { ok: true, value: { sheets } };
  } catch (e) {
    if (e instanceof ZipFormatError)
      return fail(e.message === 'too many entries' ? 'FILE_TOO_COMPLEX' : 'FILE_CORRUPT');
    throw e;
  }
}
