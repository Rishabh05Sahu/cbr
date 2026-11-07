// Unit tests (no database): the pooled S1-08 backend-reuse criterion and the direct/pooled
// selection. The criterion must fail without cross-tenant reuse, or with reuse in only some
// directions, and pass only when every ordered tenant pair was observed on a shared backend.
import { describe, expect, it } from 'vitest';
import { BackendUsage, missingCrossTenantPairs, s108Path } from './backend-reuse';

const ORGS = ['A', 'B', 'C'];
const ALL_PAIRS = ['A->B', 'A->C', 'B->A', 'B->C', 'C->A', 'C->B'];

function usage(sequence: [pid: number, org: string][]) {
  const u = new BackendUsage();
  for (const [pid, org] of sequence) u.record(pid, org);
  return u;
}

describe('cross-tenant backend reuse (pooled S1-08)', () => {
  it('fails when every backend served only one tenant (no cross-tenant reuse)', () => {
    const u = usage([
      [101, 'A'],
      [101, 'A'],
      [102, 'B'],
      [102, 'B'],
      [103, 'C'],
      [103, 'C'],
    ]);
    expect(missingCrossTenantPairs(u, ORGS)).toEqual(ALL_PAIRS);
    expect(u.summary().backendsServingSeveralOrgs).toBe(0);
  });

  it('fails when each backend served one transaction only (many backends, no reuse at all)', () => {
    const u = usage([
      [1, 'A'],
      [2, 'B'],
      [3, 'C'],
      [4, 'A'],
      [5, 'B'],
      [6, 'C'],
    ]);
    expect(missingCrossTenantPairs(u, ORGS)).toEqual(ALL_PAIRS);
  });

  it('fails when reuse covers only some directions', () => {
    // A->B->C on one backend: B->A, C->A, C->B, A->C never observed.
    const u = usage([
      [101, 'A'],
      [101, 'B'],
      [101, 'C'],
    ]);
    expect(missingCrossTenantPairs(u, ORGS)).toEqual(['A->C', 'B->A', 'C->A', 'C->B']);
  });

  it('does not count tenants seen on different backends as reuse', () => {
    // A then B, but on two backends: no backend switched tenants.
    const u = usage([
      [101, 'A'],
      [102, 'B'],
    ]);
    expect(u.orderedPairs.size).toBe(0);
  });

  it('passes only when every ordered pair occurred consecutively on a shared backend', () => {
    const u = usage([
      [101, 'A'],
      [101, 'B'],
      [101, 'C'],
      [101, 'A'],
      [102, 'C'],
      [102, 'B'],
      [102, 'A'],
      [102, 'C'],
    ]);
    expect(missingCrossTenantPairs(u, ORGS)).toEqual([]);
    expect(u.summary()).toMatchObject({
      distinctBackends: 2,
      backendsServingSeveralOrgs: 2,
      orderedPairs: { 'A->B': 1, 'B->C': 1, 'C->A': 1, 'C->B': 1, 'B->A': 1, 'A->C': 1 },
    });
  });

  it('the S1-08 workload shape over 5 direct backends covers every pair (sanity)', () => {
    // Worker w, iteration i uses org (w + i) % 3, and transactions rotate over 5 connections.
    const u = new BackendUsage();
    let k = 0;
    for (let i = 0; i < 20; i++) for (let w = 0; w < 50; w++) u.record(k++ % 5, ORGS[(w + i) % 3]!);
    expect(missingCrossTenantPairs(u, ORGS)).toEqual([]);
  });

  it('summary labels orgs and is bounded to 20 backends', () => {
    const u = new BackendUsage();
    for (let pid = 0; pid < 30; pid++) u.record(pid, 'A');
    const s = u.summary((o) => `org ${o}`);
    expect(s.distinctBackends).toBe(30);
    expect(s.busiestBackends).toHaveLength(20);
    expect(s.busiestBackends[0]!.orgs).toEqual(['org A']);
  });
});

describe('S1-08 direct or pooled assertions', () => {
  const direct = 'postgresql://u:p@ep-x.example.invalid/crm_s1';
  const pooler = 'postgresql://u:p@ep-x-pooler.example.invalid/crm_s1';

  it('direct unless the runner says pooled (local runs, ordinary direct batches)', () => {
    for (const flag of [undefined, '', '0'])
      expect(s108Path({ S1_APP_POOLED: flag, S1_APP_URL: direct, S1_MIGRATOR_URL: direct })).toBe(
        'direct',
      );
  });

  it('pooled only through a different endpoint than the direct migrator connection', () => {
    expect(s108Path({ S1_APP_POOLED: '1', S1_APP_URL: pooler, S1_MIGRATOR_URL: direct })).toBe(
      'pooled',
    );
    const portOnly = 'postgresql://u:p@ep-x.example.invalid:25061/pool';
    expect(s108Path({ S1_APP_POOLED: '1', S1_APP_URL: portOnly, S1_MIGRATOR_URL: direct })).toBe(
      'pooled',
    );
  });

  it('refuses pooled assertions on the direct endpoint, and unknown values', () => {
    expect(() =>
      s108Path({ S1_APP_POOLED: '1', S1_APP_URL: direct, S1_MIGRATOR_URL: direct }),
    ).toThrow(/direct endpoint/);
    expect(() =>
      s108Path({ S1_APP_POOLED: 'yes', S1_APP_URL: pooler, S1_MIGRATOR_URL: direct }),
    ).toThrow(/must be 1 or 0/);
    expect(() => s108Path({ S1_APP_POOLED: '1' })).toThrow();
  });
});
