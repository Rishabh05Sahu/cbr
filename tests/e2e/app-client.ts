// The Android app's HTTP client for e2e tests (ADR-0027): bearer sign-in as the app does it
// (Origin cbrcrm://app, the 2FA step's short-lived cookie, then the token only).
import { randomInt } from 'node:crypto';
import { expect } from 'vitest';
import { PASSWORD } from '../support/factory';
import { authenticators, totp } from '../support/totp';
import { BASE } from './http';

const APP_ORIGIN = 'cbrcrm://app';

export class App {
  token: string | null = null;
  private twoFactorCookie: string | null = null;
  /** One phone, one address: sign-in rate limits are per IP. */
  readonly ip = `10.${randomInt(0, 255)}.${randomInt(0, 255)}.${randomInt(1, 254)}`;

  async auth(path: string, body: unknown): Promise<Response> {
    const headers: Record<string, string> = {
      'content-type': 'application/json',
      origin: APP_ORIGIN,
      'x-forwarded-for': this.ip,
    };
    if (this.token) headers.authorization = `Bearer ${this.token}`;
    if (this.twoFactorCookie) headers.cookie = this.twoFactorCookie;
    const res = await fetch(`${BASE}/api/auth${path}`, {
      method: 'POST',
      headers,
      body: JSON.stringify(body),
    });
    for (const c of res.headers.getSetCookie()) {
      const pair = c.split(';')[0]!;
      if (pair.includes('two_factor=')) this.twoFactorCookie = pair;
    }
    const t = res.headers.get('set-auth-token');
    if (t) {
      this.token = t;
      this.twoFactorCookie = null;
    }
    return res;
  }

  async signIn(email: string): Promise<Response> {
    const res = await this.auth('/sign-in/email', { email, password: PASSWORD });
    const body = (await res.clone().json()) as { twoFactorRedirect?: boolean };
    if (!body.twoFactorRedirect) return res;
    return this.auth('/two-factor/verify-totp', {
      code: totp(authenticators.get(email.toLowerCase())!),
    });
  }

  api(path: string, init: { method?: string; body?: unknown } = {}) {
    return fetch(`${BASE}/api/v1${path}`, {
      method: init.method ?? 'GET',
      headers: {
        'x-forwarded-for': this.ip,
        ...(this.token ? { authorization: `Bearer ${this.token}` } : {}),
        ...(init.body !== undefined ? { 'content-type': 'application/json' } : {}),
      },
      ...(init.body !== undefined ? { body: JSON.stringify(init.body) } : {}),
    });
  }

  /** Multipart upload (property photos). */
  upload(path: string, form: FormData) {
    return fetch(`${BASE}/api/v1${path}`, {
      method: 'POST',
      headers: { 'x-forwarded-for': this.ip, authorization: `Bearer ${this.token}` },
      body: form,
    });
  }
}

export async function appFor(user: { email: string }, orgId: string): Promise<App> {
  const app = new App();
  expect((await app.signIn(user.email)).status).toBe(200);
  expect(app.token).toBeTruthy();
  expect((await app.auth('/organization/set-active', { organizationId: orgId })).status).toBe(200);
  return app;
}

export const json = async (res: Response) =>
  (await res.json()) as { ok: boolean; data?: any; error?: { code: string } }; // eslint-disable-line @typescript-eslint/no-explicit-any
