// Mandatory Owner/Admin/platform 2FA and one-time recovery codes (owner decision item D),
// through the real auth stack and the production schema.
import { beforeAll, describe, expect, it } from 'vitest';
import * as members from '@/modules/members';
import * as platform from '@/modules/platform-admin';
import { auth } from '@/platform/auth/auth';
import { resolveRequestContext } from '@/platform/auth/context';
import { resetOwnAuthenticator } from '@/platform/auth/two-factor';
import { DomainError } from '@/platform/errors';
import { RateLimited } from '@/platform/rate-limit';
import { migrator } from '../support/db';
import {
  actorIn,
  addMember,
  cookieFrom,
  createUser,
  enrolTwoFactor,
  PASSWORD,
  seedOrg,
  signIn,
  type TestUser,
} from '../support/factory';
import { authenticators, totp } from '../support/totp';

let org: Awaited<ReturnType<typeof seedOrg>>;

beforeAll(async () => {
  org = await seedOrg('TwoFactor');
});

/** 'OK', a DomainError code, or the auth library's error code/status. */
const outcome = async (p: Promise<unknown>): Promise<string> => {
  try {
    await p;
    return 'OK';
  } catch (e) {
    if (e instanceof DomainError) return e.code;
    if (e instanceof RateLimited) return 'RATE_LIMITED';
    const err = e as { body?: { code?: string }; status?: string };
    return err.body?.code ?? err.status ?? 'ERROR';
  }
};

const sessionValid = async (headers: Headers) => !!(await auth().api.getSession({ headers }));

/** Password step only: returns the two-factor challenge cookies. */
async function passwordStep(user: TestUser): Promise<{ jar: Headers; redirect: boolean }> {
  const { headers, response } = await auth().api.signInEmail({
    body: { email: user.email, password: PASSWORD },
    returnHeaders: true,
  });
  return {
    jar: cookieFrom(headers),
    redirect: 'twoFactorRedirect' in response && !!response.twoFactorRedirect,
  };
}

async function signInWithRecoveryCode(user: TestUser, code: string): Promise<Headers> {
  const { jar } = await passwordStep(user);
  const res = await auth().api.verifyBackupCode({
    headers: jar,
    body: { code },
    returnHeaders: true,
  });
  return cookieFrom(res.headers, jar);
}

async function memberWithoutTwoFactor(label: string, role: 'owner' | 'admin' | 'sales_executive') {
  const u = await createUser(label);
  await addMember(org.orgId, u, role);
  return u;
}

describe('mandatory for Owners, Admins and platform staff', () => {
  it('an Owner or Admin without an authenticator cannot open the org', async () => {
    for (const role of ['owner', 'admin'] as const) {
      const u = await memberWithoutTwoFactor(`no2fa-${role}`, role);
      const headers = await signIn(u);
      await auth().api.setActiveOrganization({ headers, body: { organizationId: org.orgId } });
      const r = await resolveRequestContext(headers);
      expect(r.ok, role).toBe(false);
      expect(!r.ok && r.reason, role).toBe('TWO_FACTOR_REQUIRED');
    }
  });

  it('other roles are not forced (2FA optional)', async () => {
    const u = await memberWithoutTwoFactor('no2fa-exec', 'sales_executive');
    await expect(actorIn(u, org.orgId)).resolves.toMatchObject({ ctx: { kind: 'member' } });
  });

  it('a member promoted to Admin is blocked until enrolment, then allowed', async () => {
    const u = await memberWithoutTwoFactor('promoted', 'sales_executive');
    const owner = await actorIn(org.users.owner, org.orgId);
    const m = await migrator().member.findFirstOrThrow({
      where: { organizationId: org.orgId, userId: u.id },
    });
    await members.changeRole(owner.ctx, owner.headers, m.id, 'admin');
    await expect(actorIn(u, org.orgId)).rejects.toThrow(/TWO_FACTOR_REQUIRED/);
    await enrolTwoFactor(u);
    await expect(actorIn(u, org.orgId)).resolves.toMatchObject({ ctx: { pluginRole: 'admin' } });
  });

  it('platform staff without an authenticator get no console and no support context', async () => {
    const staff = await createUser('staff-no2fa', { platformAdmin: true, twoFactor: false });
    const r = await resolveRequestContext(await signIn(staff));
    expect(await outcome(platform.listOrganizations(r.user))).toBe('TWO_FACTOR_REQUIRED');
  });
});

describe('enrolment', () => {
  it('stores only keyed hashes of recovery codes and an encrypted TOTP secret', async () => {
    const u = await createUser('enrol-store');
    const { secret, recoveryCodes } = await enrolTwoFactor(u);
    expect(recoveryCodes).toHaveLength(10);
    for (const c of recoveryCodes) expect(c).toMatch(/^[a-z2-9]{4}-[a-z2-9]{4}-[a-z2-9]{4}$/);
    expect(new Set(recoveryCodes).size).toBe(10);
    const row = await migrator().twoFactor.findFirstOrThrow({ where: { userId: u.id } });
    const stored = JSON.parse(row.backupCodes) as string[];
    expect(stored).toHaveLength(10);
    for (const h of stored) expect(h).toMatch(/^h1:[A-Za-z0-9_-]{43}$/);
    for (const c of recoveryCodes) {
      expect(row.backupCodes).not.toContain(c);
      expect(row.backupCodes).not.toContain(c.replace(/-/g, ''));
    }
    expect(row.secret).not.toContain(secret);
    expect(row.verified).toBe(true);
  });

  it('ends every session that predates the second factor', async () => {
    const u = await createUser('enrol-sessions');
    const other = await signIn(u); // password-only session, e.g. on another device
    expect(await sessionValid(other)).toBe(true);
    await enrolTwoFactor(u);
    expect(await sessionValid(other)).toBe(false);
    expect(await migrator().session.count({ where: { userId: u.id } })).toBe(1);
  });

  it('is audited in the org and the user is notified', async () => {
    const u = await memberWithoutTwoFactor('enrol-audit', 'admin');
    await enrolTwoFactor(u);
    const audit = await migrator().auditLog.findFirst({
      where: { orgId: org.orgId, action: 'user.two_factor_enabled', entityId: u.id },
    });
    expect(audit).not.toBeNull();
  });
});

describe('sign-in', () => {
  it('a password alone creates no session for an enrolled user', async () => {
    const before = await migrator().session.count({ where: { userId: org.users.owner.id } });
    const { jar, redirect } = await passwordStep(org.users.owner);
    expect(redirect).toBe(true);
    expect(await sessionValid(jar)).toBe(false);
    expect(await migrator().session.count({ where: { userId: org.users.owner.id } })).toBe(before);
  });

  it('a wrong TOTP code is refused; the right one signs in', async () => {
    const { jar } = await passwordStep(org.users.admin);
    expect(
      await outcome(auth().api.verifyTOTP({ headers: jar, body: { code: '000000' } })),
    ).not.toBe('OK');
    const secret = authenticators.get(org.users.admin.email)!;
    const res = await auth().api.verifyTOTP({
      headers: jar,
      body: { code: totp(secret) },
      returnHeaders: true,
    });
    expect(await sessionValid(cookieFrom(res.headers, jar))).toBe(true);
  });

  it('trusted devices are never honoured', async () => {
    const { jar } = await passwordStep(org.users.admin);
    const res = await auth().api.verifyTOTP({
      headers: jar,
      body: { code: totp(authenticators.get(org.users.admin.email)!), trustDevice: true },
      returnHeaders: true,
    });
    expect(res.headers.getSetCookie().join('\n')).not.toMatch(/trust_device=[^;]/);
    const again = await auth().api.signInEmail({
      headers: cookieFrom(res.headers, jar),
      body: { email: org.users.admin.email, password: PASSWORD },
    });
    expect('twoFactorRedirect' in again && again.twoFactorRedirect).toBe(true);
  });
});

describe('recovery codes', () => {
  it('each code works once, in any case or spacing; then it is invalid', async () => {
    const u = await createUser('rc-once');
    const { recoveryCodes } = await enrolTwoFactor(u);
    const [first, second] = recoveryCodes as [string, string];
    expect(await sessionValid(await signInWithRecoveryCode(u, first))).toBe(true);
    expect(await outcome(signInWithRecoveryCode(u, first))).toBe('INVALID_BACKUP_CODE');
    const typed = ` ${second.toUpperCase().replace(/-/g, ' ')} `;
    expect(await sessionValid(await signInWithRecoveryCode(u, typed))).toBe(true);
    const row = await migrator().twoFactor.findFirstOrThrow({ where: { userId: u.id } });
    expect(JSON.parse(row.backupCodes)).toHaveLength(8);
  });

  it('the stored hash itself is not accepted as a code', async () => {
    const u = await createUser('rc-hash');
    await enrolTwoFactor(u);
    const row = await migrator().twoFactor.findFirstOrThrow({ where: { userId: u.id } });
    const stored = (JSON.parse(row.backupCodes) as string[])[0]!;
    expect(await outcome(signInWithRecoveryCode(u, stored))).toBe('INVALID_BACKUP_CODE');
  });

  it('concurrent use of the same code succeeds at most once', async () => {
    const u = await createUser('rc-race');
    const { recoveryCodes } = await enrolTwoFactor(u);
    const results = await Promise.all(
      Array.from({ length: 4 }, () => outcome(signInWithRecoveryCode(u, recoveryCodes[0]!))),
    );
    expect(results.filter((r) => r === 'OK')).toHaveLength(1);
  });

  it('generating new codes invalidates all old ones', async () => {
    const u = await createUser('rc-regen');
    const { recoveryCodes: old } = await enrolTwoFactor(u);
    const headers = await signIn(u);
    const fresh = await auth().api.generateBackupCodes({ headers, body: { password: PASSWORD } });
    expect(await outcome(signInWithRecoveryCode(u, old[3]!))).toBe('INVALID_BACKUP_CODE');
    expect(await sessionValid(await signInWithRecoveryCode(u, fresh.backupCodes[0]!))).toBe(true);
  });

  it('use is audited for org members with the number of codes left', async () => {
    const u = await memberWithoutTwoFactor('rc-audit', 'admin');
    const { recoveryCodes } = await enrolTwoFactor(u);
    await signInWithRecoveryCode(u, recoveryCodes[0]!);
    const audit = await migrator().auditLog.findFirstOrThrow({
      where: { orgId: org.orgId, action: 'user.recovery_code_used', entityId: u.id },
    });
    expect(audit.metadata).toEqual({ recoveryCodesLeft: 9 });
  });
});

describe('turning off and replacing the authenticator', () => {
  it('Owners and Admins cannot turn 2FA off; optional users can', async () => {
    const ownerHeaders = await signIn(org.users.owner);
    expect(
      await outcome(
        auth().api.disableTwoFactor({ headers: ownerHeaders, body: { password: PASSWORD } }),
      ),
    ).toBe('TWO_FACTOR_REQUIRED_FOR_ROLE');
    const exec = await memberWithoutTwoFactor('opt-exec', 'sales_executive');
    await enrolTwoFactor(exec);
    const execHeaders = await signIn(exec);
    expect(
      await outcome(
        auth().api.disableTwoFactor({ headers: execHeaders, body: { password: PASSWORD } }),
      ),
    ).toBe('OK');
  });

  it('replacement needs the password and a valid second factor', async () => {
    const u = await memberWithoutTwoFactor('replace', 'admin');
    const { recoveryCodes } = await enrolTwoFactor(u);
    const headers = await signIn(u);
    expect(
      await outcome(
        resetOwnAuthenticator(headers, { password: 'wrong-password-123', code: recoveryCodes[0]! }),
      ),
    ).toBe('FORBIDDEN');
    expect(
      await outcome(resetOwnAuthenticator(headers, { password: PASSWORD, code: 'aaaa-bbbb-cccc' })),
    ).toBe('FORBIDDEN');
    expect(
      await outcome(resetOwnAuthenticator(headers, { password: PASSWORD, code: '123456' })),
    ).toBe('FORBIDDEN');
    // The failed attempts consumed nothing and changed nothing.
    expect(await migrator().twoFactor.count({ where: { userId: u.id } })).toBe(1);

    await resetOwnAuthenticator(headers, { password: PASSWORD, code: recoveryCodes[0]! });
    expect(await migrator().twoFactor.count({ where: { userId: u.id } })).toBe(0);
    await auth().api.setActiveOrganization({ headers, body: { organizationId: org.orgId } });
    const r = await resolveRequestContext(headers);
    expect(!r.ok && r.reason).toBe('TWO_FACTOR_REQUIRED');
    expect(
      await migrator().auditLog.count({
        where: { orgId: org.orgId, action: 'user.authenticator_reset', entityId: u.id },
      }),
    ).toBe(1);
  });

  it('replacement attempts are rate-limited per user', async () => {
    const u = await createUser('replace-rl');
    await enrolTwoFactor(u);
    const headers = await signIn(u);
    const results: string[] = [];
    for (let i = 0; i < 6; i++)
      results.push(
        await outcome(resetOwnAuthenticator(headers, { password: PASSWORD, code: '000000' })),
      );
    expect(results.slice(0, 5).every((r) => r === 'FORBIDDEN')).toBe(true);
    expect(results[5]).toBe('RATE_LIMITED');
  });
});

describe('platform-assisted reset (lost authenticator and recovery codes)', () => {
  it('ends sessions, disables the old password, forces email reset, and is audited', async () => {
    const staff = await createUser('reset-staff', { platformAdmin: true });
    const staffUser = (await resolveRequestContext(await signIn(staff))).user;
    const victim = await memberWithoutTwoFactor('reset-target', 'admin');
    await enrolTwoFactor(victim);
    const victimSession = await signIn(victim);

    await platform.resetUserTwoFactor(
      staffUser,
      {
        email: victim.email,
        reason: 'Lost phone and recovery codes',
        verificationReference: 'TICKET-1',
      },
      'http://127.0.0.1:3100',
    );

    expect(await sessionValid(victimSession)).toBe(false);
    expect(await migrator().twoFactor.count({ where: { userId: victim.id } })).toBe(0);
    expect(await outcome(signIn(victim))).not.toBe('OK'); // old password no longer works
    expect(
      await migrator().verification.count({
        where: { identifier: { startsWith: 'reset-password' }, value: victim.id },
      }),
    ).toBeGreaterThan(0);
    expect(
      await migrator().auditLog.count({
        where: { orgId: null, action: 'user.two_factor_reset_by_platform', entityId: victim.id },
      }),
    ).toBe(1);
    expect(
      await migrator().auditLog.count({
        where: {
          orgId: org.orgId,
          action: 'user.two_factor_reset_by_platform',
          entityId: victim.id,
        },
      }),
    ).toBe(1);
  });

  it('staff cannot reset their own 2FA, and customers cannot use it', async () => {
    const staff = await createUser('reset-self', { platformAdmin: true });
    const staffUser = (await resolveRequestContext(await signIn(staff))).user;
    const input = {
      email: staff.email,
      reason: 'Trying to reset myself',
      verificationReference: 'X-1',
    };
    expect(await outcome(platform.resetUserTwoFactor(staffUser, input, 'http://x'))).toBe(
      'FORBIDDEN',
    );
    const owner = (await resolveRequestContext(await signIn(org.users.owner))).user;
    expect(
      await outcome(
        platform.resetUserTwoFactor(owner, { ...input, email: org.users.admin.email }, 'http://x'),
      ),
    ).toBe('FORBIDDEN');
  });
});
