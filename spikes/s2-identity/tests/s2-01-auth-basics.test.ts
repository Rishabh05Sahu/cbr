// S2-01 auth basics with Prisma 7 + PostgreSQL 18: email/password sign-in, sign-out-all,
// password reset (single use, 30 min), session revocation on suspend, TOTP 2FA enrolment.
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { RESET_TOKEN_TTL_SECONDS } from '../auth/auth';
import { suspendMember } from '../harness/commands';
import { resolveRequestContext } from '../harness/request-context';
import {
  cookieFrom,
  createOrg,
  createVerifiedUser,
  PASSWORD,
  setup,
  signIn,
  totp,
  uniqueEmail,
  type Env,
} from './helpers';

let env: Env;
beforeAll(() => {
  env = setup();
});
afterAll(() => env.close());

const lastEmail = (to: string, kind: string) =>
  [...env.outbox].reverse().find((m) => m.to === to && m.kind === kind);

describe('S2-01 email + password', () => {
  it('sign-up requires email verification before sign-in; verified user signs in', async () => {
    const email = uniqueEmail('new');
    const res = await env.auth.api.signUpEmail({
      body: { email, password: PASSWORD, name: 'New' },
    });
    expect(res.token).toBeNull();
    await expect(env.auth.api.signInEmail({ body: { email, password: PASSWORD } })).rejects.toThrow(
      /verif/i,
    );
    let mail = lastEmail(email, 'verify-email');
    if (!mail) {
      await env.auth.api.sendVerificationEmail({ body: { email } });
      mail = lastEmail(email, 'verify-email');
    }
    expect(mail).toBeDefined();
    await env.auth.api.verifyEmail({ query: { token: mail!.token } });
    const headers = await signIn(env, email);
    const session = await env.auth.api.getSession({ headers });
    expect(session?.user.email).toBe(email);
  });

  it('wrong password is rejected; passwords are stored hashed', async () => {
    const u = await createVerifiedUser(env, 'pw');
    await expect(signIn(env, u.email, 'wrong-password-123')).rejects.toThrow(
      /Invalid email or password/i,
    );
    const account = await env.migrator.prisma.account.findFirst({ where: { userId: u.id } });
    expect(account?.password).toBeTruthy();
    expect(account?.password).not.toContain(PASSWORD);
  });

  it('sign-out-all revokes every session of the user', async () => {
    const u = await createVerifiedUser(env, 'multi');
    const laptop = await signIn(env, u.email);
    const phone = await signIn(env, u.email);
    expect(await env.auth.api.getSession({ headers: laptop })).not.toBeNull();
    expect(await env.auth.api.getSession({ headers: phone })).not.toBeNull();
    await env.auth.api.revokeSessions({ headers: laptop });
    expect(await env.auth.api.getSession({ headers: laptop })).toBeNull();
    expect(await env.auth.api.getSession({ headers: phone })).toBeNull();
    expect(await env.migrator.prisma.session.count({ where: { userId: u.id } })).toBe(0);
  });
});

describe('S2-01 password reset', () => {
  it('token is valid for 30 minutes, works once, and revokes existing sessions', async () => {
    const u = await createVerifiedUser(env, 'reset');
    const oldSession = await signIn(env, u.email);
    await env.auth.api.requestPasswordReset({ body: { email: u.email, redirectTo: '/reset' } });
    const mail = lastEmail(u.email, 'reset-password');
    expect(mail).toBeDefined();

    const v = await env.migrator.prisma.verification.findFirst({
      where: { identifier: { contains: mail!.token } },
    });
    expect(v).not.toBeNull();
    const ttl = (v!.expiresAt.getTime() - v!.createdAt.getTime()) / 1000;
    expect(Math.abs(ttl - RESET_TOKEN_TTL_SECONDS)).toBeLessThan(5);

    const newPassword = 'a-brand-new-long-password';
    await env.auth.api.resetPassword({ body: { newPassword, token: mail!.token } });
    await expect(
      env.auth.api.resetPassword({
        body: { newPassword: 'second-use-password-x', token: mail!.token },
      }),
    ).rejects.toThrow(/invalid token/i);
    expect(await env.auth.api.getSession({ headers: oldSession })).toBeNull();
    await expect(signIn(env, u.email, PASSWORD)).rejects.toThrow(/Invalid email or password/i);
    expect(await signIn(env, u.email, newPassword)).toBeInstanceOf(Headers);
  });

  it('an expired reset token is rejected', async () => {
    const u = await createVerifiedUser(env, 'expired');
    await env.auth.api.requestPasswordReset({ body: { email: u.email, redirectTo: '/reset' } });
    const mail = lastEmail(u.email, 'reset-password')!;
    await env.migrator.prisma.verification.updateMany({
      where: { identifier: { contains: mail.token } },
      data: { expiresAt: new Date(Date.now() - 1000) },
    });
    await expect(
      env.auth.api.resetPassword({
        body: { newPassword: 'another-long-password', token: mail.token },
      }),
    ).rejects.toThrow(/invalid token/i);
  });

  it('reset for an unknown email does not error or send anything (no enumeration)', async () => {
    const before = env.outbox.length;
    await env.auth.api.requestPasswordReset({
      body: { email: uniqueEmail('nobody'), redirectTo: '/reset' },
    });
    expect(env.outbox.length).toBe(before);
  });
});

describe('S2-01 session revocation on suspend', () => {
  it('suspending a member revokes their sessions and blocks re-entry to the org', async () => {
    const owner = await createVerifiedUser(env, 'owner');
    const exec = await createVerifiedUser(env, 'exec');
    const orgId = await createOrg(env, owner.id, 'Suspend Co');
    const member = await env.auth.api.addMember({
      body: { userId: exec.id, organizationId: orgId, role: 'sales_executive' },
    });

    const ownerH = await signIn(env, owner.email);
    await env.auth.api.setActiveOrganization({ headers: ownerH, body: { organizationId: orgId } });
    const execH = await signIn(env, exec.email);
    await env.auth.api.setActiveOrganization({ headers: execH, body: { organizationId: orgId } });

    const deps = { auth: env.auth, runner: env.runner, platform: env.platform };
    const ownerCtx = await resolveRequestContext(deps, ownerH);
    expect((await resolveRequestContext(deps, execH)).ok).toBe(true);
    if (!ownerCtx.ok) throw new Error('owner context');

    await suspendMember({ auth: env.auth, runner: env.runner }, ownerCtx.ctx, member!.id);

    expect(await env.auth.api.getSession({ headers: execH })).toBeNull();
    expect(await resolveRequestContext(deps, execH)).toEqual({
      ok: false,
      reason: 'UNAUTHENTICATED',
    });
    // Signing in again works (other orgs may exist) but this org stays closed.
    const again = await signIn(env, exec.email);
    await env.migrator.prisma.session.updateMany({
      where: { userId: exec.id },
      data: { activeOrganizationId: orgId },
    });
    expect(await resolveRequestContext(deps, again)).toEqual({
      ok: false,
      reason: 'MEMBERSHIP_INACTIVE',
    });
  });
});

describe('S2-01 TOTP two-factor', () => {
  it('enrolment, then sign-in requires a valid TOTP code', async () => {
    const u = await createVerifiedUser(env, 'totp');
    const h = await signIn(env, u.email);
    const enabled = await env.auth.api.enableTwoFactor({
      headers: h,
      body: { password: PASSWORD },
    });
    if (enabled.method !== 'totp')
      throw new Error(`expected TOTP enrolment, got ${enabled.method}`);
    expect(enabled.backupCodes.length).toBeGreaterThan(0);
    const secret = new URL(enabled.totpURI).searchParams.get('secret')!;
    expect(secret).toBeTruthy();

    // Enrolment completes only after the first valid code.
    await env.auth.api.verifyTOTP({ headers: h, body: { code: totp(secret) } });
    const user = await env.migrator.prisma.user.findUnique({ where: { id: u.id } });
    expect(user?.twoFactorEnabled).toBe(true);
    const stored = await env.migrator.prisma.twoFactor.findFirst({ where: { userId: u.id } });
    expect(stored?.secret).not.toBe(secret); // encrypted at rest

    // Password alone no longer yields a session.
    const step1 = await env.auth.api.signInEmail({
      body: { email: u.email, password: PASSWORD },
      returnHeaders: true,
    });
    expect((step1.response as { twoFactorRedirect?: boolean }).twoFactorRedirect).toBe(true);
    const pending = cookieFrom(step1.headers);
    expect(await env.auth.api.getSession({ headers: pending })).toBeNull();

    await expect(
      env.auth.api.verifyTOTP({ headers: pending, body: { code: '000000' } }),
    ).rejects.toThrow(/invalid/i);
    const step2 = await env.auth.api.verifyTOTP({
      headers: pending,
      body: { code: totp(secret) },
      returnHeaders: true,
    });
    const full = cookieFrom(step2.headers, pending);
    expect((await env.auth.api.getSession({ headers: full }))?.user.id).toBe(u.id);
  });
});
