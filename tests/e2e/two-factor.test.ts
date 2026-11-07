// Mandatory Owner/Admin/platform 2FA over the real routes (owner decision item D): page and
// Server Action enforcement, enrolment, recovery-code sign-in, replacement, notifications.
import { beforeAll, describe, expect, it } from 'vitest';
import { migrator } from '../support/db';
import { addMember, createUser, PASSWORD, seedOrg, type TestUser } from '../support/factory';
import { authenticators, secretFromUri, totp } from '../support/totp';
import { Browser, waitForEmail } from './http';

const M = 'src/modules/members/actions.ts';
const P = 'src/modules/profile/actions.ts';
const SETUP = '/app/security/two-factor';

let org: Awaited<ReturnType<typeof seedOrg>>;

beforeAll(async () => {
  org = await seedOrg('E2E2FA');
});

async function signedIn(user: TestUser, orgId = org.orgId): Promise<Browser> {
  const b = new Browser();
  expect((await b.signIn(user.email, PASSWORD)).status).toBe(200);
  await b.authPost('/organization/set-active', { organizationId: orgId });
  return b;
}

/** Enrols through the HTTP endpoints exactly as the setup page does. */
async function enrolOverHttp(b: Browser, user: TestUser): Promise<string[]> {
  const enable = await b.authPost('/two-factor/enable', { password: PASSWORD });
  expect(enable.status).toBe(200);
  const { totpURI, backupCodes } = (await enable.json()) as {
    totpURI: string;
    backupCodes: string[];
  };
  const secret = secretFromUri(totpURI);
  expect((await b.authPost('/two-factor/verify-totp', { code: totp(secret) })).status).toBe(200);
  authenticators.set(user.email, secret);
  return backupCodes;
}

describe('Owner without an authenticator', () => {
  it('is sent to set-up from every app page, and Server Actions are refused', async () => {
    const owner2 = await createUser('e2e-owner2');
    await addMember(org.orgId, owner2, 'owner');
    const b = await signedIn(owner2);
    for (const p of ['/app', '/app/settings/members', '/app/settings/audit']) {
      const res = await b.get(p);
      expect(res.status, p).toBe(307);
      expect(res.headers.get('location'), p).toContain(SETUP);
    }
    expect((await b.get(SETUP)).status).toBe(200);
    const r = await b.action('/app/settings/members', M, 'suspendMemberAction', {
      membershipId: org.membership.exec1!,
    });
    expect(r).toMatchObject({ ok: false, code: 'TWO_FACTOR_REQUIRED' });
    expect(
      (await migrator().member.findUniqueOrThrow({ where: { id: org.membership.exec1! } })).status,
    ).toBe('ACTIVE');

    // Enrol over HTTP; the session is replaced and the app opens.
    const codes = await enrolOverHttp(b, owner2);
    expect(codes).toHaveLength(10);
    await b.authPost('/organization/set-active', { organizationId: org.orgId });
    expect((await b.get('/app/settings/members')).status).toBe(200);
    expect(await waitForEmail(owner2.email, /Security alert/)).toContain(
      'Two-step verification was turned on',
    );
  });

  it('platform staff without an authenticator are sent to set-up from the console', async () => {
    const staff = await createUser('e2e-staff-no2fa', { platformAdmin: true, twoFactor: false });
    const b = new Browser();
    await b.signIn(staff.email, PASSWORD);
    const res = await b.get('/platform');
    expect(res.status).toBe(307);
    expect(res.headers.get('location')).toContain(SETUP);
  });
});

describe('sign-in with a second factor', () => {
  it('the password step sets no session cookie; the TOTP step does', async () => {
    const b = new Browser();
    const res = await b.authPost('/sign-in/email', {
      email: org.users.owner.email,
      password: PASSWORD,
    });
    expect(res.status).toBe(200);
    expect(await res.json()).toMatchObject({ twoFactorRedirect: true });
    expect(await (await b.get('/api/auth/get-session')).json()).toBeNull();
    expect((await b.get('/app')).status).toBe(307);
    const ok = await b.authPost('/two-factor/verify-totp', {
      code: totp(authenticators.get(org.users.owner.email)!),
    });
    expect(ok.status).toBe(200);
    expect(ok.headers.getSetCookie().join('\n')).toMatch(/session_token=.*HttpOnly/i);
  });

  it('a recovery code signs in once; reusing it is refused; the user is alerted', async () => {
    const admin2 = await createUser('e2e-admin2');
    await addMember(org.orgId, admin2, 'admin');
    const codes = await enrolOverHttp(await signedIn(admin2), admin2);

    const first = new Browser();
    await first.authPost('/sign-in/email', { email: admin2.email, password: PASSWORD });
    expect(
      (await first.authPost('/two-factor/verify-backup-code', { code: codes[0] })).status,
    ).toBe(200);
    expect(await (await first.get('/api/auth/get-session')).json()).not.toBeNull();

    const second = new Browser();
    await second.authPost('/sign-in/email', { email: admin2.email, password: PASSWORD });
    expect(
      (await second.authPost('/two-factor/verify-backup-code', { code: codes[0] })).status,
    ).toBe(401);
    expect(await (await second.get('/api/auth/get-session')).json()).toBeNull();
    expect(await waitForEmail(admin2.email, /Security alert/)).toBeTruthy();
  });

  it('wrong second-factor codes lock the challenge after 5 attempts', async () => {
    const b = new Browser();
    await b.authPost('/sign-in/email', { email: org.users.admin.email, password: PASSWORD });
    const statuses: number[] = [];
    for (let i = 0; i < 6; i++)
      statuses.push((await b.authPost('/two-factor/verify-totp', { code: '000000' })).status);
    expect(statuses.slice(0, 5).every((s) => s === 401)).toBe(true);
    expect(statuses[5]).not.toBe(200);
    const late = await b.authPost('/two-factor/verify-totp', {
      code: totp(authenticators.get(org.users.admin.email)!),
    });
    expect(late.status).not.toBe(200); // the challenge is spent; sign in again
  });
});

describe('managing the second factor', () => {
  it('an Owner cannot turn 2FA off over HTTP', async () => {
    const b = await signedIn(org.users.owner);
    const res = await b.authPost('/two-factor/disable', { password: PASSWORD });
    expect(res.status).toBe(403);
    expect(await migrator().twoFactor.count({ where: { userId: org.users.owner.id } })).toBe(1);
  });

  it('replacing the authenticator via the profile action needs password + a valid code', async () => {
    const admin3 = await createUser('e2e-admin3');
    await addMember(org.orgId, admin3, 'admin');
    const b0 = await signedIn(admin3);
    const codes = await enrolOverHttp(b0, admin3);
    const b = await signedIn(admin3);
    const bad = await b.action('/app/settings/profile', P, 'replaceAuthenticatorAction', {
      password: PASSWORD,
      code: 'zzzz-zzzz-zzzz',
    });
    expect(bad).toMatchObject({ ok: false, code: 'FORBIDDEN' });
    const good = await b.action('/app/settings/profile', P, 'replaceAuthenticatorAction', {
      password: PASSWORD,
      code: codes[1]!,
    });
    expect(good).toMatchObject({ ok: true });
    const res = await b.get('/app/settings/members');
    expect(res.status).toBe(307);
    expect(res.headers.get('location')).toContain(SETUP);
  });
});
