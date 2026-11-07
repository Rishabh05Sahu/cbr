// M6 P-E: the search budget's keys and its failure paths (no Valkey needed). The sliding window
// against the real Valkey is in tests/integration/search-budget.test.ts.
import { describe, expect, it } from 'vitest';
import { consumeSearchBudget, searchBudgetKey, UNAVAILABLE_RETRY_AFTER } from './search-budget';

const ORG = '01900000-0000-7000-8000-00000000abc1';
const client = (evalImpl: () => Promise<unknown>) => ({ eval: evalImpl }) as never;

describe('searchBudgetKey', () => {
  it('one key per organisation id; anything that is not a UUID is refused', () => {
    expect(searchBudgetKey(ORG)).toBe(`rl:lead-search:org:${ORG}`);
    expect(searchBudgetKey(ORG)).not.toBe(searchBudgetKey(ORG.replace(/1$/, '2')));
    for (const bad of ['', 'org', `${ORG}:x`, `${ORG.slice(0, -1)}*`, ORG.toUpperCase()])
      expect(() => searchBudgetKey(bad)).toThrow();
  });
});

describe('consumeSearchBudget when the limiter fails', () => {
  it('a Valkey error refuses the search (UNAVAILABLE), never allows it', async () => {
    const c = client(async () => Promise.reject(new Error('ECONNREFUSED')));
    expect(await consumeSearchBudget(ORG, { client: c })).toEqual({
      allowed: false,
      reason: 'UNAVAILABLE',
      retryAfterSeconds: UNAVAILABLE_RETRY_AFTER,
    });
  });

  it('no answer within the timeout refuses the search, without waiting longer', async () => {
    const c = client(() => new Promise(() => {}));
    const t = performance.now();
    const d = await consumeSearchBudget(ORG, { client: c, timeoutMs: 50 });
    expect(d).toMatchObject({ allowed: false, reason: 'UNAVAILABLE' });
    expect(performance.now() - t).toBeLessThan(1000);
  });

  it('a bad organisation id refuses the search rather than sharing a key', async () => {
    const c = client(async () => [1, 0]);
    expect(await consumeSearchBudget('not-an-org', { client: c })).toMatchObject({
      allowed: false,
      reason: 'UNAVAILABLE',
    });
  });

  it('maps the script answer: accepted, or refused with the wait rounded up to whole seconds', async () => {
    expect(await consumeSearchBudget(ORG, { client: client(async () => [1, 0]) })).toEqual({
      allowed: true,
    });
    expect(await consumeSearchBudget(ORG, { client: client(async () => [0, 1]) })).toEqual({
      allowed: false,
      reason: 'LIMITED',
      retryAfterSeconds: 1,
    });
    expect(await consumeSearchBudget(ORG, { client: client(async () => [0, 1500]) })).toMatchObject(
      { retryAfterSeconds: 2 },
    );
  });
});
