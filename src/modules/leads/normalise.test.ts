import { describe, expect, it } from 'vitest';
import { normalisePhone, parseBudget } from './normalise';

describe('normalisePhone (FR-043): UAE and India', () => {
  it.each([
    // UAE mobiles, local and international.
    ['050 123 4567', '+971501234567'],
    ['0501234567', '+971501234567'],
    ['50 123 4567', '+971501234567'],
    ['501234567', '+971501234567'],
    ['+971 50 123 4567', '+971501234567'],
    ['+971-50-123-4567', '+971501234567'],
    ['+971 050 123 4567', '+971501234567'], // trunk 0 after the code
    ['00971 50 123 4567', '+971501234567'],
    ['971501234567', '+971501234567'],
    ['(055) 987-6543', '+971559876543'],
    // UAE fixed lines (Dubai 04, Abu Dhabi 02).
    ['04 123 4567', '+97141234567'],
    ['+971 4 123 4567', '+97141234567'],
    ['02-6543210', '+97126543210'],
    // India, as before (FR-043 acceptance examples and common spellings).
    ['098765 43210', '+919876543210'],
    ['+91-9876543210', '+919876543210'],
    ['9876543210', '+919876543210'],
    ['  98765-43210 ', '+919876543210'],
    ['98765.43210', '+919876543210'],
    ['919876543210', '+919876543210'],
    ['+91 098765 43210', '+919876543210'],
    ['0091 98765 43210', '+919876543210'],
    ['9198765432', '+919198765432'], // 10 digits that merely start with 91
  ])('%j -> %s, keeping the raw value', (raw, e164) => {
    expect(normalisePhone(raw)).toEqual({ ok: true, value: { e164, raw } });
  });

  it.each([null, undefined, '', '   '])('blank %j is no value, not an error', (raw) => {
    expect(normalisePhone(raw)).toEqual({ ok: true, value: null });
  });

  it.each([
    ['call 0501234567', 'PHONE_INVALID_CHARACTERS'],
    ['050 123 4567 ext 12', 'PHONE_INVALID_CHARACTERS'],
    ['5.01234567E+08', 'PHONE_INVALID_CHARACTERS'], // Excel scientific notation
    ['++971501234567', 'PHONE_INVALID_CHARACTERS'],
    ['９８７６５４３２１０', 'PHONE_INVALID_CHARACTERS'], // full-width digits
    ['+44 20 7946 0958', 'PHONE_COUNTRY_NOT_SUPPORTED'],
    ['+966 50 123 4567', 'PHONE_COUNTRY_NOT_SUPPORTED'], // Saudi Arabia
    ['001 555 123 4567', 'PHONE_COUNTRY_NOT_SUPPORTED'],
    ['12345', 'PHONE_INVALID_LENGTH'],
    ['+971 50 123 456', 'PHONE_INVALID_LENGTH'],
    ['+971 50 123 45678', 'PHONE_INVALID_LENGTH'],
    ['98765432101', 'PHONE_INVALID_LENGTH'],
    ['9876543210 9876543211', 'PHONE_INVALID_LENGTH'], // two numbers in one cell
    ['+91 98765 4321', 'PHONE_INVALID_LENGTH'],
    ['+971 8 123 4567', 'PHONE_NOT_MOBILE'], // no such UAE area code
    ['+971 1234 56789', 'PHONE_NOT_MOBILE'],
    ['+91 5876543210', 'PHONE_NOT_MOBILE'],
    ['+91 020 2612 3456', 'PHONE_NOT_MOBILE'], // Indian fixed line
    ['9'.repeat(33), 'PHONE_TOO_LONG'],
  ])('rejects %j with %s and a message', (raw, code) => {
    const r = normalisePhone(raw);
    expect(r).toMatchObject({ ok: false, code });
    expect(r.ok === false && r.message.length > 0).toBe(true);
  });

  it('a UAE number and an Indian number never collapse into one key', () => {
    const a = normalisePhone('0501234567');
    const b = normalisePhone('+91 9501234567');
    expect(a.ok && b.ok && a.value!.e164 !== b.value!.e164).toBe(true);
  });
});

describe('parseBudget (FR-042): AED', () => {
  it.each([
    ['1.5M', '1500000.00'],
    ['1.5 m', '1500000.00'],
    ['2 Mn', '2000000.00'],
    ['2 million', '2000000.00'],
    ['850K', '850000.00'],
    ['850 thousand', '850000.00'],
    ['AED 1,500,000', '1500000.00'],
    ['aed1.2m', '1200000.00'],
    ['Dhs 750,000', '750000.00'],
    ['Dhs. 750K', '750000.00'],
    ['1,500,000 AED', '1500000.00'],
    ['750000 dirhams', '750000.00'],
    ['1,500,000', '1500000.00'],
    ['1500000', '1500000.00'],
    ['  25000.50  ', '25000.50'],
    ['25000.5', '25000.50'],
    ['1.2345678 M', '1234567.80'],
    ['1', '1.00'],
    ['0.01', '0.01'],
    ['9999999999999.99', '9999999999999.99'], // numeric(15,2) maximum
  ])('%j -> %s', (raw, value) => {
    expect(parseBudget(raw)).toEqual({ ok: true, value });
  });

  it('is exact where floating point is not (0.07M, 1.1K)', () => {
    expect(parseBudget('0.07M')).toEqual({ ok: true, value: '70000.00' });
    expect(parseBudget('1.1K')).toEqual({ ok: true, value: '1100.00' });
  });

  it.each([null, undefined, '', '  '])('blank %j is no value, not an error', (raw) => {
    expect(parseBudget(raw)).toEqual({ ok: true, value: null });
  });

  it.each([
    ['abc', 'BUDGET_MALFORMED'],
    ['M', 'BUDGET_MALFORMED'],
    ['1.2.3 M', 'BUDGET_MALFORMED'],
    ['8,5', 'BUDGET_MALFORMED'],
    ['85,00,000', 'BUDGET_MALFORMED'], // Indian grouping is no longer read
    ['.5 M', 'BUDGET_MALFORMED'],
    ['1.5M only', 'BUDGET_MALFORMED'],
    ['−5 M', 'BUDGET_MALFORMED'], // Unicode minus
    ['1'.repeat(41), 'BUDGET_MALFORMED'],
    ['1-1.5M', 'BUDGET_RANGE_NOT_SUPPORTED'],
    ['1M - 1.5M', 'BUDGET_RANGE_NOT_SUPPORTED'],
    ['1M – 1.5M', 'BUDGET_RANGE_NOT_SUPPORTED'],
    ['1 to 1.5M', 'BUDGET_RANGE_NOT_SUPPORTED'],
    ['85 L', 'BUDGET_UNKNOWN_UNIT'], // lakh and crore are no longer accepted
    ['1.2 Cr', 'BUDGET_UNKNOWN_UNIT'],
    ['₹ 85 L', 'BUDGET_MALFORMED'],
    ['1e7', 'BUDGET_MALFORMED'],
    ['85 constructor', 'BUDGET_UNKNOWN_UNIT'], // never resolves to an Object.prototype key
    ['25000.555', 'BUDGET_TOO_PRECISE'],
    ['1.234567891 M', 'BUDGET_TOO_PRECISE'],
    ['0', 'BUDGET_NOT_POSITIVE'],
    ['0.00 M', 'BUDGET_NOT_POSITIVE'],
    ['-5 M', 'BUDGET_NOT_POSITIVE'],
    ['10000000000000', 'BUDGET_TOO_LARGE'],
    ['10000000 M', 'BUDGET_TOO_LARGE'],
  ])('rejects %j with %s and a message', (raw, code) => {
    const r = parseBudget(raw);
    expect(r).toMatchObject({ ok: false, code });
    expect(r.ok === false && r.message.length > 0).toBe(true);
  });
});
