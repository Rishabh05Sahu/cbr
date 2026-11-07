// FR-096 targeting and the documented, deterministic match order.
import { describe, expect, it } from 'vitest';
import { matchScore, rankScripts, type LeadForMatching } from './matching';

const lead: LeadForMatching = {
  transactionType: 'BUY',
  propertyType: 'APARTMENT',
  preferredLanguage: 'mr',
  sourceId: 'src-portal',
};
const s = (
  id: string,
  name: string,
  t: Partial<Record<'transactionTypes' | 'propertyTypes' | 'languages' | 'sourceIds', string[]>>,
) => ({
  id,
  name,
  transactionTypes: [],
  propertyTypes: [],
  languages: [],
  sourceIds: [],
  ...t,
});

describe('matchScore', () => {
  it('an untargeted script matches every lead with score 0', () => {
    expect(matchScore(s('1', 'Generic', {}), lead)).toBe(0);
    expect(
      matchScore(s('1', 'Generic', {}), {
        transactionType: null,
        propertyType: null,
        preferredLanguage: null,
        sourceId: null,
      }),
    ).toBe(0);
  });
  it('counts each targeted dimension the lead satisfies', () => {
    expect(matchScore(s('1', 'x', { transactionTypes: ['BUY', 'RENT'] }), lead)).toBe(1);
    expect(
      matchScore(
        s('1', 'x', {
          transactionTypes: ['BUY'],
          propertyTypes: ['APARTMENT'],
          languages: ['MR '],
          sourceIds: ['src-portal'],
        }),
        lead,
      ),
    ).toBe(4);
  });
  it('does not match when any targeted dimension misses or the lead has no value', () => {
    expect(matchScore(s('1', 'x', { transactionTypes: ['RENT'] }), lead)).toBeNull();
    expect(
      matchScore(s('1', 'x', { transactionTypes: ['BUY'], propertyTypes: ['VILLA'] }), lead),
    ).toBeNull();
    expect(
      matchScore(s('1', 'x', { languages: ['hi'] }), { ...lead, preferredLanguage: null }),
    ).toBeNull();
    expect(matchScore(s('1', 'x', { sourceIds: ['other'] }), lead)).toBeNull();
  });
});

describe('rankScripts order', () => {
  it('most specific first, then name A→Z (ignoring case), then id; non-matches dropped', () => {
    const ranked = rankScripts(
      [
        s('b2', 'buyers', { transactionTypes: ['BUY'] }),
        s('g1', 'General', {}),
        s('a1', 'Apartment buyers', { transactionTypes: ['BUY'], propertyTypes: ['APARTMENT'] }),
        s('r1', 'Rentals', { transactionTypes: ['RENT'] }),
        s('b1', 'Buyers', { transactionTypes: ['BUY'] }),
        s('m1', 'Marathi apartments', { propertyTypes: ['APARTMENT'], languages: ['mr'] }),
      ],
      lead,
    );
    expect(ranked.map((r) => [r.id, r.score])).toEqual([
      ['a1', 2], // 2 dimensions; "Apartment…" before "Marathi…"
      ['m1', 2],
      ['b1', 1], // "Buyers" and "buyers" tie on name (case-insensitive): id breaks it
      ['b2', 1],
      ['g1', 0], // generic last
    ]);
  });
  it('is stable for the same input in any order', () => {
    const list = [
      s('z', 'Same', { transactionTypes: ['BUY'] }),
      s('a', 'Same', { transactionTypes: ['BUY'] }),
      s('m', 'Other', {}),
    ];
    const one = rankScripts(list, lead).map((r) => r.id);
    expect(rankScripts([...list].reverse(), lead).map((r) => r.id)).toEqual(one);
    expect(one).toEqual(['a', 'z', 'm']);
  });
});
