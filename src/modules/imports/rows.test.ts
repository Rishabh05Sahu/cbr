// Mapping and row validation on synthetic rows. Results must carry row/field/code only.
import { describe, expect, it } from 'vitest';
import { normalizeSourceName, sourceKey } from '@/modules/leads';
import { importLimits } from './limits';
import {
  checkHeaders,
  suggestMapping,
  unmappedColumns,
  validateMapping,
  type ColumnMapping,
} from './mapping';
import { cellText, InFileDuplicates, validateRow, type Cell, type RowContext } from './rows';

const limits = importLimits(20 * 1024 * 1024);
const SRC_UNKNOWN = '0199a000-0000-7000-8000-00000000aaaa';
const SRC_PORTAL = '0199a000-0000-7000-8000-00000000bbbb';
const ctx: RowContext = {
  sourcesByName: new Map([['99acres', SRC_PORTAL]]),
  defaultSourceId: SRC_UNKNOWN,
  limits,
};

const HEADERS = [
  'Customer Name',
  'Mobile No.',
  'E-mail',
  'Lead Source',
  'Budget',
  'Looking For',
  'Remarks',
  'Extra',
];

describe('headers and mapping', () => {
  it('suggests fields from common portal headers and leaves the rest unmapped', () => {
    const m = suggestMapping(HEADERS);
    expect(m).toEqual({
      fullName: 0,
      primaryPhone: 1,
      email: 2,
      source: 3,
      budgetMin: 4,
      transactionType: 5,
      note: 6,
    });
    expect(unmappedColumns(HEADERS.length, m)).toEqual([7]);
  });

  it('does not guess from duplicated headers; flags empty, duplicate and oversized headers', () => {
    expect(suggestMapping(['Phone', 'phone', 'Name']).primaryPhone).toBeUndefined();
    const { fatal, warnings } = checkHeaders(['Name', '', 'name', 'x'.repeat(201)], limits);
    expect(warnings.map((w) => w.code)).toEqual(['HEADER_EMPTY', 'HEADER_DUPLICATE']);
    expect(fatal).toEqual([{ code: 'HEADER_TOO_LONG', column: 3 }]);
    expect(checkHeaders(['', ' '], limits).fatal.map((f) => f.code)).toEqual(['HEADER_MISSING']);
    expect(checkHeaders(Array(101).fill('h'), limits).fatal.map((f) => f.code)).toContain(
      'TOO_MANY_COLUMNS',
    );
  });

  it('validates untrusted mappings: known fields, real columns, one field per column, required set', () => {
    expect(validateMapping({ fullName: '0', primaryPhone: '1', email: '' }, 3)).toEqual({
      ok: true,
      mapping: { fullName: 0, primaryPhone: 1 },
    });
    const bad = validateMapping(
      { fullName: '0', email: '0', orgId: '1', ownerUserId: '2', budgetMin: '9', campaign: '-1' },
      3,
    );
    expect(bad.ok).toBe(false);
    if (!bad.ok)
      expect(bad.issues.map((i) => `${i.code}:${i.field}`).sort()).toEqual([
        'COLUMN_INVALID:budgetMin',
        'COLUMN_INVALID:campaign',
        'COLUMN_MAPPED_TWICE:email',
        'FIELD_UNKNOWN:orgId',
        'FIELD_UNKNOWN:ownerUserId',
        'REQUIRED_UNMAPPED:primaryPhone',
      ]);
  });
});

describe('validateRow', () => {
  const mapping = suggestMapping(HEADERS) as ColumnMapping;
  const row = (cells: Cell[]) => validateRow(cells, 7, mapping, ctx);

  it('turns a portal row into the same prepared lead manual create would accept', () => {
    const r = row([
      'Asha Rao',
      9876543210,
      'ASHA@example.test',
      '99acres',
      '1.2 Cr',
      'Purchase',
      'Wants 2BHK near station',
    ]);
    expect(r.status).toBe('VALID');
    if (r.status !== 'VALID') return;
    expect(r.sourceId).toBe(SRC_PORTAL);
    expect(r.lead.primary.e164).toBe('+919876543210');
    expect(r.lead.requirements).toMatchObject({ budgetMin: '12000000.00', transactionType: 'BUY' });
    expect(r.lead.input.note).toBe('Wants 2BHK near station');
  });

  it('matches a source name ignoring case and extra spaces (stored names are normalized)', () => {
    const spaced: RowContext = {
      ...ctx,
      sourcesByName: new Map([[sourceKey('99 Acres'), SRC_PORTAL]]),
    };
    for (const cell of ['99 Acres', '  99  ACRES ', '99\tacres'])
      expect(
        validateRow(
          ['Ravi', '098765 43211', '', cell],
          2,
          { fullName: 0, primaryPhone: 1, source: 3 },
          spaced,
        ),
      ).toMatchObject({ status: 'VALID', sourceId: SRC_PORTAL });
    expect(
      validateRow(
        ['Ravi', '098765 43211', '', '99Acres'],
        2,
        { fullName: 0, primaryPhone: 1, source: 3 },
        spaced,
      ),
    ).toMatchObject({ status: 'INVALID', issues: [{ field: 'source', code: 'SOURCE_UNKNOWN' }] });
  });

  it('normalizes source names: trimmed, inner whitespace collapsed; the key also ignores case', () => {
    expect(normalizeSourceName('  Magic \t Bricks  ')).toBe('Magic Bricks');
    expect(sourceKey(' MAGIC  bricks')).toBe('magic bricks');
  });

  it('uses the default source when the cell is blank', () => {
    const r = row(['Ravi', '098765 43211', '', '', '', '', '']);
    expect(r).toMatchObject({ status: 'VALID', sourceId: SRC_UNKNOWN });
  });

  it('reports every problem with row, field and code, and never the cell values', () => {
    const r = row(['', '12345', 'not-an-email', 'Facebook', '50-75 L', 'Timeshare', 'x']);
    expect(r.status).toBe('INVALID');
    if (r.status !== 'INVALID') return;
    const codes = r.issues.map((i) => `${i.field}:${i.code}`);
    expect(codes).toEqual(
      expect.arrayContaining([
        'source:SOURCE_UNKNOWN',
        'fullName:VALUE_REQUIRED',
        'email:VALUE_INVALID_FORMAT',
        'transactionType:VALUE_NOT_ALLOWED',
        'primaryPhone:PHONE_INVALID_LENGTH',
        'budgetMin:BUDGET_RANGE_NOT_SUPPORTED',
      ]),
    );
    expect(r.issues.every((i) => i.row === 7)).toBe(true);
    const text = JSON.stringify(r);
    for (const v of ['12345', 'not-an-email', 'Facebook', 'Timeshare'])
      expect(text).not.toContain(v);
  });

  it('applies the M0 phone and budget rules with their codes', () => {
    const phone = row(['A', '+1 415 555 0100', '', '', '', '', '']);
    expect(phone).toMatchObject({
      status: 'INVALID',
      issues: [{ field: 'primaryPhone', code: 'PHONE_NOT_INDIAN' }],
    });
    const budget = row(['A', '9876543210', '', '', '50-75 L', '', '']);
    expect(budget).toMatchObject({
      status: 'INVALID',
      issues: [{ field: 'budgetMin', code: 'BUDGET_RANGE_NOT_SUPPORTED' }],
    });
    const sci = row(['A', '9.87654E+09', '', '', '', '', '']);
    expect(sci).toMatchObject({
      status: 'INVALID',
      issues: [{ code: 'PHONE_INVALID_CHARACTERS' }],
    });
  });

  it('skips empty rows and refuses oversized cells', () => {
    expect(row(['', null, undefined, '  ', '', '', ''])).toEqual({ status: 'EMPTY', row: 7 });
    expect(row(['A', '9876543210', '', '', '', '', 'x'.repeat(5001)])).toMatchObject({
      status: 'INVALID',
      issues: [{ field: 'note', code: 'CELL_TOO_LONG' }],
    });
  });

  it('cellText keeps every digit of numeric phones and formats dates', () => {
    expect(cellText(919876543210)).toBe('919876543210');
    expect(cellText(new Date('2026-10-01T00:00:00Z'))).toBe('2026-10-01');
    expect(cellText(Number.NaN)).toBe('');
  });
});

describe('InFileDuplicates (keep first)', () => {
  it('matches on primary or alternate phone and points at the first row', () => {
    const d = new InFileDuplicates();
    expect(d.check(2, ['+919876543210', '+919811111111'])).toBeNull();
    expect(d.check(3, ['+919811111111'])).toBe(2);
    expect(d.check(4, ['+919822222222'])).toBeNull();
    expect(d.check(5, ['+919822222222', '+919876543210'])).toBe(4);
  });
});
