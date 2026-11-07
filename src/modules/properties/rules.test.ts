// FR-140 property rules (ADR-0021): price basis and status by listing type, deposits, amounts in
// rupees (numeric(15,2)), amenities, codes; and the rupee display format.
import { describe, expect, it } from 'vitest';
import { priceText, rupees } from '@/app/(app)/app/properties/format';
import {
  listingProblems,
  nextPropertyCode,
  parseAmenities,
  parseAmount,
  priceTypesFor,
  statusesFor,
} from './rules';

describe('listing consistency', () => {
  it('sale: total or per sq ft, can be sold, no deposit', () => {
    expect(priceTypesFor('SALE')).toEqual(['TOTAL', 'PER_SQFT']);
    expect(statusesFor('SALE')).toContain('SOLD');
    expect(statusesFor('SALE')).not.toContain('RENTED');
    expect(
      listingProblems({
        listingType: 'SALE',
        priceType: 'MONTHLY_RENT',
        status: 'RENTED',
        deposit: '1',
      }),
    ).toEqual({
      priceType: ['A sale price is a total or per sq ft'],
      status: ['Only a rental or lease can be rented'],
      deposit: ['A deposit applies to rentals and leases only'],
    });
  });
  it('rent and lease: monthly, can be rented, deposit allowed', () => {
    for (const l of ['RENT', 'LEASE'] as const) {
      expect(priceTypesFor(l)).toEqual(['MONTHLY_RENT']);
      expect(statusesFor(l)).not.toContain('SOLD');
      expect(
        listingProblems({
          listingType: l,
          priceType: 'MONTHLY_RENT',
          status: 'RENTED',
          deposit: '50000',
        }),
      ).toEqual({});
      expect(
        listingProblems({ listingType: l, priceType: 'TOTAL', status: 'SOLD', deposit: null }),
      ).toEqual({
        priceType: ['A rent or lease price is per month'],
        status: ['Only a sale can be sold'],
      });
    }
  });
});

describe('parseAmount', () => {
  it('accepts rupees with up to 2 decimals and Indian commas', () => {
    expect(parseAmount('85,00,000')).toBe('8500000');
    expect(parseAmount(' 12500.5 ')).toBe('12500.5');
    expect(parseAmount('0.75')).toBe('0.75');
    expect(parseAmount('')).toBeNull();
    expect(parseAmount(undefined)).toBeNull();
    for (const bad of ['-5', '1.234', 'abc', '1e6', '12345678901234'])
      expect(parseAmount(bad)).toBeUndefined();
    expect(parseAmount('9999999999999.99')).toBe('9999999999999.99');
  });
});

describe('parseAmenities and codes', () => {
  it('splits, trims and removes repeats', () => {
    expect(parseAmenities(' Lift, parking ,Gym,lift,\nPool ,, ')).toEqual([
      'Lift',
      'parking',
      'Gym',
      'Pool',
    ]);
    expect(parseAmenities(undefined)).toEqual([]);
  });
  it('numbers codes in sequence, past five digits too', () => {
    expect(nextPropertyCode(null)).toBe('P-00001');
    expect(nextPropertyCode(41)).toBe('P-00042');
    expect(nextPropertyCode(99999)).toBe('P-100000');
  });
});

describe('rupee display', () => {
  it('uses Indian grouping and the price basis', () => {
    expect(rupees('8500000')).toBe('₹85,00,000');
    expect(rupees('8500000.00')).toBe('₹85,00,000');
    expect(rupees('1250.5')).toBe('₹1,250.50');
    expect(priceText({ price: '6500', priceType: 'PER_SQFT' })).toBe('₹6,500 per sq ft');
    expect(priceText({ price: '35000', priceType: 'MONTHLY_RENT' })).toBe('₹35,000 per month');
  });
});
