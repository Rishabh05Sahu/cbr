// The SYNTHETIC M6 import corpus through the real file checks, parser, mapping suggestion, row
// validation and in-file duplicate detection (no database). Matches against existing leads are
// exercised separately on the isolated crm_perf database (scripts/perf/import-run.mts).
import { describe, expect, it } from 'vitest';
import {
  checkHeaders,
  importLimits,
  InFileDuplicates,
  inspectFileBytes,
  suggestMapping,
  validateRow,
} from '@/modules/imports';
import { parseImportFile } from '@/modules/imports/parse';
import type { RowContext } from '@/modules/imports/rows';
import type { CustomFieldDefinition } from '@/modules/leads';
import {
  CORPUS_CUSTOM_FIELDS,
  corpusFiles,
  customFieldRows,
  LARGE_TARGET_BYTES,
  Q4_EXPECTED_FIELDS,
  VARIANT_EXPECTED_FIELDS,
} from './import-corpus';

const MAX = 20 * 1024 * 1024;
const limits = importLimits(MAX);
const defs = CORPUS_CUSTOM_FIELDS as unknown as CustomFieldDefinition[];
const ctx: RowContext = {
  sourcesByName: new Map(),
  defaultSourceId: '0199a000-0000-7000-8000-000000000001',
  limits,
  customFields: defs,
};
const customMapping = defs.map((d) => ({ key: d.key, label: d.label, required: d.required }));
// Only the custom-field file belongs to an org with these fields; an org with an unmapped required
// custom field could not import the other files at all (REQUIRED_UNMAPPED at the mapping step).
const plainCtx: RowContext = { ...ctx, customFields: [] };

async function run(bytes: Uint8Array, type: 'csv' | 'xlsx', sheet?: string, custom = false) {
  const rowCtx = custom ? ctx : plainCtx;
  const check = inspectFileBytes(bytes, type, limits);
  expect(check.ok).toBe(true);
  const parsed = await parseImportFile(bytes, type, limits, sheet ?? null);
  if (!parsed.ok) throw new Error(`parse failed: ${parsed.code}`);
  const file = parsed.value;
  expect(checkHeaders(file.headers, limits).fatal).toEqual([]);
  const mapping = suggestMapping(file.headers, custom ? customMapping : []);
  const dup = new InFileDuplicates();
  const counts = { total: 0, valid: 0, invalid: 0, empty: 0, duplicateInFile: 0 };
  const outcomes: { row: number; kind: string; issues?: string[]; of?: number }[] = [];
  file.rows.forEach((cells, i) => {
    const row = file.headerRow + 1 + i;
    counts.total++;
    const r = validateRow(cells, row, mapping, rowCtx);
    if (r.status === 'EMPTY') {
      counts.empty++;
      outcomes.push({ row, kind: 'EMPTY' });
    } else if (r.status === 'INVALID') {
      counts.invalid++;
      outcomes.push({
        row,
        kind: 'INVALID',
        issues: r.issues.map((x) => `${x.field}|${x.code}`).sort(),
      });
    } else {
      const of = dup.check(row, r.lead.phones);
      if (of !== null) {
        counts.duplicateInFile++;
        outcomes.push({ row, kind: 'DUPLICATE_IN_FILE', of });
      } else {
        counts.valid++;
        outcomes.push({ row, kind: 'VALID' });
      }
    }
  });
  return { file, mapping, counts, outcomes };
}

const files = corpusFiles();
const file = (name: string) => files.find((f) => f.name === name)!;

describe('synthetic import corpus', () => {
  it('custom fields: every row has exactly its expected outcome and codes', async () => {
    const f = file('corpus_custom_fields.csv');
    const { mapping, outcomes, counts } = await run(f.bytes(), 'csv', undefined, true);
    for (const d of defs) expect(mapping).toHaveProperty(`custom:${d.key}`);
    const want = customFieldRows().map((r) => {
      const row = r.n + 1;
      if (r.expect.kind === 'INVALID')
        return {
          row,
          kind: 'INVALID',
          issues: r.expect.issues.map(([fl, c]) => `${fl}|${c}`).sort(),
        };
      if (r.expect.kind === 'DUPLICATE_IN_FILE')
        return { row, kind: 'DUPLICATE_IN_FILE', of: r.expect.of + 1 };
      return { row, kind: r.expect.kind };
    });
    expect(outcomes).toEqual(want);
    const { existing, ...rest } = f.expected;
    expect(existing).toBe(0);
    expect(counts).toEqual(rest);
  });

  it('multi-sheet XLSX: the chosen sheet is read and its header vocabulary is recognised', async () => {
    const f = file('corpus_multisheet.xlsx');
    const { file: parsed, mapping, counts } = await run(f.bytes(), 'xlsx', 'Leads Q4');
    expect(parsed.sheetNames).toEqual(['Read me', 'Leads Q3', 'Leads Q4']);
    expect(parsed.sheetName).toBe('Leads Q4');
    expect(Object.keys(mapping).sort()).toEqual([...Q4_EXPECTED_FIELDS].sort());
    const { existing, ...rest } = f.expected;
    void existing;
    expect(counts).toEqual(rest);
    // The other lead sheet (numeric phone cells, a single "Budget" column) is valid too.
    expect((await run(f.bytes(), 'xlsx', 'Leads Q3')).counts.valid).toBe(150);
  });

  it('variants: a third header vocabulary maps fully; every phone and budget spelling is accepted', async () => {
    const f = file('corpus_variants.csv');
    const { mapping, counts } = await run(f.bytes(), 'csv');
    expect(Object.keys(mapping).sort()).toEqual([...VARIANT_EXPECTED_FIELDS].sort());
    const { existing, ...rest } = f.expected;
    void existing;
    expect(counts).toEqual(rest);
  });

  it('large CSV: 100,000 rows just under the 20 MB limit, with the exact mix of outcomes', async () => {
    const f = file('corpus_large_100k.csv');
    const bytes = f.bytes();
    expect(bytes.byteLength).toBeLessThan(MAX);
    expect(bytes.byteLength).toBeGreaterThan(LARGE_TARGET_BYTES - 200_000);
    const { counts } = await run(bytes, 'csv');
    // Without a database, rows that match seeded leads in crm_perf are ordinary valid rows.
    const { existing, ...rest } = f.expected;
    void existing;
    expect(counts).toEqual(rest);
  }, 120_000);

  it('large XLSX: 20,000 rows with numeric cells, the same mix', async () => {
    const f = file('corpus_xlsx_20k.xlsx');
    const { counts } = await run(f.bytes(), 'xlsx', 'Leads');
    const { existing, ...rest } = f.expected;
    void existing;
    expect(counts).toEqual(rest);
  }, 120_000);

  it('a file one byte over the limit is refused before parsing', () => {
    const over = new Uint8Array(MAX + 1).fill(0x41);
    const r = inspectFileBytes(over, 'csv', limits);
    expect(r).toMatchObject({ ok: false, code: 'FILE_TOO_LARGE' });
  });

  it('generation is deterministic', () => {
    const a = file('corpus_variants.csv').bytes();
    const b = file('corpus_variants.csv').bytes();
    expect(Buffer.from(a).equals(Buffer.from(b))).toBe(true);
  });
});
