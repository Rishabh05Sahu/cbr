// /api/v1 route adapter for the Android app (ADR-0027). One place that authenticates, resolves
// the organisation context, maps errors to HTTP and marks every response private.
//
// - Bearer only. A request without `Authorization: Bearer` is refused, and cookies are never
//   passed on, so a browser's ambient session can never act through /api/v1 (no CSRF surface).
// - The context comes from resolveRequestContext, exactly as for pages and Server Actions:
//   membership, org status and the 2FA rule are re-checked on every request.
// - Handlers call the same module functions as the website. Errors map through runAction, so the
//   app sees the same `{ ok, data | error }` envelope and codes as the web forms.
import { runAction } from '@/platform/actions';
import type { RequestContext } from '@/platform/authz';
import {
  resolveRequestContext,
  type ResolveResult,
  type SessionUser,
} from '@/platform/auth/context';
import type { ActionResult } from '@/platform/errors';
import { privateRoute } from './private-response';

const STATUS: Record<string, number> = {
  UNAUTHENTICATED: 401,
  FORBIDDEN: 403,
  TWO_FACTOR_REQUIRED: 403,
  NO_ORG_ACCESS: 403,
  NOT_FOUND: 404,
  CONFLICT: 409,
  VALIDATION_FAILED: 422,
  RULE_VIOLATION: 422,
  RATE_LIMITED: 429,
  UNAVAILABLE: 503,
  INTERNAL: 500,
};

/** Headers forwarded to the auth layer: the token and the client address, nothing else. */
const FORWARDED = ['authorization', 'x-forwarded-for', 'x-real-ip', 'user-agent'];

export function json(
  result: ActionResult<unknown>,
  init: { headers?: Record<string, string> } = {},
) {
  const status = result.ok ? 200 : (STATUS[result.error.code] ?? 400);
  return Response.json(result, { status, ...(init.headers ? { headers: init.headers } : {}) });
}

export function apiError(
  code: string,
  message: string,
  init: { headers?: Record<string, string> } = {},
): Response {
  return json({ ok: false, error: { code, message } }, init);
}

/** The bearer-only header set, or null when the request carries no bearer token. */
export function bearerHeaders(req: Request): Headers | null {
  const auth = req.headers.get('authorization') ?? '';
  if (!/^bearer\s+\S+/i.test(auth)) return null;
  const h = new Headers();
  for (const k of FORWARDED) {
    const v = req.headers.get(k);
    if (v) h.set(k, v);
  }
  return h;
}

function refusal(r: Exclude<ResolveResult, { ok: true }>): Response {
  switch (r.reason) {
    case 'UNAUTHENTICATED':
      return apiError('UNAUTHENTICATED', 'Please sign in');
    case 'TWO_FACTOR_REQUIRED':
      return apiError(
        'TWO_FACTOR_REQUIRED',
        'Set up two-step verification on the website before using the app',
      );
    case 'NO_ACTIVE_ORG':
      return apiError('NO_ORG_ACCESS', 'Choose an organisation');
    default:
      return apiError('NO_ORG_ACCESS', 'No access to this organisation');
  }
}

interface Params<P> {
  req: Request;
  params: P;
}

type RouteCtx = { params: Promise<Record<string, string | string[]>> };

/** Resolves the caller, or answers 401 before touching the auth layer when there is no token. */
async function resolve(req: Request): Promise<ResolveResult | Response> {
  const headers = bearerHeaders(req);
  if (!headers) return apiError('UNAUTHENTICATED', 'Please sign in');
  return resolveRequestContext(headers);
}

/**
 * A route for a member of the active organisation. Platform support grants are web-only
 * (ADR-0027), so a support context is refused here.
 */
export function apiRoute<P = Record<string, never>>(
  name: string,
  handler: (a: Params<P> & { ctx: RequestContext; user: SessionUser }) => Promise<unknown>,
): (req: Request, rc: RouteCtx) => Promise<Response> {
  return privateRoute(`api/v1/${name}`, async (req: Request, rc: RouteCtx) => {
    const r = await resolve(req);
    if (r instanceof Response) return r;
    if (!r.ok) return refusal(r);
    if (r.ctx.kind !== 'member')
      return apiError('NO_ORG_ACCESS', 'Use the website for support access');
    const params = ((await rc?.params) ?? {}) as P;
    const ctx = r.ctx;
    let early: Response | null = null;
    const result = await runAction(async () => {
      const out = await handler({ req, params, ctx, user: r.user });
      if (out instanceof Response) early = out;
      return out;
    });
    return early ?? json(result);
  });
}

/** A route that only needs a signed-in user (the active organisation may be missing). */
export function apiSessionRoute(
  name: string,
  handler: (a: { req: Request; user: SessionUser; resolved: ResolveResult }) => Promise<unknown>,
): (req: Request) => Promise<Response> {
  return privateRoute(`api/v1/${name}`, async (req: Request) => {
    const r = await resolve(req);
    if (r instanceof Response) return r;
    if (!r.user) return refusal(r as Exclude<ResolveResult, { ok: true }>);
    const user = r.user;
    return json(await runAction(() => handler({ req, user, resolved: r })));
  });
}

/** Query string as a plain object (first value per key), for module functions that parse it. */
export function queryOf(req: Request): Record<string, string> {
  return Object.fromEntries(new URL(req.url).searchParams.entries());
}

/** The JSON body as an object; anything else is an empty object (the module validates). */
export async function readJson(req: Request): Promise<Record<string, unknown>> {
  try {
    const v: unknown = await req.json();
    return v && typeof v === 'object' && !Array.isArray(v) ? (v as Record<string, unknown>) : {};
  } catch {
    return {};
  }
}
