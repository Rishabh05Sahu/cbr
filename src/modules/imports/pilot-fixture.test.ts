// SYNTHETIC pilot fixture (tests/support/pilot-fixture.ts; not a brokerage export) through the
// worker-side pipeline without a database: file checks, parsing and sheet choice, header checks,
// mapping suggestions, row validation (phones, budgets, vocabularies, blanks), in-file
// duplicates, and counts. Existing-lead matching needs the database: see
// tests/integration/import-pilot-fixture.test.ts.
import { describe, expect, it } from 'vitest';
import {
  ACTIVE_SOURCES,
  EXPECTED_FIELD,
  expectedCounts,
  fixtureCsv,
  fixtureRows,
  fixtureXlsx,
  HEADERS,
  UNMAPPED,
  type Col,
  type Variant,
} from '../../../tests/support/pilot-fixture';
import { inspectFileBytes } from './file-check';
import { importLimits } from './limits';
import { checkHeaders, FIELD_SPEC, suggestMapping, unmappedColumns } from './mapping';
import { parseImportFile } from './parse';
import { InFileDuplicates, validateRow } from './rows';

const limits = importLimits(20 * 1024 * 1024);
const SOURCE_IDS = new Map(ACTIVE_SOURCES.map((s, i) => [s.toLowerCase(), `src-${i}`]));

async function parsed(v: Variant) {
  const bytes = v === 'csv' ? fixtureCsv() : fixtureXlsx();
  expect(inspectFileBytes(bytes, v, limits)).toMatchObject({ ok: true });
  const r = await parseImportFile(bytes, v, limits, v === 'xlsx' ? 'Leads' : null);
  if (!r.ok) throw new Error(`parse failed: ${r.code}`);
  return r.value;
}

/** Columns a correct suggestion must leave unmapped: the unsupported ones, and in the CSV the
 * duplicated "City" heading (both copies: ambiguous). */
const unmappedFor = (v: Variant): Col[] =>
  [...UNMAPPED, ...(v === 'csv' ? (['city'] as Col[]) : [])].filter((c) => HEADERS[v][c] !== null);

describe.each(['csv', 'xlsx'] as const)('synthetic pilot fixture: %s', (v) => {
  const cols = (Object.keys(HEADERS[v]) as Col[]).filter((c) => HEADERS[v][c] !== null);

  it('passes the file checks and parses with the exact headers and row count', async () => {
    const p = await parsed(v);
    expect(p.headerRow).toBe(1);
    expect(p.headers).toEqual(cols.map((c) => HEADERS[v][c]));
    expect(p.rows).toHaveLength(fixtureRows(v).length);
    if (v === 'xlsx') expect(p.sheetNames).toEqual(['Read me', 'Leads']);
  });

  if (v === 'xlsx')
    it('reads the "Read me" sheet by default, so the Leads sheet must be chosen', async () => {
      const r = await parseImportFile(fixtureXlsx(), 'xlsx', limits);
      expect(r).toMatchObject({ ok: true, value: { sheetName: 'Read me' } });
      if (r.ok) expect(suggestMapping(r.value.headers)).toEqual({});
    });

  it('suggests exactly the supported mappings and never guesses unsupported or ambiguous columns', async () => {
    const p = await parsed(v);
    const mapping = suggestMapping(p.headers);
    const expected: Record<string, number> = {};
    cols.forEach((c, i) => {
      const field = EXPECTED_FIELD[c];
      if (field && !unmappedFor(v).includes(c)) expected[field] = i;
    });
    expect(mapping).toEqual(expected);
    const unmapped = unmappedColumns(p.headers.length, mapping).map((i) => cols[i]);
    expect(unmapped.sort()).toEqual([...unmappedFor(v)].sort());
    // Owner columns are never mapped: an import cannot assign leads from a file column.
    expect(Object.keys(mapping)).not.toContain('ownerUserId');
    const h = checkHeaders(p.headers, limits);
    expect(h.fatal).toEqual([]);
    expect(h.warnings).toEqual(
      v === 'csv' ? [{ code: 'HEADER_DUPLICATE', column: cols.indexOf('city2') }] : [],
    );
  });

  it('every row gets exactly its expected outcome and codes', async () => {
    const p = await parsed(v);
    const mapping = suggestMapping(p.headers);
    const ctx = { sourcesByName: SOURCE_IDS, defaultSourceId: 'src-default', limits };
    const dups = new InFileDuplicates();
    for (const [i, fx] of fixtureRows(v).entries()) {
      const row = p.headerRow + 1 + i;
      const r = validateRow(p.rows[i]!, row, mapping, ctx);
      const label = `case ${fx.n} (${fx.case})`;
      if (fx.expect.kind === 'EMPTY') expect(r.status, label).toBe('EMPTY');
      else if (fx.expect.kind === 'INVALID') {
        expect(r.status, label).toBe('INVALID');
        if (r.status === 'INVALID')
          expect(
            r.issues.map((x) => [x.field, x.code]),
            label,
          ).toEqual(fx.expect.issues);
      } else {
        expect(r.status, label).toBe('VALID');
        if (r.status !== 'VALID') continue;
        const first = dups.check(row, r.lead.phones);
        if (fx.expect.kind === 'DUPLICATE_IN_FILE') expect(first, label).toBe(fx.expect.of + 1);
        else expect(first, label).toBeNull();
      }
    }
  });

  it('normalises the representative phone and budget formats exactly', async () => {
    const p = await parsed(v);
    const mapping = suggestMapping(p.headers);
    const ctx = { sourcesByName: SOURCE_IDS, defaultSourceId: 'src-default', limits };
    const lead = (n: number) => {
      const r = validateRow(p.rows[n - 1]!, n + 1, mapping, ctx);
      if (r.status !== 'VALID') throw new Error(`case ${n} not valid`);
      return r;
    };
    const e164 = (n: number) => lead(n).lead.primary.e164;
    const pre = v === 'csv' ? '+9190000000' : '+9190000001';
    for (const n of [1, 2, 3, 4, 5, 6, 7, 8])
      expect(e164(n), `case ${n}`).toBe(`${pre}${String(n).padStart(2, '0')}`);
    const budgets = Object.fromEntries(
      [1, 2, 3, 4, 5, 6, 7].map((n) => [n, lead(n).lead.requirements.budgetMin]),
    );
    expect(budgets).toEqual({
      1: '8500000.00', // 85 L
      2: '8500000.00', // 85,00,000/-
      3: '7500000.00', // ₹ 75 Lakh
      4: '15000000.00', // Rs. 1.5 crore
      5: '8500000.00', // 8,500,000
      6: '50000.00', // 50k
      7: '9500000.00', // 95 Lac (CSV) / 9500000 as a number (XLSX)
    });
    expect(lead(1).lead.requirements).toMatchObject({
      budgetMax: '12000000.00',
      transactionType: 'BUY',
      propertyType: 'APARTMENT',
      bhkMin: 2,
      purpose: 'INVESTMENT',
      timeline: 'WITHIN_1M',
      intent: 'HOT',
      preferredLocalities: ['Baner', 'Wakad'],
    });
    expect(lead(1).lead.input).toMatchObject({
      preferredLanguage: 'hi',
      preferredContactMethod: 'WHATSAPP',
    });
    expect(lead(1).sourceId).toBe('src-0'); // "Website" matched by name
    expect(lead(2).sourceId).toBe('src-default'); // blank source → default
    expect(lead(3).lead.requirements).toMatchObject({
      transactionType: 'RENT',
      propertyType: 'VILLA',
      intent: 'WARM',
    });
    expect(lead(6).lead.requirements.timeline).toBe('3_6M');
    expect(lead(29).lead.input.note).toBe('Synthetic note, with "quotes"\nand a second line.');
    expect(lead(28).lead.phones).toEqual([`${pre}28`, `${pre}29`]);
  });

  it('counts agree with the fixture definition', async () => {
    const p = await parsed(v);
    const mapping = suggestMapping(p.headers);
    const ctx = { sourcesByName: SOURCE_IDS, defaultSourceId: 'src-default', limits };
    const dups = new InFileDuplicates();
    const counts = { total: 0, valid: 0, invalid: 0, duplicateInFile: 0, empty: 0 };
    p.rows.forEach((cells, i) => {
      counts.total++;
      const r = validateRow(cells, i + 2, mapping, ctx);
      if (r.status === 'EMPTY') counts.empty++;
      else if (r.status === 'INVALID') counts.invalid++;
      else if (dups.check(i + 2, r.lead.phones) !== null) counts.duplicateInFile++;
      else counts.valid++;
    });
    const { existing, ...want } = expectedCounts(v);
    expect(counts).toEqual(want);
    expect(want).toEqual({ total: 29, valid: 11, invalid: 15, duplicateInFile: 2, empty: 1 });
    expect(existing).toBe(2);
  });
});

it('the Source hint no longer promises a fallback that validation refuses', () => {
  expect(FIELD_SPEC.get('source')?.hint).not.toMatch(/otherwise the default source is used/);
  expect(FIELD_SPEC.get('source')?.hint).toMatch(/unknown/i);
});
