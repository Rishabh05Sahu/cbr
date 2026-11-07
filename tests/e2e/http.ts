// HTTP client for e2e tests: a browser-like cookie jar, calls to /api/auth/*, page GETs and
// Server Action invocations exactly as the React client sends them (Next-Action header +
// React encodeReply body), posted to the page that hosts the action.
import { randomInt } from 'node:crypto';
import { readFileSync } from 'node:fs';
import { authenticators, totp } from '../support/totp';
// eslint-disable-next-line @typescript-eslint/no-require-imports
const { encodeReply } = require('next/dist/compiled/react-server-dom-turbopack/client.node.js') as {
  encodeReply: (v: unknown) => Promise<FormData | string>;
};

export const BASE = 'http://127.0.0.1:3100';

interface ManifestEntry {
  workers: Record<string, unknown>;
  filename: string;
  exportedName: string;
}

let manifest: Record<string, ManifestEntry> | null = null;

export function actionId(filename: string, exportedName: string): string {
  manifest ??= (
    JSON.parse(readFileSync('.next/server/server-reference-manifest.json', 'utf8')) as {
      node: Record<string, ManifestEntry>;
    }
  ).node;
  const hit = Object.entries(manifest).find(
    ([, e]) => e.filename === filename && e.exportedName === exportedName,
  );
  if (!hit) throw new Error(`action ${filename}#${exportedName} not in manifest`);
  return hit[0];
}

export interface ActionOutcome {
  status: number;
  ok: boolean | null;
  code: string | null;
  body: string;
  /** The ActionResult's data on success (object-argument actions, see Browser.call). */
  data?: unknown;
}

/** Extracts the ActionResult object from an RSC (text/x-component) action response. */
export function parseActionResult(text: string): {
  ok: boolean | null;
  code: string | null;
  data?: unknown;
} {
  const i = text.search(/\{"ok":(true|false)/);
  if (i < 0) return { ok: null, code: null };
  let depth = 0;
  for (let j = i; j < text.length; j++) {
    if (text[j] === '{') depth++;
    else if (text[j] === '}' && --depth === 0) {
      const obj = JSON.parse(text.slice(i, j + 1)) as {
        ok: boolean;
        error?: { code: string };
        data?: unknown;
      };
      return { ok: obj.ok, code: obj.error?.code ?? null, data: obj.data };
    }
  }
  return { ok: null, code: null };
}

export class Browser {
  readonly jar = new Map<string, string>();
  readonly ip = `10.${randomInt(0, 255)}.${randomInt(0, 255)}.${randomInt(1, 254)}`;

  /** Server to send requests to (search-limit tests use extra instances); cookies are shared. */
  base = BASE;

  constructor(private readonly origin = BASE) {}

  cookieHeader(): string {
    return [...this.jar].map(([k, v]) => `${k}=${v}`).join('; ');
  }

  private store(res: Response) {
    for (const c of res.headers.getSetCookie()) {
      const [pair] = c.split(';');
      const eq = pair!.indexOf('=');
      const name = pair!.slice(0, eq);
      const value = pair!.slice(eq + 1);
      if (value === '' || /max-age=0/i.test(c)) this.jar.delete(name);
      else this.jar.set(name, value);
    }
  }

  async fetch(path: string, init: RequestInit = {}): Promise<Response> {
    const headers = new Headers(init.headers);
    headers.set('cookie', this.cookieHeader());
    headers.set('x-forwarded-for', this.ip);
    if (!headers.has('origin') && init.method && init.method !== 'GET')
      headers.set('origin', this.origin);
    const res = await fetch(`${this.base}${path}`, { ...init, headers, redirect: 'manual' });
    this.store(res);
    return res;
  }

  get(path: string) {
    return this.fetch(path);
  }

  authPost(path: string, body: unknown, extra: HeadersInit = {}) {
    return this.fetch(`/api/auth${path}`, {
      method: 'POST',
      headers: { 'content-type': 'application/json', ...extra },
      body: JSON.stringify(body),
    });
  }

  /** Password sign-in, then the authenticator step when the account has one (item D). */
  async signIn(email: string, password: string): Promise<Response> {
    const res = await this.authPost('/sign-in/email', { email, password });
    if (res.status !== 200) return res;
    const body = (await res.clone().json()) as { twoFactorRedirect?: boolean };
    const secret = authenticators.get(email.toLowerCase());
    if (!body.twoFactorRedirect || !secret) return res;
    return this.authPost('/two-factor/verify-totp', { code: totp(secret) });
  }

  /** A Server Action called with plain arguments (not a form), as a client component does. */
  async call(page: string, file: string, name: string, args: unknown[]): Promise<ActionOutcome> {
    const body = await encodeReply(args);
    const res = await this.fetch(page, {
      method: 'POST',
      headers: { 'next-action': actionId(file, name), accept: 'text/x-component' },
      body,
    });
    const text = await res.text();
    return { status: res.status, ...parseActionResult(text), body: text };
  }

  async action(
    page: string,
    file: string,
    name: string,
    fields: Record<string, string>,
    extraHeaders: HeadersInit = {},
  ): Promise<ActionOutcome> {
    const fd = new FormData();
    for (const [k, v] of Object.entries(fields)) fd.append(k, v);
    const body = await encodeReply([null, fd]);
    const res = await this.fetch(page, {
      method: 'POST',
      headers: { 'next-action': actionId(file, name), accept: 'text/x-component', ...extraHeaders },
      body,
    });
    const text = await res.text();
    return { status: res.status, ...parseActionResult(text), body: text };
  }
}

const MAILPIT = process.env.MAILPIT_API_URL ?? 'http://127.0.0.1:54025';

/** Waits for an email to `to` whose subject matches, and returns its plain-text body. */
export async function waitForEmail(
  to: string,
  subject: RegExp,
  timeoutMs = 20_000,
): Promise<string> {
  const until = Date.now() + timeoutMs;
  while (Date.now() < until) {
    const res = await fetch(`${MAILPIT}/api/v1/search?query=${encodeURIComponent(`to:"${to}"`)}`);
    const { messages } = (await res.json()) as { messages: { ID: string; Subject: string }[] };
    const hit = messages.find((m) => subject.test(m.Subject));
    if (hit) {
      const msg = (await (await fetch(`${MAILPIT}/api/v1/message/${hit.ID}`)).json()) as {
        Text: string;
      };
      return msg.Text;
    }
    await new Promise((r) => setTimeout(r, 300));
  }
  throw new Error(`no email to ${to} matching ${subject}`);
}

export function firstUrl(text: string): string {
  const m = /https?:\/\/\S+/.exec(text);
  if (!m) throw new Error('no URL in email');
  return m[0];
}
