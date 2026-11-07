// M6 P-E: the per-organisation lead text-search budget (10 per second per organisation) on the
// real local Valkey: ordinary traffic, the boundary, concurrent requests from several app
// processes' worth of callers, organisation isolation, retry after Retry-After, and a limiter
// outage (fails closed). Fresh random organisation ids per test, so tests never share a window.
import { randomUUID } from 'node:crypto';
import { Redis } from 'ioredis';
import { afterAll, describe, expect, it } from 'vitest';
import {
  consumeSearchBudget,
  SEARCH_BUDGET,
  searchBudgetKey,
} from '@/platform/rate-limit/search-budget';

const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));
const allowedCount = (ds: { allowed: boolean }[]) => ds.filter((d) => d.allowed).length;
const burst = (orgId: string, n: number) =>
  Promise.all(Array.from({ length: n }, () => consumeSearchBudget(orgId)));

// A second, independent connection, as another app instance would have.
const other = new Redis(process.env.REDIS_URL!, { maxRetriesPerRequest: 1 });
afterAll(async () => {
  await other.quit();
});

describe('search budget (Valkey, sliding window)', () => {
  it('is 10 per second per organisation', () => {
    expect(SEARCH_BUDGET).toMatchObject({ windowMs: 1000, max: 10 });
  });

  it('ordinary traffic (5 per second for 3 s) is never limited', async () => {
    const org = randomUUID();
    const ds = [];
    for (let i = 0; i < 15; i++) {
      ds.push(await consumeSearchBudget(org));
      await sleep(200);
    }
    expect(allowedCount(ds)).toBe(15);
  });

  it('boundary: the 10th search in a second passes, the 11th gets 429 with Retry-After 1', async () => {
    const org = randomUUID();
    const first = [];
    for (let i = 0; i < 10; i++) first.push(await consumeSearchBudget(org));
    expect(allowedCount(first)).toBe(10);
    expect(await consumeSearchBudget(org)).toEqual({
      allowed: false,
      reason: 'LIMITED',
      retryAfterSeconds: 1,
    });
  });

  it('concurrent: 40 simultaneous searches over two connections admit exactly 10', async () => {
    const org = randomUUID();
    const viaOther = Array.from({ length: 20 }, () => consumeSearchBudget(org, { client: other }));
    const ds = await Promise.all([...viaOther, ...(await burst(org, 20))]);
    expect(allowedCount(ds)).toBe(10);
    expect(ds.filter((d) => !d.allowed).every((d) => !d.allowed && d.reason === 'LIMITED')).toBe(
      true,
    );
  });

  it('organisation isolation: one organisation spending its budget leaves another untouched', async () => {
    const a = randomUUID();
    const b = randomUUID();
    expect(allowedCount(await burst(a, 15))).toBe(10);
    expect(allowedCount(await burst(b, 10))).toBe(10);
    expect(searchBudgetKey(a)).not.toBe(searchBudgetKey(b));
    // Only the caller's own key exists for each; nothing is shared.
    expect(await other.zcard(searchBudgetKey(a))).toBe(10);
    expect(await other.zcard(searchBudgetKey(b))).toBe(10);
  });

  it('retry: refused searches are not counted, and waiting Retry-After gets in', async () => {
    const org = randomUUID();
    expect(allowedCount(await burst(org, 10))).toBe(10);
    const refused = await consumeSearchBudget(org);
    expect(refused).toMatchObject({ allowed: false, retryAfterSeconds: 1 });
    // Hammering while refused does not extend the wait.
    expect(allowedCount(await burst(org, 20))).toBe(0);
    await sleep(1050);
    expect(allowedCount(await burst(org, 12))).toBe(10);
  });

  it('sliding, not fixed: never more than 10 in any one-second span across a window edge', async () => {
    const org = randomUUID();
    expect(allowedCount(await burst(org, 10))).toBe(10);
    await sleep(600);
    // 0.6 s later the first 10 are still inside the last second: a fixed window that had just
    // rolled over would admit 10 more here.
    expect(allowedCount(await burst(org, 5))).toBe(0);
    await sleep(500);
    expect(allowedCount(await burst(org, 10))).toBe(10);
  });

  it('keys expire with the window (no growth for idle organisations)', async () => {
    const org = randomUUID();
    await consumeSearchBudget(org);
    const ttl = await other.pttl(searchBudgetKey(org));
    expect(ttl).toBeGreaterThan(0);
    expect(ttl).toBeLessThanOrEqual(SEARCH_BUDGET.windowMs);
  });

  it('limiter outage: an unreachable Valkey refuses the search within the timeout', async () => {
    const down = new Redis('redis://127.0.0.1:1', {
      maxRetriesPerRequest: 0,
      lazyConnect: true,
      retryStrategy: () => null,
    });
    try {
      const t = performance.now();
      const d = await consumeSearchBudget(randomUUID(), { client: down });
      expect(d).toEqual({ allowed: false, reason: 'UNAVAILABLE', retryAfterSeconds: 5 });
      expect(performance.now() - t).toBeLessThan(SEARCH_BUDGET.timeoutMs + 500);
    } finally {
      down.disconnect();
    }
  });
});
