// Responses that belong to one signed-in user (their export or import-problems file, or the refusal
// they were given) must never be stored by a browser or a shared cache: on a shared computer the
// next user would otherwise be shown the previous user's cached status or file. Every response of
// such a route — success, refusal, failure and unexpected error — goes through here.
import { unstable_rethrow } from 'next/navigation';
import { logger } from '@/platform/observability/logger';

export const PRIVATE_NO_STORE = 'private, no-store';

const PRIVATE_HEADERS = {
  'cache-control': PRIVATE_NO_STORE,
  'x-content-type-options': 'nosniff',
} as const;

/** A response that no browser or proxy may store. Plain text unless a content type is given. */
export function privateResponse(
  body: BodyInit | null,
  init: { status?: number; headers?: Record<string, string> } = {},
): Response {
  return new Response(body, {
    status: init.status ?? 200,
    headers: { 'content-type': 'text/plain; charset=utf-8', ...init.headers, ...PRIVATE_HEADERS },
  });
}

/**
 * Wraps a route handler so that whatever it returns carries the private headers, and an
 * unexpected error becomes a generic 500 (logged, no detail to the client) instead of the
 * framework's error response, which would not carry them.
 */
export function privateRoute<A extends unknown[]>(
  route: string,
  handler: (...args: A) => Promise<Response>,
): (...args: A) => Promise<Response> {
  return async (...args) => {
    let res: Response;
    try {
      res = await handler(...args);
    } catch (e) {
      unstable_rethrow(e); // framework control flow (never used by these handlers)
      logger.error({ route, err: e }, 'private route failed');
      return privateResponse('Something went wrong. Try again later.', { status: 500 });
    }
    const headers = new Headers(res.headers);
    for (const [k, v] of Object.entries(PRIVATE_HEADERS)) headers.set(k, v);
    return new Response(res.body, { status: res.status, statusText: res.statusText, headers });
  };
}
