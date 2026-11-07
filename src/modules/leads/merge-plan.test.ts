import { describe, expect, it } from 'vitest';
import {
  MERGE_CHAIN_MAX,
  MERGE_FIELDS,
  MergeChainBroken,
  MergeRefused,
  planMerge,
  resolveMerge,
  resolveSurvivor,
  timelineLeadIds,
  type MergeLead,
} from './merge-plan';

const ORG = 'org-1';
const blankFields = () =>
  Object.fromEntries(MERGE_FIELDS.map((f) => [f, null])) as MergeLead['fields'];

function lead(
  id: string,
  patch: Partial<MergeLead> & { f?: Partial<MergeLead['fields']> } = {},
): MergeLead {
  const { f, ...rest } = patch;
  return {
    id,
    orgId: ORG,
    primaryPhoneE164: '+919000000001',
    preferredLocalities: [],
    mergedIntoLeadId: null,
    deletedAt: null,
    archivedAt: null,
    ...rest,
    fields: { ...blankFields(), ...f },
  };
}

const refusal = (fn: () => unknown) => {
  try {
    fn();
  } catch (e) {
    if (e instanceof MergeRefused) return [e.code, ...e.fields];
    throw e;
  }
  return null;
};

describe('planMerge', () => {
  const survivor = lead('s', {
    preferredLocalities: ['Baner', 'Wakad'],
    f: {
      fullName: 'Synthetic Lead A',
      email: 'a@example.test',
      budgetMin: '8500000.00',
      intent: 'HOT',
    },
  });
  const merged = lead('m', {
    primaryPhoneE164: '+919000000002',
    preferredLocalities: ['wakad', 'Aundh'],
    f: {
      fullName: 'Synthetic Lead A.',
      email: 'A@example.test', // same ignoring case: not a conflict
      budgetMin: '9000000.00',
      propertyType: 'APARTMENT',
      intent: 'HOT',
    },
  });

  it('separates fills, conflicts and identical values; combines localities', () => {
    const plan = planMerge(survivor, merged);
    expect(plan.fills).toEqual([
      { field: 'alternatePhoneE164', value: '+919000000002' },
      { field: 'propertyType', value: 'APARTMENT' },
    ]);
    expect(plan.conflicts).toEqual([
      { field: 'fullName', survivor: 'Synthetic Lead A', merged: 'Synthetic Lead A.' },
      { field: 'budgetMin', survivor: '8500000.00', merged: '9000000.00' },
    ]);
    expect(plan.localities).toEqual(['Baner', 'Wakad', 'Aundh']);
  });

  it('never applies a conflict without an explicit resolution', () => {
    const plan = planMerge(survivor, merged);
    expect(refusal(() => resolveMerge(plan, {}))).toEqual([
      'CONFLICTS_UNRESOLVED',
      'fullName',
      'budgetMin',
    ]);
    expect(refusal(() => resolveMerge(plan, { fullName: 'survivor' }))).toEqual([
      'CONFLICTS_UNRESOLVED',
      'budgetMin',
    ]);
    // A resolution for a non-conflicting field would be a hidden write: refused.
    expect(
      refusal(() =>
        resolveMerge(plan, { fullName: 'survivor', budgetMin: 'merged', email: 'merged' }),
      ),
    ).toEqual(['UNKNOWN_RESOLUTION', 'email']);
    expect(resolveMerge(plan, { fullName: 'survivor', budgetMin: 'merged' })).toEqual({
      alternatePhoneE164: '+919000000002',
      propertyType: 'APARTMENT',
      budgetMin: '9000000.00',
      preferredLocalities: ['Baner', 'Wakad', 'Aundh'],
    });
  });

  it('the merged phone only fills the alternate slot, and never duplicates a survivor number', () => {
    const withAlt = lead('s2', { f: { alternatePhoneE164: '+919000000009' } });
    // Survivor already has an alternate: the merged phone is a conflict, not an overwrite.
    expect(planMerge(withAlt, lead('m2', { primaryPhoneE164: '+919000000002' })).conflicts).toEqual(
      [{ field: 'alternatePhoneE164', survivor: '+919000000009', merged: '+919000000002' }],
    );
    // Same primary on both (the usual duplicate): nothing to add.
    expect(planMerge(lead('s3'), lead('m3')).fills).toEqual([]);
    // Merged lead's alternate equals the survivor's primary: its primary is offered instead.
    const m4 = lead('m4', {
      primaryPhoneE164: '+919000000004',
      f: { alternatePhoneE164: '+919000000001' },
    });
    expect(planMerge(lead('s4'), m4).fills).toEqual([
      { field: 'alternatePhoneE164', value: '+919000000004' },
    ]);
  });

  it('caps combined localities at 20 and reports how many were dropped', () => {
    const a = lead('a', { preferredLocalities: Array.from({ length: 15 }, (_, i) => `A${i}`) });
    const b = lead('b', { preferredLocalities: Array.from({ length: 10 }, (_, i) => `B${i}`) });
    const plan = planMerge(a, b);
    expect(plan.localities).toHaveLength(20);
    expect(plan.localitiesDropped).toBe(5);
    expect(plan.localitiesAdded).toEqual(['B0', 'B1', 'B2', 'B3', 'B4']);
  });

  it('reports only localities the duplicate really adds (M5 §I.4 U5)', () => {
    expect(planMerge(survivor, merged).localitiesAdded).toEqual(['Aundh']);
    // Neither lead has localities: nothing to list (previously an empty "Localities" item).
    expect(planMerge(lead('s5'), lead('m5')).localitiesAdded).toEqual([]);
    // The duplicate's localities are all already on the survivor (ignoring case): nothing added.
    const same = planMerge(
      lead('s6', { preferredLocalities: ['Baner', 'Wakad'] }),
      lead('m6', { preferredLocalities: ['wakad'] }),
    );
    expect(same.localitiesAdded).toEqual([]);
    expect(same.localities).toEqual(['Baner', 'Wakad']);
  });

  it.each([
    ['SAME_LEAD', lead('x'), lead('x')],
    ['DIFFERENT_ORG', lead('x'), lead('y', { orgId: 'org-2' })],
    ['ALREADY_MERGED', lead('x'), lead('y', { mergedIntoLeadId: 'z' })],
    ['ALREADY_MERGED', lead('x', { mergedIntoLeadId: 'z' }), lead('y')],
    ['DELETED', lead('x'), lead('y', { deletedAt: new Date() })],
  ])('refuses %s', (code, s, m) => {
    expect(refusal(() => planMerge(s, m))).toEqual([code]);
  });
});

describe('merge by reference', () => {
  it('an archived lead can be merged away but cannot be the survivor', () => {
    const archived = lead('a', { archivedAt: new Date('2026-10-01T00:00:00Z') });
    expect(refusal(() => planMerge(archived, lead('b')))).toEqual(['SURVIVOR_ARCHIVED']);
    expect(refusal(() => planMerge(lead('b'), archived))).toBeNull();
  });

  it('follows merge pointers to the live survivor', () => {
    const ptr: Record<string, string | null> = { a: 'b', b: 'c', c: null };
    expect(resolveSurvivor('a', (id) => ptr[id] ?? null)).toBe('c');
    expect(resolveSurvivor('c', (id) => ptr[id] ?? null)).toBe('c');
    expect(() => resolveSurvivor('x', (id) => (id === 'x' ? 'y' : 'x'))).toThrow(MergeChainBroken);
    expect(() => resolveSurvivor('n0', (id) => `n${Number(id.slice(1)) + 1}`)).toThrow(
      MergeChainBroken,
    );
  });

  it("the survivor's timeline covers every tombstone that ends at it, nothing else", () => {
    const tombstones = [
      { id: 'a', mergedIntoLeadId: 'b' },
      { id: 'b', mergedIntoLeadId: 'c' },
      { id: 'd', mergedIntoLeadId: 'c' },
      { id: 'x', mergedIntoLeadId: 'other' },
    ];
    expect(timelineLeadIds('c', tombstones).sort()).toEqual(['a', 'b', 'c', 'd']);
    expect(timelineLeadIds('other', tombstones)).toEqual(['other', 'x']);
    const chain = Array.from({ length: MERGE_CHAIN_MAX + 2 }, (_, i) => ({
      id: `n${i + 1}`,
      mergedIntoLeadId: `n${i}`,
    }));
    expect(timelineLeadIds('n0', chain)).toHaveLength(MERGE_CHAIN_MAX + 1);
  });
});
