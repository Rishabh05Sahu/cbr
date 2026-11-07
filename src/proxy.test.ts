// The optimistic sign-in redirect for app pages is never cached (M5 §I.4 F1): a stored redirect
// could stand in for the signed-in response on a shared browser.
import { NextRequest } from 'next/server';
import { describe, expect, it } from 'vitest';
import { proxy } from './proxy';

describe('proxy', () => {
  it('redirects a signed-out request for a private file to sign-in, uncached', async () => {
    const res = await proxy(
      new NextRequest('http://localhost:3000/app/leads/exports/abc/download'),
    );
    expect(res.status).toBe(307);
    expect(res.headers.get('location')).toBe(
      'http://localhost:3000/login?next=%2Fapp%2Fleads%2Fexports%2Fabc%2Fdownload',
    );
    expect(res.headers.get('cache-control')).toBe('private, no-store');
  });

  it('lets a request with a session cookie through to the route', async () => {
    const res = await proxy(
      new NextRequest('http://localhost:3000/app/leads/exports/abc/download', {
        headers: { cookie: 'cbr.session_token=x' },
      }),
    );
    expect(res.headers.get('location')).toBeNull();
    expect(res.headers.get('x-middleware-next')).toBe('1');
  });
});
