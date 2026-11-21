// /api/auth/* handler. Created lazily so `next build` does not need runtime secrets.
import { toNextJsHandler } from 'better-auth/next-js';
import { auth, MOBILE_APP_ORIGIN } from './auth';

let handlers: ReturnType<typeof toNextJsHandler> | undefined;
const get = () => (handlers ??= toNextJsHandler(auth()));

/**
 * ADR-0027: the bearer plugin copies the session token into a `set-auth-token` response header.
 * Only the Android app (Origin cbrcrm://app, which no browser can send) receives it. For the
 * website the session stays in the httpOnly cookie, out of reach of page scripts.
 */
export function withoutTokenHeader(req: Request, res: Response): Response {
  if (!res.headers.has('set-auth-token')) return res;
  if (req.headers.get('origin') === MOBILE_APP_ORIGIN && !endsSession(res)) return res;
  const headers = new Headers(res.headers);
  headers.delete('set-auth-token');
  const exposed = (headers.get('access-control-expose-headers') ?? '')
    .split(',')
    .map((h) => h.trim())
    .filter((h) => h !== '' && h.toLowerCase() !== 'set-auth-token');
  if (exposed.length) headers.set('access-control-expose-headers', exposed.join(', '));
  else headers.delete('access-control-expose-headers');
  return new Response(res.body, { status: res.status, statusText: res.statusText, headers });
}

/**
 * The response clears the session cookie. A password sign-in that still needs the second factor
 * creates a session and deletes it in the same request; the plugin would otherwise hand the app
 * that dead token.
 */
function endsSession(res: Response): boolean {
  return res.headers
    .getSetCookie()
    .some(
      (c) =>
        /^(__Secure-)?cbr\.session_token=(;|$)/.test(c) ||
        (/^(__Secure-)?cbr\.session_token=/.test(c) && /max-age=0/i.test(c)),
    );
}

export const GET = async (req: Request) => withoutTokenHeader(req, await get().GET(req));
export const POST = async (req: Request) => withoutTokenHeader(req, await get().POST(req));
