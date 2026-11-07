// SYNTHETIC pilot fixture for the M4 importer (P6 stand-in; NOT a brokerage export). Every name,
// number, email and note is fabricated: "Synthetic Lead NNN", @example.test addresses, and
// numbers in a made-up 90000-series used only for local tests (never contacted). One definition
// drives both the files written to pilot/anonymised/ (scripts/pilot/generate-synthetic-
// fixtures.ts) and the tests, so expected outcomes cannot drift from the files.
//
// Columns use only fields the importer supports (src/modules/imports/mapping.ts), with header
// spellings common in Indian portal/CRM exports, plus three unsupported columns (Lead ID,
// Assigned To, Site Visit Date) that must stay unmapped, and in the CSV a duplicated "City"
// heading that must not be guessed.
import { xlsx, type XCell } from './spreadsheets';

export type Col =
  | 'name'
  | 'phone'
  | 'alt'
  | 'email'
  | 'source'
  | 'txn'
  | 'ptype'
  | 'bhk'
  | 'budgetMin'
  | 'budgetMax'
  | 'city'
  | 'locality'
  | 'purpose'
  | 'timeline'
  | 'intent'
  | 'language'
  | 'contact'
  | 'note'
  | 'leadId'
  | 'assignedTo'
  | 'visitDate'
  | 'city2';

export type Variant = 'csv' | 'xlsx';

/** Header spellings per file (CSV and XLSX deliberately differ). `null` = column absent. */
export const HEADERS: Record<Variant, Record<Col, string | null>> = {
  csv: {
    name: 'Customer Name',
    phone: 'Mobile No.',
    alt: 'Alternate Mobile',
    email: 'Email ID',
    source: 'Lead Source',
    txn: 'Looking For',
    ptype: 'Property Type',
    bhk: 'BHK',
    budgetMin: 'Budget Min',
    budgetMax: 'Budget Max',
    city: 'City',
    locality: 'Preferred Location',
    purpose: 'Purpose',
    timeline: 'Timeline',
    intent: 'Temperature',
    language: 'Language',
    contact: 'Contact Method',
    note: 'Remarks',
    leadId: 'Lead ID',
    assignedTo: 'Assigned To',
    visitDate: 'Site Visit Date',
    city2: 'City', // duplicated heading: ambiguous, must not be suggested
  },
  xlsx: {
    name: 'Client Name',
    phone: 'Contact Number',
    alt: 'Phone 2',
    email: 'E-mail',
    source: 'Source',
    txn: 'Requirement Type',
    ptype: 'Unit Type',
    bhk: 'Min BHK',
    budgetMin: 'Budget From',
    budgetMax: 'Budget To',
    city: 'Preferred City',
    locality: 'Area',
    purpose: 'Purpose',
    timeline: 'Time Frame',
    intent: 'Intent',
    language: 'Preferred Language',
    contact: 'Preferred Contact Method',
    note: 'Enquiry Details',
    leadId: 'Lead ID',
    assignedTo: 'Assigned To',
    visitDate: 'Site Visit Date',
    city2: null,
  },
};

/** The column → import field the suggestion must produce (unsupported/ambiguous: absent). */
export const EXPECTED_FIELD: Partial<Record<Col, string>> = {
  name: 'fullName',
  phone: 'primaryPhone',
  alt: 'alternatePhone',
  email: 'email',
  source: 'source',
  txn: 'transactionType',
  ptype: 'propertyType',
  bhk: 'bhkMin',
  budgetMin: 'budgetMin',
  budgetMax: 'budgetMax',
  city: 'preferredCity',
  locality: 'preferredLocalities',
  purpose: 'purpose',
  timeline: 'timeline',
  intent: 'intent',
  language: 'preferredLanguage',
  contact: 'preferredContactMethod',
  note: 'note',
};
/** Columns that are never mapped automatically. */
export const UNMAPPED: readonly Col[] = ['leadId', 'assignedTo', 'visitDate', 'city2'];

export type Expect =
  | { kind: 'VALID'; existing?: boolean }
  | { kind: 'INVALID'; issues: [field: string, code: string][] }
  | { kind: 'DUPLICATE_IN_FILE'; of: number }
  | { kind: 'EMPTY' };

export interface FixtureRow {
  /** 1-based case number; spreadsheet row = case + 1 (header on row 1). */
  n: number;
  case: string;
  values: Partial<Record<Col, string | number>>;
  expect: Expect;
}

/** Sources that exist (active) in the test org; anything else is SOURCE_UNKNOWN. */
export const ACTIVE_SOURCES = ['Website'] as const;

/** Synthetic 10-digit mobile for case n; CSV and XLSX use disjoint ranges. */
export const mobile = (v: Variant, n: number) =>
  `${v === 'csv' ? '90000000' : '90000001'}${String(n).padStart(2, '0')}`;
const sp = (d: string) => `${d.slice(0, 5)} ${d.slice(5)}`;

/** Phones of open leads that must already exist for cases 27 and 28 (existing-lead matches). */
export const existingLeadPhones = (v: Variant) => [mobile(v, 27), mobile(v, 29)];

export function fixtureRows(v: Variant): FixtureRow[] {
  const m = (n: number) => mobile(v, n);
  const lead = (n: number) => `Synthetic Lead ${String(n).padStart(3, '0')}`;
  return [
    {
      n: 1,
      case: 'full valid row; +91 with spaces; 85 L / 1.2 Cr; vocab spellings',
      values: {
        name: lead(1),
        phone: `+91 ${sp(m(1))}`,
        email: 'synthetic.lead001@example.test',
        source: 'Website',
        txn: 'Purchase',
        ptype: 'Flat',
        bhk: '2 BHK',
        budgetMin: '85 L',
        budgetMax: '1.2 Cr',
        city: 'Pune',
        locality: 'Baner, Wakad',
        purpose: 'Investment',
        timeline: 'Within 1 month',
        intent: 'Hot',
        language: 'Hindi',
        contact: 'WhatsApp',
        note: 'Synthetic enquiry: prefers an east-facing flat.',
        leadId: 'SYN-0001',
        assignedTo: 'Synthetic Agent A',
        visitDate: '2026-11-02',
        city2: 'Mumbai',
      },
      expect: { kind: 'VALID' },
    },
    {
      n: 2,
      case: 'trunk 0; 85,00,000/-; blank source uses the default',
      values: { name: lead(2), phone: `0${sp(m(2))}`, budgetMin: '85,00,000/-' },
      expect: { kind: 'VALID' },
    },
    {
      n: 3,
      case: 'plain 10 digits; ₹ 75 Lakh; Rent, Bungalow, lower-case intent',
      values: {
        name: lead(3),
        phone: m(3),
        budgetMin: '₹ 75 Lakh',
        txn: 'Rent',
        ptype: 'Bungalow',
        intent: 'warm',
        bhk: '3',
      },
      expect: { kind: 'VALID' },
    },
    {
      n: 4,
      case: '91- country code with hyphens; Rs. 1.5 crore; commercial lease',
      values: {
        name: lead(4),
        phone: `91-${m(4).slice(0, 5)}-${m(4).slice(5)}`,
        budgetMin: 'Rs. 1.5 crore',
        txn: 'Lease commercial',
        ptype: 'Office space',
      },
      expect: { kind: 'VALID' },
    },
    {
      n: 5,
      case: 'parentheses; international grouping 8,500,000; English, Call',
      values: {
        name: lead(5),
        phone: `(${m(5).slice(0, 5)}) ${m(5).slice(5)}`,
        budgetMin: '8,500,000',
        language: 'English',
        contact: 'Call',
      },
      expect: { kind: 'VALID' },
    },
    {
      n: 6,
      case: '0091 prefix; 50k; timeline "3-6 months"',
      values: {
        name: lead(6),
        phone: `0091 ${sp(m(6))}`,
        budgetMin: '50k',
        timeline: '3-6 months',
      },
      expect: { kind: 'VALID' },
    },
    {
      n: 7,
      case: 'XLSX: phone and budget stored as numbers; CSV: dotted phone, 95 Lac',
      values:
        v === 'xlsx'
          ? { name: lead(7), phone: Number(m(7)), budgetMin: 9_500_000 }
          : { name: lead(7), phone: `${m(7).slice(0, 5)}.${m(7).slice(5)}`, budgetMin: '95 Lac' },
      expect: { kind: 'VALID' },
    },
    {
      n: 8,
      case: 'only the required fields; every optional cell blank',
      values: { name: lead(8), phone: m(8) },
      expect: { kind: 'VALID' },
    },
    {
      n: 9,
      case: 'missing name',
      values: { phone: m(9), budgetMin: '60 L' },
      expect: { kind: 'INVALID', issues: [['fullName', 'VALUE_REQUIRED']] },
    },
    {
      n: 10,
      case: 'missing phone',
      values: { name: lead(10), email: 'synthetic.lead010@example.test' },
      expect: { kind: 'INVALID', issues: [['primaryPhone', 'PHONE_REQUIRED']] },
    },
    {
      n: 11,
      case: 'too few digits',
      values: { name: lead(11), phone: '12345' },
      expect: { kind: 'INVALID', issues: [['primaryPhone', 'PHONE_INVALID_LENGTH']] },
    },
    {
      n: 12,
      case: 'foreign number',
      values: { name: lead(12), phone: '+44 20 7946 0958' },
      expect: { kind: 'INVALID', issues: [['primaryPhone', 'PHONE_NOT_INDIAN']] },
    },
    {
      n: 13,
      case: 'Excel scientific notation saved as text',
      values: { name: lead(13), phone: '9.00000001E+09' },
      expect: { kind: 'INVALID', issues: [['primaryPhone', 'PHONE_INVALID_CHARACTERS']] },
    },
    {
      n: 14,
      case: 'not a mobile series',
      values: { name: lead(14), phone: '5000000014' },
      expect: { kind: 'INVALID', issues: [['primaryPhone', 'PHONE_NOT_MOBILE']] },
    },
    {
      n: 15,
      case: 'budget range in one cell',
      values: { name: lead(15), phone: m(15), budgetMin: '50-75 L' },
      expect: { kind: 'INVALID', issues: [['budgetMin', 'BUDGET_RANGE_NOT_SUPPORTED']] },
    },
    {
      n: 16,
      case: 'budget with words',
      values: { name: lead(16), phone: m(16), budgetMin: 'about 1 Cr' },
      expect: { kind: 'INVALID', issues: [['budgetMin', 'BUDGET_MALFORMED']] },
    },
    {
      n: 17,
      case: 'unsupported budget unit',
      values: { name: lead(17), phone: m(17), budgetMin: '2 million' },
      expect: { kind: 'INVALID', issues: [['budgetMin', 'BUDGET_UNKNOWN_UNIT']] },
    },
    {
      n: 18,
      case: 'minimum budget above maximum',
      values: { name: lead(18), phone: m(18), budgetMin: '90 L', budgetMax: '60 L' },
      expect: { kind: 'INVALID', issues: [['budgetMax', 'BUDGET_MIN_ABOVE_MAX']] },
    },
    {
      n: 19,
      case: 'malformed email',
      values: { name: lead(19), phone: m(19), email: 'not-an-email' },
      expect: { kind: 'INVALID', issues: [['email', 'VALUE_INVALID_FORMAT']] },
    },
    {
      n: 20,
      case: 'property type outside the vocabulary',
      values: { name: lead(20), phone: m(20), ptype: 'Penthouse' },
      expect: { kind: 'INVALID', issues: [['propertyType', 'VALUE_NOT_ALLOWED']] },
    },
    {
      n: 21,
      case: 'alternate phone equals primary (different formatting)',
      values: { name: lead(21), phone: m(21), alt: `+91 ${sp(m(21))}` },
      expect: { kind: 'INVALID', issues: [['alternatePhone', 'ALTERNATE_SAME_AS_PRIMARY']] },
    },
    {
      n: 22,
      case: 'source name that is not an active source',
      values: { name: lead(22), phone: m(22), source: 'Facebook Ads' },
      expect: { kind: 'INVALID', issues: [['source', 'SOURCE_UNKNOWN']] },
    },
    {
      n: 23,
      case: 'two problems in one row are both reported',
      values: { name: lead(23), phone: 'call me', budgetMin: 'lots' },
      expect: {
        kind: 'INVALID',
        issues: [
          ['primaryPhone', 'PHONE_INVALID_CHARACTERS'],
          ['budgetMin', 'BUDGET_MALFORMED'],
        ],
      },
    },
    {
      n: 24,
      case: 'same phone as case 1, written differently: duplicate in file',
      values: { name: lead(24), phone: m(1) },
      expect: { kind: 'DUPLICATE_IN_FILE', of: 1 },
    },
    {
      n: 25,
      case: 'exact copy of case 2: duplicate in file',
      values: { name: lead(2), phone: `0${sp(m(2))}`, budgetMin: '85,00,000/-' },
      expect: { kind: 'DUPLICATE_IN_FILE', of: 2 },
    },
    {
      n: 26,
      case: 'entirely empty row in the middle of the data',
      values: {},
      expect: { kind: 'EMPTY' },
    },
    {
      n: 27,
      case: 'phone of an existing open lead (primary match)',
      values: { name: lead(27), phone: m(27), source: 'Website' },
      expect: { kind: 'VALID', existing: true },
    },
    {
      n: 28,
      case: 'new primary, alternate = an existing open lead (alternate match)',
      values: { name: lead(28), phone: m(28), alt: m(29) },
      expect: { kind: 'VALID', existing: true },
    },
    {
      n: 29,
      case: 'note with a comma, quotes and a line break (CSV quoting)',
      values: {
        name: lead(29),
        phone: `+91${m(30)}`,
        note: 'Synthetic note, with "quotes"\nand a second line.',
      },
      expect: { kind: 'VALID' },
    },
  ];
}

const columns = (v: Variant) =>
  (Object.keys(HEADERS[v]) as Col[]).filter((c) => HEADERS[v][c] !== null);

const csvCell = (x: string | number | undefined) => {
  const s = x === undefined ? '' : String(x);
  return /[",\r\n]/.test(s) ? `"${s.replace(/"/g, '""')}"` : s;
};

/** CSV as Excel's "CSV UTF-8" writes it: BOM, CRLF line ends, quoted where needed. */
export function fixtureCsv(): Uint8Array {
  const cols = columns('csv');
  const lines = [cols.map((c) => csvCell(HEADERS.csv[c]!)).join(',')];
  for (const r of fixtureRows('csv')) lines.push(cols.map((c) => csvCell(r.values[c])).join(','));
  return new TextEncoder().encode(`﻿${lines.join('\r\n')}\r\n`);
}

/** Workbook with a "Read me" sheet first and the rows on "Leads". */
export function fixtureXlsx(): Uint8Array {
  const cols = columns('xlsx');
  const rows: (XCell[] | null)[] = [cols.map((c) => HEADERS.xlsx[c]!)];
  for (const r of fixtureRows('xlsx'))
    rows.push(cols.map((c) => (r.values[c] === undefined ? null : (r.values[c] as XCell))));
  return xlsx({
    'Read me': [
      ['SYNTHETIC TEST FIXTURE: not a brokerage export. All values are fabricated.'],
      ['The rows to import are on the "Leads" sheet.'],
    ],
    Leads: rows,
  });
}

export function expectedCounts(v: Variant) {
  const rows = fixtureRows(v);
  const k = (kind: Expect['kind']) => rows.filter((r) => r.expect.kind === kind).length;
  return {
    total: rows.length,
    valid: k('VALID'),
    invalid: k('INVALID'),
    duplicateInFile: k('DUPLICATE_IN_FILE'),
    empty: k('EMPTY'),
    existing: rows.filter((r) => r.expect.kind === 'VALID' && r.expect.existing).length,
  };
}
