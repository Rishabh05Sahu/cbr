// Test helpers for S2. Synthetic users only.
import { createHmac, randomUUID } from 'node:crypto';
import { createAuth, type CapturedEmail } from '../auth/auth';
import {
  createAppClient,
  createAuthClient,
  createMigratorClient,
  createPlatformClient,
  tenantRunnerFor,
} from '../db/clients';

export const PASSWORD = 'correct-horse-battery-staple';

export function setup() {
  const authDb = createAuthClient();
  const app = createAppClient();
  const platform = createPlatformClient();
  const migrator = createMigratorClient();
  const runner = tenantRunnerFor(app);
  const outbox: CapturedEmail[] = [];
  const auth = createAuth({ authPrisma: authDb.prisma, appRunner: runner, outbox });
  return {
    auth,
    runner,
    platform,
    migrator,
    outbox,
    close: () => Promise.all([authDb.close(), app.close(), platform.close(), migrator.close()]),
  };
}

export type Env = ReturnType<typeof setup>;

export const uniqueEmail = (label: string) => `${label}.${randomUUID().slice(0, 8)}@example.test`;

/** Browser-style cookie jar: turns Set-Cookie response headers into a Cookie request header. */
export function cookieFrom(headers: Headers, previous?: Headers): Headers {
  const jar = new Map<string, string>();
  for (const part of (previous?.get('cookie') ?? '').split('; ').filter(Boolean)) {
    const i = part.indexOf('=');
    jar.set(part.slice(0, i), part.slice(i + 1));
  }
  for (const c of headers.getSetCookie()) {
    const [pair] = c.split(';');
    const i = pair!.indexOf('=');
    const value = pair!.slice(i + 1);
    if (value === '' || /max-age=0/i.test(c)) jar.delete(pair!.slice(0, i));
    else jar.set(pair!.slice(0, i), value);
  }
  return new Headers({ cookie: [...jar].map(([k, v]) => `${k}=${v}`).join('; ') });
}

/** Creates a user with a verified email (verification flow itself is covered in S2-01). */
export async function createVerifiedUser(env: Env, label: string, platformRole?: 'PLATFORM_ADMIN') {
  const email = uniqueEmail(label);
  const res = await env.auth.api.signUpEmail({ body: { email, password: PASSWORD, name: label } });
  await env.migrator.prisma.user.update({
    where: { id: res.user.id },
    data: { emailVerified: true, ...(platformRole ? { platformRole } : {}) },
  });
  return { id: res.user.id, email };
}

export async function signIn(env: Env, email: string, password = PASSWORD): Promise<Headers> {
  const { headers } = await env.auth.api.signInEmail({
    body: { email, password },
    returnHeaders: true,
  });
  return cookieFrom(headers);
}

/** Platform creates a customer org with a given owner (system action; no self-service). */
export async function createOrg(env: Env, ownerUserId: string, name: string) {
  const slug = `${name.toLowerCase().replace(/\W+/g, '-')}-${randomUUID().slice(0, 6)}`;
  const org = await env.auth.api.createOrganization({ body: { name, slug, userId: ownerUserId } });
  return org!.id;
}

/** RFC 6238 TOTP (SHA-1, 30 s, 6 digits) for test authenticator codes. */
export function totp(secretBase32: string, at = Date.now()): string {
  const alphabet = 'ABCDEFGHIJKLMNOPQRSTUVWXYZ234567';
  let bits = '';
  for (const ch of secretBase32.replace(/=+$/, '').toUpperCase()) {
    bits += alphabet.indexOf(ch).toString(2).padStart(5, '0');
  }
  const key = Buffer.from(bits.match(/.{8}/g)!.map((b) => parseInt(b, 2)));
  const counter = Buffer.alloc(8);
  counter.writeBigUInt64BE(BigInt(Math.floor(at / 1000 / 30)));
  const h = createHmac('sha1', key).update(counter).digest();
  const o = h[h.length - 1]! & 0xf;
  const code = (h.readUInt32BE(o) & 0x7fffffff) % 1_000_000;
  return code.toString().padStart(6, '0');
}
