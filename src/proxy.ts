// Next.js 16 proxy: an optimistic gate that redirects obviously signed-out requests for app
// pages to /login, a request id on every request, and the per-organisation lead text-search
// budget (M6 P-E, src/platform/http/search-gate.ts). Real authorisation happens in every page
// and action.
import { NextResponse, type NextRequest } from 'next/server';
import { searchGate } from '@/platform/http/search-gate';

const SESSION_COOKIES = ['cbr.session_token', '__Secure-cbr.session_token'];

export async function proxy(request: NextRequest): Promise<NextResponse> {
  const requestId = request.headers.get('x-request-id') ?? crypto.randomUUID();
  const upstream = new Headers(request.headers);
  upstream.set('x-request-id', requestId);

  const { pathname, search } = request.nextUrl;
  const protectedPath =
    pathname === '/app' ||
    pathname.startsWith('/app/') ||
    pathname === '/platform' ||
    pathname.startsWith('/platform/');
  const hasSession = SESSION_COOKIES.some((c) => request.cookies.has(c));
  if (protectedPath && !hasSession && request.method === 'GET') {
    const login = new URL('/login', request.url);
    login.searchParams.set('next', `${pathname}${search}`);
    // Never stored: a cached redirect could stand in for the signed-in response on a shared
    // browser (M5 §I.4 F1).
    const res = NextResponse.redirect(login);
    res.headers.set('cache-control', 'private, no-store');
    return res;
  }
  const refused = hasSession ? await searchGate(request) : null;
  if (refused) {
    refused.headers.set('x-request-id', requestId);
    return refused;
  }
  const res = NextResponse.next({ request: { headers: upstream } });
  res.headers.set('x-request-id', requestId);
  return res;
}

export const config = {
  matcher: ['/((?!api|_next/static|_next/image|favicon.ico|robots.txt).*)'],
};
