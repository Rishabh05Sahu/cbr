// Next.js data-access layer for the current request (server only).
import 'server-only';
import { headers } from 'next/headers';
import { notFound, redirect } from 'next/navigation';
import { cache } from 'react';
import { can, type Permission, type RequestContext } from '@/platform/authz';
import { unauthenticated, forbidden } from '@/platform/errors';
import { resolveRequestContext, type ResolveResult, type SessionUser } from './context';
import { twoFactorRequired } from './two-factor-policy';

/** Where Owners, Admins and platform staff without an authenticator are sent (item D). */
export const TWO_FACTOR_SETUP_PATH = '/app/security/two-factor';

/** Resolved once per request. */
export const currentResolution = cache(async (): Promise<ResolveResult> => {
  return resolveRequestContext(await headers());
});

/** For Server Actions: throws typed errors (mapped to ActionResult by the caller). */
export async function requireContext(): Promise<RequestContext> {
  const r = await currentResolution();
  if (r.ok) return r.ctx;
  if (r.reason === 'UNAUTHENTICATED') throw unauthenticated();
  if (r.reason === 'TWO_FACTOR_REQUIRED') throw twoFactorRequired();
  throw forbidden('No access to this organisation');
}

export async function requireUser(): Promise<SessionUser> {
  const r = await currentResolution();
  if (!r.user) throw unauthenticated();
  return r.user;
}

/** For pages: redirects instead of throwing. */
export async function pageContext(): Promise<{ user: SessionUser; ctx: RequestContext }> {
  const r = await currentResolution();
  if (r.ok) return { user: r.user, ctx: r.ctx };
  if (r.reason === 'UNAUTHENTICATED') redirect('/login');
  if (r.reason === 'TWO_FACTOR_REQUIRED') redirect(TWO_FACTOR_SETUP_PATH);
  redirect('/app/select-org');
}

export async function pageUser(): Promise<SessionUser> {
  const r = await currentResolution();
  if (!r.user) redirect('/login');
  return r.user;
}

export async function requestHeaders(): Promise<Headers> {
  return headers();
}

/** Page guard: a page the caller may not use is reported as not found. */
export function pageRequire(ctx: RequestContext, permission: Permission): void {
  if (!can(ctx, permission)) notFound();
}
