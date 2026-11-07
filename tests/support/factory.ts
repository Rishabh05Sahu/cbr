// Synthetic users/orgs for integration tests, created through the real auth stack.
import { randomUUID } from 'node:crypto';
import { auth } from '@/platform/auth/auth';
import { resolveRequestContext } from '@/platform/auth/context';
import { createUserWithPassword } from '@/platform/auth/org-admin';
import type { PluginRole } from '@/platform/auth/roles';
import type { RequestContext } from '@/platform/authz';
import { migrator } from './db';
import { authenticators, secretFromUri, totp } from './totp';

export const PASSWORD = 'correct-horse-battery-staple';

export const email = (label: string) =>
  `${label}.${randomUUID().slice(0, 8)}@example.test`.toLowerCase();

export interface TestUser {
  id: string;
  email: string;
  name: string;
}

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

/**
 * Verified user with a password (provisioning bypasses invitation-only sign-up). Owners,
 * Admins and platform staff need an authenticator (item D): pass `twoFactor` (platform staff
 * get one by default).
 */
export async function createUser(
  label: string,
  opts: { platformAdmin?: boolean; verified?: boolean; twoFactor?: boolean } = {},
): Promise<TestUser> {
  const e = email(label);
  const user = await createUserWithPassword({
    email: e,
    name: label,
    password: PASSWORD,
    emailVerified: opts.verified ?? true,
  });
  if (opts.platformAdmin)
    await migrator().user.update({
      where: { id: user.id },
      data: { platformRole: 'PLATFORM_ADMIN' },
    });
  const created = { id: user.id, email: e, name: label };
  if (opts.twoFactor ?? (opts.platformAdmin && opts.verified !== false))
    await enrolTwoFactor(created);
  return created;
}

/** Enrols an authenticator through the real endpoints; returns the one-time recovery codes. */
export async function enrolTwoFactor(
  user: TestUser,
  password = PASSWORD,
): Promise<{ secret: string; recoveryCodes: string[] }> {
  const headers = await signIn(user, password);
  const enabled = await auth().api.enableTwoFactor({ headers, body: { password } });
  if (enabled.method !== 'totp') throw new Error('expected TOTP enrolment');
  const secret = secretFromUri(enabled.totpURI);
  await auth().api.verifyTOTP({ headers, body: { code: totp(secret) } });
  authenticators.set(user.email.toLowerCase(), secret);
  return { secret, recoveryCodes: enabled.backupCodes };
}

/** Password sign-in; completes the TOTP step for users with an enrolled authenticator. */
export async function signIn(user: { email: string }, password = PASSWORD): Promise<Headers> {
  const { headers, response } = await auth().api.signInEmail({
    body: { email: user.email, password },
    returnHeaders: true,
  });
  const jar = cookieFrom(headers);
  if (!('twoFactorRedirect' in response && response.twoFactorRedirect)) return jar;
  const secret = authenticators.get(user.email.toLowerCase());
  if (!secret) throw new Error(`no authenticator for ${user.email}`);
  const verified = await auth().api.verifyTOTP({
    headers: jar,
    body: { code: totp(secret) },
    returnHeaders: true,
  });
  return cookieFrom(verified.headers, jar);
}

export async function createOrg(owner: TestUser, name = 'Test Realty'): Promise<string> {
  const org = await auth().api.createOrganization({
    body: {
      name,
      slug: `${name.toLowerCase().replace(/\W+/g, '-')}-${randomUUID().slice(0, 6)}`,
      userId: owner.id,
    },
  });
  return org!.id;
}

export async function addMember(orgId: string, user: TestUser, role: PluginRole): Promise<string> {
  const m = await auth().api.addMember({ body: { userId: user.id, organizationId: orgId, role } });
  return m!.id;
}

export interface Actor {
  user: TestUser;
  headers: Headers;
  ctx: RequestContext;
}

export async function actorIn(user: TestUser, orgId: string): Promise<Actor> {
  const headers = await signIn(user);
  await auth().api.setActiveOrganization({ headers, body: { organizationId: orgId } });
  const r = await resolveRequestContext(headers);
  if (!r.ok) throw new Error(`no context: ${r.reason}`);
  return { user, headers, ctx: r.ctx };
}

/** A typical brokerage: owner, admin, manager, two executives, HR. */
export async function seedOrg(name: string) {
  const owner = await createUser(`${name}-owner`, { twoFactor: true });
  const orgId = await createOrg(owner, name);
  const users = {
    owner,
    admin: await createUser(`${name}-admin`, { twoFactor: true }),
    manager: await createUser(`${name}-manager`),
    exec1: await createUser(`${name}-exec1`),
    exec2: await createUser(`${name}-exec2`),
    hr: await createUser(`${name}-hr`),
  };
  const membership: Record<string, string> = {};
  membership.admin = await addMember(orgId, users.admin, 'admin');
  membership.manager = await addMember(orgId, users.manager, 'sales_manager');
  membership.exec1 = await addMember(orgId, users.exec1, 'sales_executive');
  membership.exec2 = await addMember(orgId, users.exec2, 'sales_executive');
  membership.hr = await addMember(orgId, users.hr, 'hr_ops');
  membership.owner = (await migrator().member.findFirst({
    where: { organizationId: orgId, userId: owner.id },
  }))!.id;
  return { orgId, name, users, membership };
}
