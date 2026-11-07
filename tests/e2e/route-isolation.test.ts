// Actual-app-route authorisation and cross-organisation isolation (approval condition before
// real customer data). Pages are fetched and Server Actions invoked over HTTP exactly as the
// browser does, against the built server.
import { beforeAll, describe, expect, it } from 'vitest';
import * as members from '@/modules/members';
import * as teams from '@/modules/teams';
import { migrator } from '../support/db';
import { actorIn, createUser, email, PASSWORD, seedOrg } from '../support/factory';
import { Browser } from './http';

const M = 'src/modules/members/actions.ts';
const T = 'src/modules/teams/actions.ts';
const O = 'src/modules/organizations/actions.ts';
const P = 'src/modules/profile/actions.ts';
const S = 'src/modules/support-access/actions.ts';
const PA = 'src/modules/platform-admin/actions.ts';

let A: Awaited<ReturnType<typeof seedOrg>>;
let B: Awaited<ReturnType<typeof seedOrg>>;
let bTeam: string;
let bInvitation: string;
let bGrant: string;
let bEmails: string[];

async function browserFor(user: { email: string }, orgId: string): Promise<Browser> {
  const b = new Browser();
  expect((await b.signIn(user.email, PASSWORD)).status).toBe(200);
  expect((await b.authPost('/organization/set-active', { organizationId: orgId })).status).toBe(
    200,
  );
  return b;
}

const text = async (b: Browser, path: string) =>
  (await (await b.get(path)).text()).replace(/<!-- -->/g, '');

beforeAll(async () => {
  A = await seedOrg('RouteA');
  B = await seedOrg('RouteB');
  const ownerB = await actorIn(B.users.owner, B.orgId);
  bTeam = (await teams.createTeam(ownerB.ctx, { name: 'Bravo Team' })).id;
  bInvitation = (
    await members.inviteMember(ownerB.ctx, ownerB.headers, {
      email: email('b-pending'),
      role: 'sales_executive',
    })
  ).id;
  bGrant = (
    await migrator().supportAccessGrant.create({
      data: {
        orgId: B.orgId,
        platformUserId: B.users.owner.id,
        reason: 'pending grant in B',
        accessLevel: 'READ',
        startsAt: new Date(),
        expiresAt: new Date(Date.now() + 3_600_000),
      },
    })
  ).id;
  bEmails = Object.values(B.users).map((u) => u.email);
});

describe('pages render only the active org', () => {
  it.each([
    '/app',
    '/app/settings/members',
    '/app/settings/teams',
    '/app/settings/organization',
    '/app/settings/audit',
    '/app/settings/support-access',
  ])('org A owner: %s contains no org B data', async (path) => {
    const b = await browserFor(A.users.owner, A.orgId);
    const res = await b.get(path);
    expect(res.status).toBe(200);
    const html = (await res.text()).replace(/<!-- -->/g, '');
    for (const e of bEmails) expect(html).not.toContain(e);
    expect(html).not.toContain('RouteB');
    expect(html).not.toContain('Bravo Team');
    expect(html).not.toContain(B.orgId);
  });

  it('organisation page: masking status and reveal limit only for Owner and Admin', async () => {
    for (const k of ['owner', 'admin'] as const) {
      const html = await text(await browserFor(A.users[k], A.orgId), '/app/settings/organization');
      expect(html, k).toContain('Phone masking');
    }
    for (const k of ['manager', 'exec1', 'hr'] as const) {
      const html = await text(await browserFor(A.users[k], A.orgId), '/app/settings/organization');
      expect(html, k).toContain('Organisation name');
      expect(html, k).not.toContain('Phone masking');
      expect(html, k).not.toContain('reveals per person per day');
      // No save forms (their labels and success messages are not even sent).
      expect(html, k).not.toContain('Save phone masking');
      expect(html, k).not.toContain('Settings saved.');
    }
  });

  it('member listing follows role scope on the real page', async () => {
    const exec = await browserFor(A.users.exec1, A.orgId);
    const html = await text(exec, '/app/settings/members');
    expect(html).toContain(A.users.exec1.email);
    expect(html).not.toContain(A.users.exec2.email);
    expect(html).not.toContain('Invite someone');
  });

  it('pages a role may not use are 404, and hidden from navigation', async () => {
    for (const k of ['manager', 'exec1', 'hr'] as const) {
      const b = await browserFor(A.users[k], A.orgId);
      expect((await b.get('/app/settings/audit')).status, k).toBe(404);
      expect((await b.get('/app/settings/support-access')).status, k).toBe(404);
      const home = await text(b, '/app');
      expect(home, k).not.toContain('/app/settings/audit');
    }
    const admin = await browserFor(A.users.admin, A.orgId);
    expect((await admin.get('/app/settings/audit')).status).toBe(200);
    expect((await admin.get('/app/settings/support-access')).status).toBe(404); // Owner only
    const nonPlatform = await browserFor(A.users.owner, A.orgId);
    expect((await nonPlatform.get('/platform')).status).toBe(404);
  });
});

describe("Server Actions with org B's ids from an org A session change nothing", () => {
  it.each([
    [
      '/app/settings/members',
      M,
      'suspendMemberAction',
      () => ({ membershipId: B.membership.exec1! }),
    ],
    [
      '/app/settings/members',
      M,
      'deactivateMemberAction',
      () => ({ membershipId: B.membership.exec1! }),
    ],
    [
      '/app/settings/members',
      M,
      'reactivateMemberAction',
      () => ({ membershipId: B.membership.exec1! }),
    ],
    [
      '/app/settings/members',
      M,
      'changeRoleAction',
      () => ({ membershipId: B.membership.exec1!, role: 'sales_manager' }),
    ],
    [
      '/app/settings/members',
      M,
      'updateHrProfileAction',
      () => ({ membershipId: B.membership.exec1!, employeeCode: 'PWN' }),
    ],
    ['/app/settings/members', M, 'cancelInvitationAction', () => ({ invitationId: bInvitation })],
    ['/app/settings/teams', T, 'renameTeamAction', () => ({ teamId: bTeam, name: 'pwned' })],
    ['/app/settings/teams', T, 'archiveTeamAction', () => ({ teamId: bTeam })],
    [
      '/app/settings/teams',
      T,
      'addTeamMemberAction',
      () => ({ teamId: bTeam, membershipId: A.membership.exec1! }),
    ],
    ['/app/settings/support-access', S, 'approveGrantAction', () => ({ grantId: bGrant })],
    ['/app/settings/support-access', S, 'revokeGrantAction', () => ({ grantId: bGrant })],
  ] as const)('%s %s -> NOT_FOUND', async (page, file, name, fields) => {
    const b = await browserFor(A.users.owner, A.orgId);
    const r = await b.action(page, file, name, fields());
    expect(r.status).toBe(200);
    expect(r).toMatchObject({ ok: false, code: 'NOT_FOUND' });
  });

  it('org B is untouched', async () => {
    expect(
      await migrator().member.findUniqueOrThrow({ where: { id: B.membership.exec1! } }),
    ).toMatchObject({ role: 'sales_executive', status: 'ACTIVE', employeeCode: null });
    expect(await migrator().team.findUniqueOrThrow({ where: { id: bTeam } })).toMatchObject({
      name: 'Bravo Team',
      archivedAt: null,
    });
    expect(
      (await migrator().invitation.findUniqueOrThrow({ where: { id: bInvitation } })).status,
    ).toBe('pending');
    expect(
      await migrator().supportAccessGrant.findUniqueOrThrow({ where: { id: bGrant } }),
    ).toMatchObject({ approvedByUserId: null, revokedAt: null });
  });

  it('switching to an org you are not a member of is refused', async () => {
    const b = await browserFor(A.users.owner, A.orgId);
    expect(
      await b.action('/app/select-org', O, 'switchOrganizationAction', { orgId: B.orgId }),
    ).toMatchObject({ ok: false, code: 'FORBIDDEN' });
  });

  it('a forged active org in the session gives no access (pages redirect, actions refuse)', async () => {
    const b = await browserFor(A.users.admin, A.orgId);
    await migrator().session.updateMany({
      where: { userId: A.users.admin.id },
      data: { activeOrganizationId: B.orgId },
    });
    const page = await b.get('/app/settings/members');
    expect(page.status).toBe(307);
    expect(page.headers.get('location')).toContain('/app/select-org');
    expect(
      await b.action('/app/settings/members', M, 'suspendMemberAction', {
        membershipId: B.membership.exec1!,
      }),
    ).toMatchObject({ ok: false, code: 'FORBIDDEN' });
  });
});

describe('role permissions enforced on real Server Actions', () => {
  it('executive, manager and HR cannot invite, change roles, suspend or manage teams', async () => {
    for (const k of ['exec1', 'manager', 'hr'] as const) {
      const b = await browserFor(A.users[k], A.orgId);
      expect(
        await b.action('/app/settings/members', M, 'inviteMemberAction', {
          email: email('x'),
          role: 'sales_executive',
        }),
        k,
      ).toMatchObject({ ok: false, code: 'FORBIDDEN' });
      expect(
        await b.action('/app/settings/members', M, 'changeRoleAction', {
          membershipId: A.membership.exec2!,
          role: 'admin',
        }),
        k,
      ).toMatchObject({ ok: false, code: 'FORBIDDEN' });
      expect(
        await b.action('/app/settings/members', M, 'suspendMemberAction', {
          membershipId: A.membership.exec2!,
        }),
        k,
      ).toMatchObject({ ok: false, code: 'FORBIDDEN' });
      expect(
        await b.action('/app/settings/teams', T, 'createTeamAction', { name: `T-${k}` }),
        k,
      ).toMatchObject({ ok: false, code: 'FORBIDDEN' });
    }
  });

  it('Admin cannot grant or act on Admin/Owner; Owner can', async () => {
    const admin = await browserFor(A.users.admin, A.orgId);
    expect(
      await admin.action('/app/settings/members', M, 'changeRoleAction', {
        membershipId: A.membership.exec2!,
        role: 'admin',
      }),
    ).toMatchObject({ ok: false, code: 'FORBIDDEN' });
    expect(
      await admin.action('/app/settings/members', M, 'suspendMemberAction', {
        membershipId: A.membership.owner!,
      }),
    ).toMatchObject({ ok: false, code: 'FORBIDDEN' });
    expect(
      await admin.action('/app/settings/members', M, 'inviteMemberAction', {
        email: email('adm'),
        role: 'admin',
      }),
    ).toMatchObject({ ok: false, code: 'FORBIDDEN' });
    const owner = await browserFor(A.users.owner, A.orgId);
    expect(
      await owner.action('/app/settings/members', M, 'inviteMemberAction', {
        email: email('adm'),
        role: 'admin',
      }),
    ).toMatchObject({ ok: true });
  });

  it('platform actions are refused for non-platform users', async () => {
    const owner = await browserFor(A.users.owner, A.orgId);
    expect(
      await owner.action('/platform', PA, 'createOrganizationAction', {
        name: 'Hijack',
        ownerName: 'X Y',
        ownerEmail: email('hj'),
      }),
    ).toMatchObject({ ok: false, code: 'FORBIDDEN' });
    expect(
      await owner.action('/platform', PA, 'setOrganizationStatusAction', {
        orgId: B.orgId,
        status: 'SUSPENDED',
      }),
    ).toMatchObject({ ok: false, code: 'FORBIDDEN' });
  });

  it('a successful action works end to end and is audited', async () => {
    const b = await browserFor(A.users.exec1, A.orgId);
    expect(
      await b.action('/app/settings/profile', P, 'updateProfileAction', {
        name: 'Route Exec',
        phone: '9876543210',
      }),
    ).toMatchObject({ ok: true });
    expect(
      await migrator().user.findUniqueOrThrow({ where: { id: A.users.exec1.id } }),
    ).toMatchObject({ name: 'Route Exec', phoneE164: '+919876543210' });
    expect(
      await migrator().auditLog.count({
        where: { orgId: A.orgId, action: 'user.profile_updated', actorUserId: A.users.exec1.id },
      }),
    ).toBe(1);
  });
});

describe('session and request integrity', () => {
  it('actions without a session are refused', async () => {
    expect(
      await new Browser().action('/app/settings/members', M, 'suspendMemberAction', {
        membershipId: A.membership.exec2!,
      }),
    ).toMatchObject({ ok: false, code: 'UNAUTHENTICATED' });
  });

  it('cross-origin Server Action calls are rejected by the framework', async () => {
    const b = await browserFor(A.users.owner, A.orgId);
    const r = await b.action(
      '/app/settings/members',
      M,
      'suspendMemberAction',
      { membershipId: A.membership.exec2! },
      { origin: 'https://evil.example' },
    );
    expect(r.ok).not.toBe(true);
    expect(r.status).toBeGreaterThanOrEqual(400);
    expect(
      (await migrator().member.findUniqueOrThrow({ where: { id: A.membership.exec2! } })).status,
    ).toBe('ACTIVE');
  });

  it('suspension through the real route ends the target session immediately', async () => {
    const victim = await browserFor(A.users.exec2, A.orgId);
    expect((await victim.get('/app')).status).toBe(200);
    const owner = await browserFor(A.users.owner, A.orgId);
    expect(
      await owner.action('/app/settings/members', M, 'suspendMemberAction', {
        membershipId: A.membership.exec2!,
      }),
    ).toMatchObject({ ok: true });
    expect((await victim.get('/app')).status).toBe(307);
    expect(await (await victim.get('/api/auth/get-session')).json()).toBeNull();
    expect(
      await owner.action('/app/settings/members', M, 'reactivateMemberAction', {
        membershipId: A.membership.exec2!,
      }),
    ).toMatchObject({ ok: true });
  });

  it('a user with no membership sees the org chooser with nothing in it', async () => {
    const loner = await createUser('loner');
    const b = new Browser();
    await b.signIn(loner.email, PASSWORD);
    const app = await b.get('/app');
    expect(app.status).toBe(307);
    expect(app.headers.get('location')).toContain('/app/select-org');
    const html = await text(b, '/app/select-org');
    expect(html).toContain('not a member of any organisation');
  });
});

describe('platform support over real routes', () => {
  it('without an approved grant, opening an org gives no data; with one, read-only access', async () => {
    const staff = await createUser('route-staff', { platformAdmin: true });
    const b = new Browser();
    await b.signIn(staff.email, PASSWORD);
    expect((await b.get('/platform')).status).toBe(200);
    await b.action('/platform', PA, 'openOrgForSupportAction', { orgId: A.orgId });
    const blocked = await b.get('/app/settings/members');
    expect(blocked.status).toBe(307);

    const req = await b.action('/platform', PA, 'requestSupportGrantAction', {
      orgId: A.orgId,
      reason: 'Route test support ticket',
      hours: '1',
    });
    expect(req).toMatchObject({ ok: true });
    const grant = await migrator().supportAccessGrant.findFirstOrThrow({
      where: { orgId: A.orgId, platformUserId: staff.id },
    });
    const owner = await browserFor(A.users.owner, A.orgId);
    expect(
      await owner.action('/app/settings/support-access', S, 'approveGrantAction', {
        grantId: grant.id,
      }),
    ).toMatchObject({ ok: true });

    const html = await text(b, '/app/settings/members');
    expect(html).toContain(A.users.exec1.email);
    expect(html).toContain('Support access');
    expect(
      await b.action('/app/settings/members', M, 'suspendMemberAction', {
        membershipId: A.membership.exec1!,
      }),
    ).toMatchObject({ ok: false, code: 'FORBIDDEN' });
    expect(
      await migrator().auditLog.count({
        where: { orgId: A.orgId, action: 'support_access.used', actorUserId: staff.id },
      }),
    ).toBeGreaterThan(0);
  });
});
