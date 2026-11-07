// E2E against the built server: auth routes, headers, disabled endpoints, rate limits,
// invitation sign-up -> email verification -> acceptance, and password reset via Mailpit.
import { beforeAll, describe, expect, it } from 'vitest';
import * as members from '@/modules/members';
import { migrator } from '../support/db';
import { actorIn, email, PASSWORD, seedOrg } from '../support/factory';
import { Browser, firstUrl, waitForEmail } from './http';

let org: Awaited<ReturnType<typeof seedOrg>>;
beforeAll(async () => {
  org = await seedOrg('E2EAuth');
});

describe('baseline HTTP behaviour', () => {
  it('health check and security headers', async () => {
    const res = await new Browser().get('/api/health');
    expect(res.status).toBe(200);
    const page = await new Browser().get('/login');
    expect(page.headers.get('content-security-policy')).toMatch(/frame-ancestors 'none'/);
    expect(page.headers.get('x-frame-options')).toBe('DENY');
    expect(page.headers.get('x-content-type-options')).toBe('nosniff');
    expect(page.headers.get('strict-transport-security')).toMatch(/max-age=/);
    expect(page.headers.get('x-powered-by')).toBeNull();
  });

  it('signed-out requests to app pages redirect to login', async () => {
    for (const p of ['/app', '/app/settings/members', '/platform']) {
      const res = await new Browser().get(p);
      expect(res.status, p).toBe(307);
      expect(res.headers.get('location'), p).toContain(`/login?next=${encodeURIComponent(p)}`);
    }
  });

  it('sign-in sets an HttpOnly, SameSite session cookie and opens the app', async () => {
    const b = new Browser();
    const res = await b.signIn(org.users.owner.email, PASSWORD);
    expect(res.status).toBe(200);
    const setCookie = res.headers.getSetCookie().join('\n');
    expect(setCookie).toMatch(/session_token=.*HttpOnly/i);
    expect(setCookie).toMatch(/SameSite=Lax/i);
    await b.authPost('/organization/set-active', { organizationId: org.orgId });
    const app = await b.get('/app');
    expect(app.status).toBe(200);
    expect(await app.text()).toContain('E2EAuth');
  });

  it.each([
    '/organization/invite-member',
    '/organization/update-member-role',
    '/organization/remove-member',
    '/organization/cancel-invitation',
    '/organization/list-members',
    '/organization/list-invitations',
    '/organization/get-full-organization',
    '/organization/update',
    '/organization/delete',
    '/organization/create',
    '/update-user',
    '/delete-user',
    '/change-email',
  ])('HTTP %s is disabled (404); these go through authorised Server Actions', async (path) => {
    const b = new Browser();
    await b.signIn(org.users.owner.email, PASSWORD);
    const res = await b.authPost(path, { organizationId: org.orgId });
    expect(res.status).toBe(404);
  });

  it('cross-origin, cookie-bearing auth requests are rejected (CSRF)', async () => {
    const b = new Browser();
    await b.signIn(org.users.manager.email, PASSWORD);
    const res = await b.authPost('/revoke-sessions', {}, { origin: 'https://evil.example' });
    expect(res.status).toBe(403);
    expect((await b.get('/api/auth/get-session')).status).toBe(200);
    expect(await (await b.get('/api/auth/get-session')).json()).not.toBeNull();
  });

  it('sign-in is rate-limited per client IP (10/min)', async () => {
    const b = new Browser();
    const statuses: number[] = [];
    for (let i = 0; i < 11; i++)
      statuses.push((await b.signIn(org.users.exec1.email, 'wrong-password-123')).status);
    expect(statuses.slice(0, 10).every((s) => s === 401)).toBe(true);
    expect(statuses[10]).toBe(429);
  });
});

describe('invitation flow over real routes and email (D3)', () => {
  it('invite -> email -> sign-up -> verify -> sign in -> accept -> member', async () => {
    const owner = await actorIn(org.users.owner, org.orgId);
    const inviteeEmail = email('e2e-invitee');
    const { id } = await members.inviteMember(owner.ctx, owner.headers, {
      email: inviteeEmail,
      role: 'sales_executive',
    });

    const inviteMail = await waitForEmail(inviteeEmail, /Invitation to join/);
    expect(firstUrl(inviteMail)).toBe(`http://127.0.0.1:3100/invite/${id}`);

    const b = new Browser();
    const page = await b.get(`/invite/${id}`);
    expect(await page.text()).toContain(`/signup?invitation=${id}`);

    const signUp = await b.authPost('/sign-up/email', {
      email: inviteeEmail,
      password: PASSWORD,
      name: 'E2E Invitee',
      callbackURL: '/login?notice=verified',
    });
    expect(signUp.status).toBe(200);
    expect((await b.signIn(inviteeEmail, PASSWORD)).status).toBe(403); // not verified yet

    const verifyUrl = firstUrl(await waitForEmail(inviteeEmail, /Confirm your email/));
    const verify = await b.fetch(verifyUrl.replace('http://127.0.0.1:3100', ''));
    expect(verify.status).toBe(302);

    expect((await b.signIn(inviteeEmail, PASSWORD)).status).toBe(200);
    const invitePage = await (await b.get(`/invite/${id}`)).text();
    expect(
      invitePage.replace(/<!-- -->/g, ''),
      invitePage.match(/role="(alert|status)"[^<]*<[^>]*>[^<]*/)?.[0] ?? '',
    ).toContain('Join E2EAuth');
    const accept = await b.authPost('/organization/accept-invitation', { invitationId: id });
    expect(accept.status).toBe(200);
    const user = await migrator().user.findUniqueOrThrow({ where: { email: inviteeEmail } });
    expect(
      await migrator().member.count({
        where: {
          organizationId: org.orgId,
          userId: user.id,
          role: 'sales_executive',
          status: 'ACTIVE',
        },
      }),
    ).toBe(1);
  });

  it('someone else signed in cannot see or accept the invitation', async () => {
    const owner = await actorIn(org.users.owner, org.orgId);
    const { id } = await members.inviteMember(owner.ctx, owner.headers, {
      email: email('intended'),
      role: 'sales_executive',
    });
    const b = new Browser();
    await b.signIn(org.users.exec2.email, PASSWORD);
    expect(await (await b.get(`/invite/${id}`)).text()).toContain('not available');
    expect((await b.authPost('/organization/accept-invitation', { invitationId: id })).status).toBe(
      403,
    );
  });

  it('sign-up without an invitation creates no account', async () => {
    const e = email('nobody');
    await new Browser().authPost('/sign-up/email', {
      email: e,
      password: PASSWORD,
      name: 'Nobody',
    });
    expect(await migrator().user.count({ where: { email: e } })).toBe(0);
  });
});

describe('password reset over real routes and email', () => {
  it('reset link works once, revokes sessions, and is never logged in our audit metadata', async () => {
    const b = new Browser();
    await b.signIn(org.users.exec2.email, PASSWORD);
    expect((await b.get('/api/auth/get-session')).status).toBe(200);

    await new Browser().authPost('/request-password-reset', {
      email: org.users.exec2.email,
      redirectTo: '/reset-password',
    });
    const resetUrl = firstUrl(await waitForEmail(org.users.exec2.email, /Reset your password/));
    const redirect = await new Browser().fetch(resetUrl.replace('http://127.0.0.1:3100', ''));
    expect(redirect.status).toBe(302);
    const token = new URL(redirect.headers.get('location')!, 'http://x').searchParams.get('token')!;
    expect(token).toBeTruthy();

    const newPassword = 'a-new-long-enough-password';
    expect((await new Browser().authPost('/reset-password', { newPassword, token })).status).toBe(
      200,
    );
    expect(
      (
        await new Browser().authPost('/reset-password', {
          newPassword: 'another-long-password-1',
          token,
        })
      ).status,
    ).toBe(400);
    const session = await (await b.get('/api/auth/get-session')).json();
    expect(session).toBeNull();
    expect((await new Browser().signIn(org.users.exec2.email, newPassword)).status).toBe(200);

    const audit = await migrator().auditLog.findMany({ select: { metadata: true } });
    expect(JSON.stringify(audit)).not.toContain(token);
  });
});
