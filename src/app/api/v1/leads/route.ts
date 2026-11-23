// GET /api/v1/leads — FR-056 lead list with the web list's query parameters (q, stage, due,
// intent, sort, cursor, …) in the caller's scope. A text search spends the organisation's search
// budget like the web list (M6 P-E); the proxy does not run for /api routes, so it is spent here.
import { createLead, searchLeads } from '@/modules/leads';
import { consumeSearchBudget, UNAVAILABLE_RETRY_AFTER } from '@/platform/rate-limit/search-budget';
import { apiError, apiRoute, queryOf, readJson } from '@/platform/http/api-route';

export const dynamic = 'force-dynamic';

export const GET = apiRoute('leads', async ({ req, ctx }) => {
  const q = queryOf(req);
  if ((q.q ?? '').trim() !== '') {
    const d = await consumeSearchBudget(ctx.orgId).catch(() => null); // fails closed
    if (!d || !d.allowed) {
      const limited = d?.allowed === false && d.reason === 'LIMITED';
      const wait = d?.allowed === false ? d.retryAfterSeconds : UNAVAILABLE_RETRY_AFTER;
      return apiError(
        limited ? 'RATE_LIMITED' : 'UNAVAILABLE',
        limited
          ? `Too many searches in your organisation right now. Try again in ${wait} s.`
          : `Search is temporarily unavailable. Try again in ${wait} s.`,
        { headers: { 'retry-after': String(wait) } },
      );
    }
  }
  return searchLeads(ctx, q);
});

// POST /api/v1/leads — add a lead from the app, the same command as the web "New lead" form
// (FR-050, duplicate check FR-052). Answers { status: 'created', leadId } or, when the number
// already belongs to an open lead, { status: 'duplicate', leadId (null when out of scope), ... }.
export const POST = apiRoute('lead-create', async ({ req, ctx }) =>
  createLead(ctx, await readJson(req)),
);
