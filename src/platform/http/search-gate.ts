// Per-organisation lead text-search budget at the proxy (M6 P-E). Results stream inside the
// page, after the status line is sent, so the proxy is the only place that can still answer 429
// with Retry-After. The budget itself is src/platform/rate-limit/search-budget.ts.
import { NextResponse, type NextRequest } from 'next/server';
import {
  UNAVAILABLE_RETRY_AFTER,
  type SearchBudgetDecision,
} from '@/platform/rate-limit/search-budget';

export interface SearchGateDeps {
  /** The caller's active organisation, or null when the page should handle the request. */
  resolveOrgId(headers: Headers): Promise<string | null>;
  consumeSearchBudget(orgId: string): Promise<SearchBudgetDecision>;
}

// Loaded only for text searches, so other requests never touch the auth stack or Valkey here.
export const defaultSearchGateDeps: SearchGateDeps = {
  async resolveOrgId(headers) {
    const { resolveRequestContext } = await import('@/platform/auth/context');
    const r = await resolveRequestContext(headers);
    return r.ok ? r.ctx.orgId : null;
  },
  async consumeSearchBudget(orgId) {
    const { consumeSearchBudget } = await import('@/platform/rate-limit/search-budget');
    return consumeSearchBudget(orgId);
  },
};

/** A lead list request that runs the substring search (the expensive part, F-1/F-2). */
export function isLeadTextSearch(request: NextRequest): boolean {
  return (
    request.method === 'GET' &&
    request.nextUrl.pathname === '/app/leads' &&
    (request.nextUrl.searchParams.get('q') ?? '').trim() !== ''
  );
}

function refusal(status: 429 | 503, retryAfter: number): NextResponse {
  const message =
    status === 429
      ? `Too many searches in your organisation right now. Try again in ${retryAfter} second${retryAfter === 1 ? '' : 's'}.`
      : `Search is temporarily unavailable. Try again in ${retryAfter} seconds.`;
  const res = new NextResponse(
    `<!doctype html><html lang="en"><head><meta charset="utf-8"><meta name="viewport" content="width=device-width, initial-scale=1"><title>Search paused</title></head><body><main><p>${message}</p><p><a href="/app/leads">Back to leads</a></p></main></body></html>`,
    { status, headers: { 'content-type': 'text/html; charset=utf-8' } },
  );
  res.headers.set('retry-after', String(retryAfter));
  res.headers.set('cache-control', 'private, no-store');
  return res;
}

/**
 * Null to let the request through; otherwise the 429 (budget spent) or 503 (budget cannot be
 * checked) response. Counted against the caller's own organisation only; the response carries
 * nothing but that organisation's wait. A request the page would refuse anyway (no active org,
 * suspended membership) is not counted and goes on to the page. Fails closed: a search is never
 * run unmetered.
 */
export async function searchGate(
  request: NextRequest,
  deps: SearchGateDeps = defaultSearchGateDeps,
): Promise<NextResponse | null> {
  if (!isLeadTextSearch(request)) return null;
  let decision: SearchBudgetDecision | null;
  try {
    const orgId = await deps.resolveOrgId(request.headers);
    decision = orgId ? await deps.consumeSearchBudget(orgId) : null;
  } catch {
    decision = {
      allowed: false,
      reason: 'UNAVAILABLE',
      retryAfterSeconds: UNAVAILABLE_RETRY_AFTER,
    };
  }
  if (!decision || decision.allowed) return null;
  return refusal(decision.reason === 'LIMITED' ? 429 : 503, decision.retryAfterSeconds);
}
