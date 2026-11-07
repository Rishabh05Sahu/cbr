// M6 P-E: which requests the proxy meters, and what a refused one looks like. The budget itself
// (Valkey, sliding window) is tested in tests/integration/search-budget.test.ts.
import { NextRequest } from 'next/server';
import { describe, expect, it, vi } from 'vitest';
import type { SearchBudgetDecision } from '@/platform/rate-limit/search-budget';
import { isLeadTextSearch, searchGate, type SearchGateDeps } from './search-gate';

const ORG = '01900000-0000-7000-8000-000000000001';
const req = (url: string, method = 'GET') =>
  new NextRequest(`http://localhost:3000${url}`, {
    method,
    headers: { cookie: 'cbr.session_token=x' },
  });
const deps = (decision: SearchBudgetDecision, orgId: string | null = ORG) =>
  ({
    resolveOrgId: vi.fn(async () => orgId),
    consumeSearchBudget: vi.fn(async () => decision),
  }) satisfies SearchGateDeps;

describe('isLeadTextSearch', () => {
  it('only a GET of the lead list with a non-blank search text', () => {
    expect(isLeadTextSearch(req('/app/leads?q=rahul'))).toBe(true);
    expect(isLeadTextSearch(req('/app/leads?q=98765&stage=NEW&sort=name'))).toBe(true);
    expect(isLeadTextSearch(req('/app/leads'))).toBe(false);
    expect(isLeadTextSearch(req('/app/leads?q=%20%20'))).toBe(false);
    expect(isLeadTextSearch(req('/app/leads?stage=NEW'))).toBe(false);
    expect(isLeadTextSearch(req('/app/leads/queue?q=x'))).toBe(false);
    expect(isLeadTextSearch(req('/app/leads/exports?q=x'))).toBe(false);
    expect(isLeadTextSearch(req('/app/leads?q=x', 'POST'))).toBe(false);
  });
});

describe('searchGate', () => {
  it('ordinary list views are never metered (no lookup, no Valkey call)', async () => {
    const d = deps({ allowed: true });
    expect(await searchGate(req('/app/leads?stage=NEW'), d)).toBeNull();
    expect(d.resolveOrgId).not.toHaveBeenCalled();
    expect(d.consumeSearchBudget).not.toHaveBeenCalled();
  });

  it("an allowed search passes, counted against the caller's own organisation", async () => {
    const d = deps({ allowed: true });
    expect(await searchGate(req('/app/leads?q=rahul'), d)).toBeNull();
    expect(d.consumeSearchBudget).toHaveBeenCalledExactlyOnceWith(ORG);
  });

  it('over budget: 429 with Retry-After, never cached, nothing about the organisation or query', async () => {
    const res = await searchGate(
      req('/app/leads?q=rahul'),
      deps({ allowed: false, reason: 'LIMITED', retryAfterSeconds: 1 }),
    );
    expect(res?.status).toBe(429);
    expect(res?.headers.get('retry-after')).toBe('1');
    expect(res?.headers.get('cache-control')).toBe('private, no-store');
    const body = await res!.text();
    expect(body).toContain('Try again in 1 second.');
    expect(body).not.toContain(ORG);
    expect(body).not.toContain('rahul');
  });

  it('limiter unavailable: 503 with Retry-After (fails closed, the search does not run)', async () => {
    const res = await searchGate(
      req('/app/leads?q=rahul'),
      deps({ allowed: false, reason: 'UNAVAILABLE', retryAfterSeconds: 5 }),
    );
    expect(res?.status).toBe(503);
    expect(res?.headers.get('retry-after')).toBe('5');
    expect(res?.headers.get('cache-control')).toBe('private, no-store');
  });

  it('an error resolving the organisation or reaching the limiter also fails closed', async () => {
    const throwsResolve: SearchGateDeps = {
      resolveOrgId: async () => {
        throw new Error('auth store down');
      },
      consumeSearchBudget: vi.fn(),
    };
    expect((await searchGate(req('/app/leads?q=a'), throwsResolve))?.status).toBe(503);
    const throwsConsume: SearchGateDeps = {
      resolveOrgId: async () => ORG,
      consumeSearchBudget: async () => {
        throw new Error('boom');
      },
    };
    expect((await searchGate(req('/app/leads?q=a'), throwsConsume))?.status).toBe(503);
  });

  it('no active organisation: not counted, the page decides (redirect or 404)', async () => {
    const d = deps({ allowed: true }, null);
    expect(await searchGate(req('/app/leads?q=rahul'), d)).toBeNull();
    expect(d.consumeSearchBudget).not.toHaveBeenCalled();
  });
});
