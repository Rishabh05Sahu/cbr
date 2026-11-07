// SYNTHETIC M6 import corpus (NOT brokerage exports; does NOT satisfy P6). Every value is
// fabricated (tests/support/synthetic-data.ts) and generated deterministically. One definition
// drives the files written to pilot/synthetic-corpus/ (scripts/pilot/generate-import-corpus.ts),
// the database-free unit test (tests/support/import-corpus.test.ts) and the import benchmark on
// the isolated crm_perf database (scripts/perf/import-run.mts), so expectations cannot drift.
//
// It extends the M4 fixture (tests/support/pilot-fixture.ts: 29 hand-written edge cases) with:
//   corpus_custom_fields.csv   required + strictly typed custom fields, every failure code
//   corpus_multisheet.xlsx     sheet selection; two lead sheets with different header spellings
//   corpus_variants.csv        a third header vocabulary; Indian phone and INR budget spellings
//   corpus_large_100k.csv      100,000 rows, just under the 20 MB limit, with a fixed mix of
//                              invalid, empty, in-file duplicate and existing-lead rows
//   corpus_xlsx_20k.xlsx       20,000 rows as XLSX (numeric phone cells), same mix
import type { Expect } from './pilot-fixture';
import { xlsx, type XCell } from './spreadsheets';
import {
  budgetText,
  CITIES,
  CITY_NAMES,
  phoneText,
  pick,
  rowRandom,
  syntheticBudget,
  syntheticEmail,
  syntheticMobile,
  syntheticName,
} from './synthetic-data';

export const CORPUS_LABEL =
  'SYNTHETIC TEST DATA: not a brokerage export. All values are fabricated.';
const SEED = 6_2026;
const BOM = '﻿';

/** RFC 4180 CSV with CRLF and a BOM (Excel "CSV UTF-8" style). */
export function csv(rows: readonly (readonly (string | number | null)[])[]): Uint8Array {
  const cell = (v: string | number | null) => {
    const s = v === null ? '' : String(v);
    return /[",\r\n]/.test(s) ? `"${s.replace(/"/g, '""')}"` : s;
  };
  return new TextEncoder().encode(
    BOM + rows.map((r) => r.map(cell).join(',')).join('\r\n') + '\r\n',
  );
}

// ---- 1. Custom fields ------------------------------------------------------------------------

/** Definitions the org must have for corpus_custom_fields.csv (keys have no digits). */
export const CORPUS_CUSTOM_FIELDS = [
  { key: 'site_city', label: 'Site City', type: 'text', required: true },
  { key: 'family_size', label: 'Family Size', type: 'number', required: false },
  { key: 'move_in', label: 'Move In', type: 'date', required: false },
  { key: 'nri', label: 'NRI', type: 'boolean', required: false },
  {
    key: 'facing',
    label: 'Facing',
    type: 'single_select',
    required: false,
    options: ['East', 'West'],
  },
  {
    key: 'amenities',
    label: 'Amenities',
    type: 'multi_select',
    required: false,
    options: ['Gym', 'Pool'],
  },
] as const;

export interface CorpusRow {
  n: number;
  case: string;
  cells: (string | number | null)[];
  expect: Expect;
}

const CF_HEADERS = [
  'Name',
  'Mobile',
  'Site City',
  'Family Size',
  'Move In',
  'NRI',
  'Facing',
  'Amenities',
];
export function customFieldRows(): CorpusRow[] {
  const ph = (n: number) => syntheticMobile(6, n, 9);
  const nm = (n: number) => `Synthetic Custom Field Lead ${n}`;
  const R = (n: number, c: string, cells: CorpusRow['cells'], expect: Expect): CorpusRow => ({
    n,
    case: c,
    cells,
    expect,
  });
  const inv = (...issues: [string, string][]): Expect => ({ kind: 'INVALID', issues });
  return [
    R(1, 'every type valid', [nm(1), ph(1), 'Pune', '4', '2027-02-28', 'Yes', 'East', 'Gym;Pool'], {
      kind: 'VALID',
    }),
    R(2, 'optional fields blank', [nm(2), ph(2), 'Mumbai', '', '', '', '', ''], { kind: 'VALID' }),
    R(
      3,
      'required field missing',
      [nm(3), ph(3), '', '3', '', '', '', ''],
      inv(['CF_site_city', 'CUSTOM_FIELD_REQUIRED']),
    ),
    R(
      4,
      'number with a thousands separator',
      [nm(4), ph(4), 'Pune', '1,200', '', '', '', ''],
      inv(['CF_family_size', 'CUSTOM_FIELD_INVALID']),
    ),
    R(
      5,
      'impossible date',
      [nm(5), ph(5), 'Pune', '', '2027-02-30', '', '', ''],
      inv(['CF_move_in', 'CUSTOM_FIELD_INVALID']),
    ),
    R(
      6,
      'boolean not yes/no/true/false',
      [nm(6), ph(6), 'Pune', '', '', 'maybe', '', ''],
      inv(['CF_nri', 'CUSTOM_FIELD_INVALID']),
    ),
    R(
      7,
      'option not in the list',
      [nm(7), ph(7), 'Pune', '', '', '', 'North', ''],
      inv(['CF_facing', 'CUSTOM_FIELD_INVALID']),
    ),
    R(
      8,
      'one of several options unknown',
      [nm(8), ph(8), 'Pune', '', '', '', '', 'Gym;Sauna'],
      inv(['CF_amenities', 'CUSTOM_FIELD_INVALID']),
    ),
    R(
      9,
      'options and booleans ignore case',
      [nm(9), ph(9), 'Chennai', '2', '2028-01-15', 'no', 'east', 'gym; pool'],
      { kind: 'VALID' },
    ),
    R(
      10,
      'invalid phone and missing required field together',
      [nm(10), '12345', '', '', '', '', '', ''],
      inv(['primaryPhone', 'PHONE_INVALID_LENGTH'], ['CF_site_city', 'CUSTOM_FIELD_REQUIRED']),
    ),
    R(11, 'empty row', ['', '', '', '', '', '', '', ''], { kind: 'EMPTY' }),
    R(12, 'same phone as case 1', [nm(12), ph(1), 'Pune', '', '', '', '', ''], {
      kind: 'DUPLICATE_IN_FILE',
      of: 1,
    }),
  ];
}
export const customFieldsCsv = () => csv([CF_HEADERS, ...customFieldRows().map((r) => r.cells)]);

// ---- 2. Multi-sheet XLSX ---------------------------------------------------------------------

const Q3_HEADERS = ['Customer Name', 'Mobile No.', 'Email ID', 'City', 'Budget'];
const Q4_HEADERS = [
  'Client Name',
  'Contact Number',
  'Email Address',
  'Location',
  'Min Budget',
  'Max Budget',
];
/** Fields the importer should suggest for the "Leads Q4" sheet's headers. */
export const Q4_EXPECTED_FIELDS = [
  'fullName',
  'primaryPhone',
  'email',
  'preferredLocalities',
  'budgetMin',
  'budgetMax',
];
export const MULTISHEET_ROWS = 150;
export function multisheetXlsx(): Uint8Array {
  const q3: XCell[][] = [Q3_HEADERS];
  const q4: XCell[][] = [Q4_HEADERS];
  for (let i = 1; i <= MULTISHEET_ROWS; i++) {
    const r3 = rowRandom(SEED + 3, i);
    const city = pick(r3, CITY_NAMES);
    q3.push([
      syntheticName(r3, 30_000 + i),
      Number(syntheticMobile(6, i, 1)),
      syntheticEmail(30_000 + i, 'q3'),
      city,
      syntheticBudget(r3).min,
    ]);
    const r4 = rowRandom(SEED + 4, i);
    const b = syntheticBudget(r4);
    q4.push([
      syntheticName(r4, 40_000 + i),
      syntheticMobile(6, i, 2),
      syntheticEmail(40_000 + i, 'q4'),
      pick(r4, CITIES[pick(r4, CITY_NAMES)]!),
      budgetText(b.min, i),
      budgetText(b.max, i),
    ]);
  }
  return xlsx({
    'Read me': [[CORPUS_LABEL], ['Choose the "Leads Q4" sheet for the newest rows.']],
    'Leads Q3': q3,
    'Leads Q4': q4,
  });
}

// ---- 3. Header and value variants ------------------------------------------------------------

export const VARIANT_HEADERS = [
  'Lead Name',
  'Phone Number',
  'Phone 2',
  'E-mail',
  'Requirement Type',
  'Unit Type',
  'Min BHK',
  'Max BHK',
  'Budget From',
  'Budget To',
  'Preferred City',
  'Area',
  'Timeframe',
  'Temperature',
  'Preferred Language',
];
export const VARIANT_EXPECTED_FIELDS = [
  'fullName',
  'primaryPhone',
  'alternatePhone',
  'email',
  'transactionType',
  'propertyType',
  'bhkMin',
  'bhkMax',
  'budgetMin',
  'budgetMax',
  'preferredCity',
  'preferredLocalities',
  'timeline',
  'intent',
  'preferredLanguage',
];
export const VARIANT_ROWS = 500;
export function variantRows(): (string | number | null)[][] {
  const rows: (string | number | null)[][] = [];
  for (let i = 1; i <= VARIANT_ROWS; i++) {
    const r = rowRandom(SEED + 5, i);
    const city = pick(r, CITY_NAMES);
    const b = syntheticBudget(r);
    const bhk = 1 + Math.floor(r() * 3);
    rows.push([
      syntheticName(r, 50_000 + i),
      phoneText(syntheticMobile(6, i, 3), i),
      i % 7 === 0 ? phoneText(syntheticMobile(6, i, 4), i + 2) : '',
      i % 2 === 0 ? syntheticEmail(50_000 + i, 'variant') : '',
      pick(r, ['Purchase', 'Rent', 'Lease commercial']),
      pick(r, ['Flat', 'Office space']),
      bhk,
      bhk + (i % 3 === 0 ? 1 : 0),
      budgetText(b.min, i),
      budgetText(b.max, i + 1),
      city,
      pick(r, CITIES[city]!),
      'Within 1 month',
      pick(r, ['Hot', 'warm']),
      pick(r, ['Hindi', 'English']),
    ]);
  }
  return rows;
}
export const variantsCsv = () => csv([VARIANT_HEADERS, ...variantRows()]);

// ---- 4/5. Large files with a fixed mix -------------------------------------------------------

export type Mix = 'valid' | 'invalid' | 'empty' | 'duplicate' | 'existing';
/** The outcome of data row i (0-based): every 1,000 rows hold one of each special case. */
export function mixOf(i: number): Mix {
  switch (i % 1000) {
    case 7:
      return 'invalid';
    case 13:
      return 'empty';
    case 21:
      return 'duplicate';
    case 33:
      return 'existing';
    default:
      return 'valid';
  }
}
/**
 * Phone for row i. "existing" rows reuse the phone of seeded lead i in the load-test org
 * (scripts/perf/seed-perf.mts, block 7), so they match an existing open lead there; elsewhere
 * they are just valid rows. Duplicates repeat row i−1's phone.
 */
export function largePhone(i: number, file: 'csv' | 'xlsx'): string {
  const sub = file === 'csv' ? 5 : 6;
  const m = mixOf(i);
  if (m === 'invalid') return '12345';
  if (m === 'duplicate') return syntheticMobile(6, i - 1, sub);
  if (m === 'existing') return syntheticMobile(7, i);
  return syntheticMobile(6, i, sub);
}
export function expectedMixCounts(rows: number) {
  const c = { total: rows, valid: 0, invalid: 0, empty: 0, duplicateInFile: 0, existing: 0 };
  for (let i = 0; i < rows; i++) {
    const m = mixOf(i);
    if (m === 'invalid') c.invalid++;
    else if (m === 'empty') c.empty++;
    else if (m === 'duplicate') c.duplicateInFile++;
    else {
      c.valid++;
      if (m === 'existing') c.existing++;
    }
  }
  return c;
}

export const LARGE_ROWS = 100_000;
export const LARGE_TARGET_BYTES = 20_000_000; // ≈ 95.4 % of the 20 MiB (20,971,520 B) limit
const LARGE_HEADERS = [
  'Customer Name',
  'Mobile',
  'Email',
  'City',
  'Locality',
  'Budget Min',
  'Budget Max',
  'Property Type',
  'Remarks',
];
function largeRow(i: number, file: 'csv' | 'xlsx', note: string): (string | number | null)[] {
  if (mixOf(i) === 'empty') return LARGE_HEADERS.map(() => '');
  const r = rowRandom(SEED + (file === 'csv' ? 10 : 11), i);
  const city = pick(r, CITY_NAMES);
  const b = syntheticBudget(r);
  const phone = largePhone(i, file);
  return [
    syntheticName(r, 100_000 + i),
    file === 'xlsx' && phone.length === 10 ? Number(phone) : phone,
    i % 3 === 0 ? syntheticEmail(100_000 + i, file) : '',
    city,
    pick(r, CITIES[city]!),
    file === 'xlsx' ? b.min : budgetText(b.min, i),
    file === 'xlsx' ? b.max : budgetText(b.max, i + 1),
    pick(r, ['Flat', 'Office space']),
    note,
  ];
}
/** 100,000 rows; the Remarks column is padded so the file lands just under 20 MB. */
export function large100kCsv(): Uint8Array {
  const base = csv([
    LARGE_HEADERS,
    ...Array.from({ length: LARGE_ROWS }, (_, i) => largeRow(i, 'csv', 'x')),
  ]).byteLength;
  const noted = Array.from({ length: LARGE_ROWS }, (_, i) => i).filter(
    (i) => mixOf(i) !== 'empty',
  ).length;
  const pad = Math.floor((LARGE_TARGET_BYTES - base) / noted);
  const note = `Synthetic remark ${'lorem '.repeat(Math.ceil(pad / 6))}`.slice(0, pad + 1);
  return csv([
    LARGE_HEADERS,
    ...Array.from({ length: LARGE_ROWS }, (_, i) => largeRow(i, 'csv', note)),
  ]);
}
export const XLSX_ROWS = 20_000;
export function xlsx20k(): Uint8Array {
  const rows: XCell[][] = [LARGE_HEADERS];
  for (let i = 0; i < XLSX_ROWS; i++) rows.push(largeRow(i, 'xlsx', 'Synthetic remark') as XCell[]);
  return xlsx({ 'Read me': [[CORPUS_LABEL]], Leads: rows });
}

// ---- Manifest --------------------------------------------------------------------------------

export function corpusFiles() {
  const cf = customFieldRows();
  const k = (kind: Expect['kind']) => cf.filter((r) => r.expect.kind === kind).length;
  return [
    {
      name: 'corpus_custom_fields.csv',
      type: 'csv' as const,
      bytes: customFieldsCsv,
      purpose: 'required and strictly typed custom fields; every custom-field failure code',
      expected: {
        total: cf.length,
        valid: k('VALID'),
        invalid: k('INVALID'),
        empty: k('EMPTY'),
        duplicateInFile: k('DUPLICATE_IN_FILE'),
        existing: 0,
      },
    },
    {
      name: 'corpus_multisheet.xlsx',
      type: 'xlsx' as const,
      bytes: multisheetXlsx,
      sheet: 'Leads Q4',
      purpose: 'sheet selection; a second header vocabulary; numeric phone cells on Q3',
      expected: {
        total: MULTISHEET_ROWS,
        valid: MULTISHEET_ROWS,
        invalid: 0,
        empty: 0,
        duplicateInFile: 0,
        existing: 0,
      },
    },
    {
      name: 'corpus_variants.csv',
      type: 'csv' as const,
      bytes: variantsCsv,
      purpose:
        'a third header vocabulary; +91/0/91-/spaced phones; L, Cr, Lakh, crore, Indian grouping and plain INR budgets',
      expected: {
        total: VARIANT_ROWS,
        valid: VARIANT_ROWS,
        invalid: 0,
        empty: 0,
        duplicateInFile: 0,
        existing: 0,
      },
    },
    {
      name: 'corpus_large_100k.csv',
      type: 'csv' as const,
      bytes: large100kCsv,
      purpose:
        '100,000 rows just under 20 MB; fixed mix of invalid, empty, in-file duplicate and existing-lead rows',
      expected: expectedMixCounts(LARGE_ROWS),
    },
    {
      name: 'corpus_xlsx_20k.xlsx',
      type: 'xlsx' as const,
      bytes: xlsx20k,
      sheet: 'Leads',
      purpose: '20,000 rows as XLSX with numeric phone and budget cells; same mix',
      expected: expectedMixCounts(XLSX_ROWS),
    },
  ];
}
