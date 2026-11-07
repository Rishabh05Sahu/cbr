// Platform console + owner-approved support access.
import { beforeAll, describe, expect, it } from 'vitest';
import * as members from '@/modules/members';
import * as platform from '@/modules/platform-admin';
import * as support from '@/modules/support-access';
import { auth } from '@/platform/auth/auth';
import { resolveRequestContext, type SessionUser } from '@/platform/auth/context';
import { DomainError } from '@/platform/errors';
import { migrator } from '../support/db';
import { actorIn, createUser, email, seedOrg, signIn, type TestUser } from '../support/factory';

let org: Awaited<ReturnType<typeof seedOrg>>;
let staff: TestUser;
let staffUser: SessionUser;
let staffHeaders: Headers;

const code = async (p: Promise<unknown>) => {
  try {
    await p;
    return 'OK';
  } catch (e) {
    if (e instanceof DomainError) return e.code;
    throw e;
  }
};

beforeAll(async () => {
  org = await seedOrg('Support');
  staff = await createUser('staff', { platformAdmin: true });
  staffHeaders = await signIn(staff);
  const r = await resolveRequestContext(staffHeaders);
  staffUser = r.user!;
});

describe('platform console', () => {
  it('is for platform staff only', async () => {
    const owner = await resolveRequestContext(await signIn(org.users.owner));
    expect(await code(platform.listOrganizations(owner.user))).toBe('FORBIDDEN');
    expect(await code(platform.listOrganizations(null))).toBe('FORBIDDEN');
  });

  it('provisions an org with a new Owner (set-password email queued) and audits it', async () => {
    const ownerEmail = email('newowner');
    const res = await platform.createOrganization(
      staffUser,
      { name: 'Baner Homes', ownerName: 'New Owner', ownerEmail },
      'http://localhost:3100',
    );
    expect(res.ownerCreated).toBe(true);
    const m = await migrator().member.findFirstOrThrow({ where: { organizationId: res.orgId } });
    expect(m).toMatchObject({ userId: res.ownerUserId, role: 'owner', status: 'ACTIVE' });
    expect(
      await migrator().account.count({
        where: { userId: res.ownerUserId, password: { not: null } },
      }),
    ).toBe(0);
    expect(
      await migrator().verification.count({
        where: { identifier: { startsWith: 'reset-password' } },
      }),
    ).toBeGreaterThan(0);
    expect(
      await migrator().auditLog.count({
        where: { orgId: null, action: 'organization.created', entityId: res.orgId },
      }),
    ).toBe(1);
    const list = await platform.listOrganizations(staffUser);
    expect(list.find((o) => o.orgId === res.orgId)).toMatchObject({
      name: 'Baner Homes',
      activeMembers: 1,
    });
  });

  it('suspending an org blocks all its members', async () => {
    const owner = await actorIn(org.users.exec1, org.orgId);
    await platform.setOrganizationStatus(staffUser, org.orgId, 'SUSPENDED');
    expect(await resolveRequestContext(owner.headers)).toMatchObject({
      ok: false,
      reason: 'ORG_SUSPENDED',
    });
    await platform.setOrganizationStatus(staffUser, org.orgId, 'ACTIVE');
    expect((await resolveRequestContext(owner.headers)).ok).toBe(true);
  });
});

describe('support access', () => {
  let grantId: string;

  it('no membership + no grant = no access, even with the org opened', async () => {
    await expect(
      auth().api.setActiveOrganization({
        headers: staffHeaders,
        body: { organizationId: org.orgId },
      }),
    ).rejects.toThrow();
    await platform.openOrgForSupport(staffUser, staffHeaders, org.orgId);
    expect(await resolveRequestContext(staffHeaders)).toMatchObject({
      ok: false,
      reason: 'NOT_A_MEMBER',
    });
  });

  it('a requested grant needs Owner approval (Admin cannot approve)', async () => {
    grantId = (
      await platform.requestSupportGrant(staffUser, {
        orgId: org.orgId,
        reason: 'Investigating import ticket #12',
        hours: 2,
      })
    ).id;
    expect(await resolveRequestContext(staffHeaders)).toMatchObject({ ok: false });
    const admin = await actorIn(org.users.admin, org.orgId);
    expect(await code(support.approveGrant(admin.ctx, grantId))).toBe('FORBIDDEN');
    const owner = await actorIn(org.users.owner, org.orgId);
    await support.approveGrant(owner.ctx, grantId);
  });

  it('approved access is read-only, audited in both logs, and limited to that org', async () => {
    const r = await resolveRequestContext(staffHeaders);
    if (!r.ok) throw new Error(r.reason);
    expect(r.ctx).toMatchObject({ kind: 'support', orgId: org.orgId });
    expect((await members.listMembers(r.ctx)).length).toBe(6);
    expect(await code(members.suspendMember(r.ctx, org.membership.exec1!))).toBe('FORBIDDEN');
    expect(
      await migrator().auditLog.count({
        where: { orgId: org.orgId, action: 'support_access.used' },
      }),
    ).toBeGreaterThan(0);
    expect(
      await migrator().auditLog.count({
        where: { orgId: null, action: 'support_access.used', actorUserId: staff.id },
      }),
    ).toBeGreaterThan(0);
    const other = await seedOrg('Other');
    await platform.openOrgForSupport(staffUser, staffHeaders, other.orgId);
    expect((await resolveRequestContext(staffHeaders)).ok).toBe(false);
    await platform.openOrgForSupport(staffUser, staffHeaders, org.orgId);
  });

  it('the Owner can revoke at any time; grants cannot exceed 72 h', async () => {
    const owner = await actorIn(org.users.owner, org.orgId);
    await support.revokeGrant(owner.ctx, grantId);
    expect((await resolveRequestContext(staffHeaders)).ok).toBe(false);
    await expect(
      platform.requestSupportGrant(staffUser, {
        orgId: org.orgId,
        reason: 'Too long a grant request',
        hours: 73,
      }),
    ).rejects.toThrow();
  });

  it('a non-platform user cannot open an org through the support path', async () => {
    const exec = await signIn(org.users.exec2);
    const execUser = (await resolveRequestContext(exec)).user!;
    expect(await code(platform.openOrgForSupport(execUser, exec, org.orgId))).toBe('FORBIDDEN');
  });
});
