import { describe, expect, it } from 'vitest';
import { normaliseIndianPhone, parseBudgetInr } from './normalise';

describe('normaliseIndianPhone (FR-043)', () => {
  it.each([
    // The three FR-043 acceptance examples.
    ['098765 43210', '+919876543210'],
    ['+91-9876543210', '+919876543210'],
    ['9876543210', '+919876543210'],
    // Other common spellings.
    ['  98765-43210 ', '+919876543210'],
    ['(98765) 43210', '+919876543210'],
    ['98765.43210', '+919876543210'],
    ['919876543210', '+919876543210'],
    ['+91 98765 43210', '+919876543210'],
    ['+91 098765 43210', '+919876543210'],
    ['0091 98765 43210', '+919876543210'],
    ['6000000000', '+916000000000'],
    ['9198765432', '+919198765432'], // 10 digits that merely start with 91
  ])('%j -> %s, keeping the raw value', (raw, e164) => {
    expect(normaliseIndianPhone(raw)).toEqual({ ok: true, value: { e164, raw } });
  });

  it.each([null, undefined, '', '   '])('blank %j is no value, not an error', (raw) => {
    expect(normaliseIndianPhone(raw)).toEqual({ ok: true, value: null });
  });

  it.each([
    ['call 9876543210', 'PHONE_INVALID_CHARACTERS'],
    ['9876543210 ext 12', 'PHONE_INVALID_CHARACTERS'],
    ['9.87654321E+09', 'PHONE_INVALID_CHARACTERS'], // Excel scientific notation
    ['98765+43210', 'PHONE_INVALID_CHARACTERS'],
    ['++919876543210', 'PHONE_INVALID_CHARACTERS'],
    ['９８７６５４３２１０', 'PHONE_INVALID_CHARACTERS'], // full-width digits
    ['+44 20 7946 0958', 'PHONE_NOT_INDIAN'],
    ['001 555 123 4567', 'PHONE_NOT_INDIAN'],
    ['12345', 'PHONE_INVALID_LENGTH'],
    ['98765432101', 'PHONE_INVALID_LENGTH'],
    ['9876543210.0', 'PHONE_INVALID_LENGTH'],
    ['9876543210 9876543211', 'PHONE_INVALID_LENGTH'], // two numbers in one cell
    ['+91 98765 4321', 'PHONE_INVALID_LENGTH'],
    ['5876543210', 'PHONE_NOT_MOBILE'],
    ['020 2612 3456', 'PHONE_NOT_MOBILE'], // Pune fixed line
    ['0000000000', 'PHONE_NOT_MOBILE'],
    ['9'.repeat(33), 'PHONE_TOO_LONG'],
  ])('rejects %j with %s and a message', (raw, code) => {
    const r = normaliseIndianPhone(raw);
    expect(r).toMatchObject({ ok: false, code });
    expect(r.ok === false && r.message.length > 0).toBe(true);
  });
});

describe('parseBudgetInr (FR-042)', () => {
  it.each([
    // FR-042 examples.
    ['1.2 Cr', '12000000.00'],
    ['85 L', '8500000.00'],
    // Units: case, spelling, spacing, trailing dot.
    ['1.2cr', '12000000.00'],
    ['1.2 CR.', '12000000.00'],
    ['2 Crores', '20000000.00'],
    ['1.5 crore', '15000000.00'],
    ['85l', '8500000.00'],
    ['85 Lakh', '8500000.00'],
    ['85 lakhs', '8500000.00'],
    ['85 Lac', '8500000.00'],
    ['1.50 L', '150000.00'],
    ['0.5 L', '50000.00'],
    ['25k', '25000.00'],
    ['25 K', '25000.00'],
    ['25 thousand', '25000.00'],
    ['1.2345678 Cr', '12345678.00'],
    // Currency markers and plain rupees with Indian or international grouping.
    ['₹ 85 L', '8500000.00'],
    ['Rs. 85 lakh', '8500000.00'],
    ['rs 85L', '8500000.00'],
    ['INR 1.2 Cr', '12000000.00'],
    ['85,00,000', '8500000.00'],
    ['85,00,000/-', '8500000.00'],
    ['8,500,000', '8500000.00'],
    ['1,00,00,000', '10000000.00'],
    ['8500000', '8500000.00'],
    ['  25000.50  ', '25000.50'],
    ['25000.5', '25000.50'],
    ['1', '1.00'],
    ['0.01', '0.01'],
    ['9999999999999.99', '9999999999999.99'], // numeric(15,2) maximum
  ])('%j -> %s', (raw, value) => {
    expect(parseBudgetInr(raw)).toEqual({ ok: true, value });
  });

  it('is exact where floating point is not (0.07 Cr, 1.1 L)', () => {
    expect(parseBudgetInr('0.07 Cr')).toEqual({ ok: true, value: '700000.00' });
    expect(parseBudgetInr('1.1 L')).toEqual({ ok: true, value: '110000.00' });
  });

  it.each([null, undefined, '', '  '])('blank %j is no value, not an error', (raw) => {
    expect(parseBudgetInr(raw)).toEqual({ ok: true, value: null });
  });

  it.each([
    ['abc', 'BUDGET_MALFORMED'],
    ['L', 'BUDGET_MALFORMED'],
    ['1.2.3 L', 'BUDGET_MALFORMED'],
    ['8,5', 'BUDGET_MALFORMED'],
    ['85,0000', 'BUDGET_MALFORMED'],
    ['.5 Cr', 'BUDGET_MALFORMED'],
    ['85 L only', 'BUDGET_MALFORMED'],
    ['−5 L', 'BUDGET_MALFORMED'], // Unicode minus
    ['1'.repeat(41), 'BUDGET_MALFORMED'],
    ['50-75 L', 'BUDGET_RANGE_NOT_SUPPORTED'],
    ['50 L - 75 L', 'BUDGET_RANGE_NOT_SUPPORTED'],
    ['50 L – 75 L', 'BUDGET_RANGE_NOT_SUPPORTED'],
    ['1 to 1.5 Cr', 'BUDGET_RANGE_NOT_SUPPORTED'],
    ['85 lakhz', 'BUDGET_UNKNOWN_UNIT'],
    ['1e7', 'BUDGET_MALFORMED'],
    ['5 million', 'BUDGET_UNKNOWN_UNIT'],
    ['85 constructor', 'BUDGET_UNKNOWN_UNIT'], // never resolves to an Object.prototype key
    ['25000.555', 'BUDGET_TOO_PRECISE'],
    ['1.2345678912 Cr', 'BUDGET_TOO_PRECISE'],
    ['0', 'BUDGET_NOT_POSITIVE'],
    ['0.00 L', 'BUDGET_NOT_POSITIVE'],
    ['-5 L', 'BUDGET_NOT_POSITIVE'],
    ['10000000000000', 'BUDGET_TOO_LARGE'],
    ['1000000 Cr', 'BUDGET_TOO_LARGE'],
  ])('rejects %j with %s and a message', (raw, code) => {
    const r = parseBudgetInr(raw);
    expect(r).toMatchObject({ ok: false, code });
    expect(r.ok === false && r.message.length > 0).toBe(true);
  });
});
