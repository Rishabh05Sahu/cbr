// Import safety limits (FR-040, threat model T6/T20). One place, documented in
// docs/PHASE-2-M4-REPORT.md. The byte limit comes from IMPORT_MAX_BYTES (default 20 MB, never
// above Supabase Free's 50 MB object limit); the rest are code constants until an org/plan
// setting exists.

export interface ImportLimits {
  /** Upload size. */
  maxBytes: number;
  /** Data rows after the header (FR-040: 100,000). */
  maxRows: number;
  /** Columns in the header row. */
  maxColumns: number;
  /** Worksheets in a workbook (OD-08: the user chooses one). */
  maxSheets: number;
  /** Characters in one cell (notes are up to 5,000). */
  maxCellChars: number;
  /** Characters in one header cell. */
  maxHeaderChars: number;
  /** Entries in an XLSX zip. */
  maxZipEntries: number;
  /** Total declared and actual uncompressed size of an XLSX. */
  maxUncompressedBytes: number;
  /** Per-entry compression ratio above which an XLSX is treated as a zip bomb. */
  maxCompressionRatio: number;
  /** Wall-clock budget for parsing one file in the worker. */
  parseTimeoutMs: number;
  /** Rows shown in the mapping preview (FR-041). */
  previewRows: number;
  /** Rows committed per transaction. */
  batchRows: number;
}

export const DEFAULT_IMPORT_LIMITS: Omit<ImportLimits, 'maxBytes'> = {
  maxRows: 100_000,
  maxColumns: 100,
  maxSheets: 20,
  maxCellChars: 5_000,
  maxHeaderChars: 200,
  maxZipEntries: 2_000,
  maxUncompressedBytes: 256 * 1024 * 1024,
  maxCompressionRatio: 200,
  parseTimeoutMs: 120_000,
  previewRows: 50,
  batchRows: 200,
};

export const SUPABASE_FREE_OBJECT_LIMIT = 50 * 1024 * 1024;

export function importLimits(maxBytes: number): ImportLimits {
  return { ...DEFAULT_IMPORT_LIMITS, maxBytes: Math.min(maxBytes, SUPABASE_FREE_OBJECT_LIMIT) };
}
