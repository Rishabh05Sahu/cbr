// Members module + invitation controls (D3) + owner-only rules, through the real stack.
import { beforeAll, describe, expect, it } from 'vitest';
import * as members from '@/modules/members';
import { auth } from '@/platform/auth/auth';
import { resolveRequestContext } from '@/platform/auth/context';
import { DomainError } from '@/platform/errors';
import { RateLimited } from '@/platform/rate-limit';
import { migrator } from '../support/db';
import {
  actorIn,
  createUser,
  email,
  PASSWORD,
  seedOrg,
  signIn,
  type Actor,
} from '../support/factory';

let org: Awaited<ReturnType<typeof seedOrg>>;
const a: Record<string, Actor> = {};

const code = async (p: Promise<unknown>) => {
  try {
    await p;
    return 'OK';
  } catch (e) {
    if (e instanceof DomainError) return e.code;
    if (e instanceof RateLimited) return 'RATE_LIMITED';
    throw e;
  }
};

beforeAll(async () => {
  org = await seedOrg('Members');
  for (const k of ['owner', 'admin', 'manager', 'exec1', 'hr'] as const)
    a[k] = await actorIn(org.users[k], org.orgId);
});

describe('listing scope', () => {
  it('Owner/Admin/HR see all; manager sees led team + self; executive sees self only', async () => {
    expect((await members.listMembers(a.owner!.ctx)).length).toBe(6);
    expect((await members.listMembers(a.hr!.ctx)).length).toBe(6);
    expect((await members.listMembers(a.exec1!.ctx)).map((m) => m.userId)).toEqual([
      org.users.exec1.id,
    ]);
    expect((await members.listMembers(a.manager!.ctx)).map((m) => m.userId)).toEqual([
      org.users.manager.id,
    ]);
  });

  it('pending invitations are visible only to users who may invite (D3)', async () => {
    expect(await code(members.listPendingInvitations(a.owner!.ctx))).toBe('OK');
    expect(await code(members.listPendingInvitations(a.admin!.ctx))).toBe('OK');
    for (const k of ['manager', 'exec1', 'hr'])
      expect(await code(members.listPendingInvitations(a[k]!.ctx)), k).toBe('FORBIDDEN');
  });
});

describe('invitations (D3)', () => {
  it('only Owner/Admin can invite; only the Owner can invite Admins/Owners', async () => {
    expect(
      await code(
        members.inviteMember(a.exec1!.ctx, a.exec1!.headers, {
          email: email('x'),
          role: 'sales_executive',
        }),
      ),
    ).toBe('FORBIDDEN');
    expect(
      await code(
        members.inviteMember(a.hr!.ctx, a.hr!.headers, {
          email: email('x'),
          role: 'sales_executive',
        }),
      ),
    ).toBe('FORBIDDEN');
    expect(
      await code(
        members.inviteMember(a.admin!.ctx, a.admin!.headers, { email: email('x'), role: 'admin' }),
      ),
    ).toBe('FORBIDDEN');
    expect(
      await code(
        members.inviteMember(a.owner!.ctx, a.owner!.headers, {
          email: email('adm'),
          role: 'admin',
        }),
      ),
    ).toBe('OK');
  });

  it('expiry is 7 days, ids are fully random (UUIDv4), and invitation.created is audited', async () => {
    const { id } = await members.inviteMember(a.admin!.ctx, a.admin!.headers, {
      email: email('ttl'),
      role: 'sales_executive',
    });
    expect(id).toMatch(/^[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/); // random v4 (D3)
    const inv = await migrator().invitation.findUniqueOrThrow({ where: { id } });
    expect(Math.abs((inv.expiresAt.getTime() - Date.now()) / 1000 - 7 * 86400)).toBeLessThan(60);
    expect(
      await migrator().auditLog.count({ where: { entityId: id, action: 'invitation.created' } }),
    ).toBe(1);
  });

  it('acceptance requires the matching, verified, signed-in user; joins the invited team', async () => {
    const team = await migrator().team.create({ data: { orgId: org.orgId, name: 'Baner' } });
    const inviteeEmail = email('invitee');
    const { id } = await members.inviteMember(a.owner!.ctx, a.owner!.headers, {
      email: inviteeEmail,
      role: 'sales_executive',
      teamId: team.id,
    });

    // Another verified user cannot accept it.
    const other = await createUser('other');
    await expect(
      auth().api.acceptInvitation({ headers: await signIn(other), body: { invitationId: id } }),
    ).rejects.toThrow(/recipient/);

    // The invitee can sign up (invitation exists) but must verify before accepting.
    const res = await auth().api.signUpEmail({
      body: { email: inviteeEmail, password: PASSWORD, name: 'Invitee' },
    });
    await migrator().user.update({ where: { id: res.user.id }, data: { emailVerified: true } });
    const h = await signIn({ email: inviteeEmail });
    await migrator().user.update({ where: { id: res.user.id }, data: { emailVerified: false } });
    await expect(
      auth().api.acceptInvitation({ headers: h, body: { invitationId: id } }),
    ).rejects.toThrow(/verif/i);
    await migrator().user.update({ where: { id: res.user.id }, data: { emailVerified: true } });

    await auth().api.acceptInvitation({ headers: h, body: { invitationId: id } });
    const m = await migrator().member.findFirstOrThrow({
      where: { organizationId: org.orgId, userId: res.user.id },
    });
    expect(m).toMatchObject({ role: 'sales_executive', status: 'ACTIVE' });
    expect(
      await migrator().teamMembership.count({
        where: { membershipId: m.id, teamId: team.id, endedAt: null },
      }),
    ).toBe(1);
    expect(
      await migrator().auditLog.count({
        where: { entityId: id, action: 'invitation.accepted', actorUserId: res.user.id },
      }),
    ).toBe(1);

    // Already accepted: cannot be accepted or cancelled again.
    await expect(
      auth().api.acceptInvitation({ headers: h, body: { invitationId: id } }),
    ).rejects.toThrow();
    expect(await code(members.cancelInvitation(a.owner!.ctx, a.owner!.headers, id))).toBe(
      'RULE_VIOLATION',
    );
  });

  it('expired invitations cannot be accepted', async () => {
    const u = await createUser('late');
    const { id } = await members.inviteMember(a.owner!.ctx, a.owner!.headers, {
      email: u.email,
      role: 'sales_executive',
    });
    await migrator().invitation.update({
      where: { id },
      data: { expiresAt: new Date(Date.now() - 1000) },
    });
    await expect(
      auth().api.acceptInvitation({ headers: await signIn(u), body: { invitationId: id } }),
    ).rejects.toThrow();
  });

  it('cancellation works and is audited; a cancelled invitation cannot be accepted', async () => {
    const u = await createUser('cancelled');
    const { id } = await members.inviteMember(a.admin!.ctx, a.admin!.headers, {
      email: u.email,
      role: 'sales_executive',
    });
    await members.cancelInvitation(a.admin!.ctx, a.admin!.headers, id);
    expect((await migrator().invitation.findUniqueOrThrow({ where: { id } })).status).toBe(
      'canceled',
    );
    await expect(
      auth().api.acceptInvitation({ headers: await signIn(u), body: { invitationId: id } }),
    ).rejects.toThrow();
    expect(
      await migrator().auditLog.count({ where: { entityId: id, action: 'invitation.canceled' } }),
    ).toBe(1);
  });

  it('sign-up without a pending invitation creates nothing (closed sign-up)', async () => {
    // The library answers with an indistinguishable response (no account enumeration),
    // so the assertion is on what exists afterwards.
    const e = email('stranger');
    const res = await auth().api.signUpEmail({
      body: { email: e, password: PASSWORD, name: 'Stranger' },
    });
    expect(res.token).toBeNull();
    expect(await migrator().user.count({ where: { email: e } })).toBe(0);
    await expect(signIn({ email: e })).rejects.toThrow();
  });

  it('invitation creation is rate-limited per user (30/hour)', async () => {
    const fresh = await seedOrg('RateLimit');
    const owner = await actorIn(fresh.users.owner, fresh.orgId);
    const results: string[] = [];
    for (let i = 0; i < 31; i++) {
      results.push(
        await code(
          members.inviteMember(owner.ctx, owner.headers, {
            email: email(`rl${i}`),
            role: 'sales_executive',
          }),
        ),
      );
    }
    expect(results.slice(0, 30).every((r) => r === 'OK')).toBe(true);
    expect(results[30]).toBe('RATE_LIMITED');
  });
});

describe('roles and status (owner-only rules)', () => {
  it('Admin cannot change, suspend or deactivate Owners/Admins; Owner can', async () => {
    expect(
      await code(
        members.changeRole(a.admin!.ctx, a.admin!.headers, org.membership.owner!, 'sales_manager'),
      ),
    ).toBe('FORBIDDEN');
    expect(await code(members.suspendMember(a.admin!.ctx, org.membership.owner!))).toBe(
      'FORBIDDEN',
    );
    const admin2 = await createUser('admin2');
    const admin2Membership = await (
      await import('../support/factory')
    ).addMember(org.orgId, admin2, 'admin');
    expect(
      await code(
        members.changeRole(a.admin!.ctx, a.admin!.headers, admin2Membership, 'sales_executive'),
      ),
    ).toBe('FORBIDDEN');
    expect(await code(members.deactivateMember(a.admin!.ctx, admin2Membership))).toBe('FORBIDDEN');
    expect(
      await code(
        members.changeRole(a.admin!.ctx, a.admin!.headers, org.membership.exec2!, 'admin'),
      ),
    ).toBe('FORBIDDEN');
    expect(
      await code(
        members.changeRole(a.owner!.ctx, a.owner!.headers, admin2Membership, 'sales_manager'),
      ),
    ).toBe('OK');
  });

  it('role change is audited and emits an outbox event', async () => {
    await members.changeRole(
      a.admin!.ctx,
      a.admin!.headers,
      org.membership.exec2!,
      'sales_manager',
    );
    expect(
      (await migrator().member.findUniqueOrThrow({ where: { id: org.membership.exec2! } })).role,
    ).toBe('sales_manager');
    expect(
      await migrator().auditLog.count({
        where: { entityId: org.membership.exec2!, action: 'membership.role_changed' },
      }),
    ).toBe(1);
    expect(
      await migrator().outboxEvent.count({
        where: { orgId: org.orgId, type: 'membership.role_changed' },
      }),
    ).toBeGreaterThan(0);
  });

  it('suspension revokes sessions immediately, blocks the org, and can be reversed', async () => {
    const execH = await signIn(org.users.exec1);
    await auth().api.setActiveOrganization({ headers: execH, body: { organizationId: org.orgId } });
    await members.suspendMember(a.admin!.ctx, org.membership.exec1!);
    expect(await auth().api.getSession({ headers: execH })).toBeNull();
    const again = await signIn(org.users.exec1);
    await migrator().session.updateMany({
      where: { userId: org.users.exec1.id },
      data: { activeOrganizationId: org.orgId },
    });
    expect((await resolveRequestContext(again)).ok).toBe(false);
    expect(
      await migrator().outboxEvent.count({
        where: {
          type: 'membership.suspended',
          payload: { path: ['userId'], equals: org.users.exec1.id },
        },
      }),
    ).toBe(1);
    await members.reactivateMember(a.admin!.ctx, org.membership.exec1!);
    expect((await resolveRequestContext(again)).ok).toBe(true);
  });

  it('nobody can suspend themselves; the last active Owner cannot be removed', async () => {
    expect(await code(members.suspendMember(a.admin!.ctx, org.membership.admin!))).toBe(
      'RULE_VIOLATION',
    );
    const solo = await seedOrg('Solo');
    const owner = await actorIn(solo.users.owner, solo.orgId);
    expect(await code(members.deactivateMember(owner.ctx, solo.membership.owner!))).toBe(
      'RULE_VIOLATION',
    );
  });

  it('deactivation ends team spells and keeps the membership row (history)', async () => {
    const team = await migrator().team.create({ data: { orgId: org.orgId, name: 'Kharadi' } });
    await migrator().teamMembership.create({
      data: { orgId: org.orgId, teamId: team.id, membershipId: org.membership.hr! },
    });
    await members.deactivateMember(a.owner!.ctx, org.membership.hr!);
    const m = await migrator().member.findUniqueOrThrow({ where: { id: org.membership.hr! } });
    expect(m.status).toBe('DEACTIVATED');
    expect(
      await migrator().teamMembership.count({ where: { membershipId: m.id, endedAt: null } }),
    ).toBe(0);
    await members.reactivateMember(a.owner!.ctx, org.membership.hr!);
  });

  it('HR can update HR profile fields; executives cannot', async () => {
    const hr = await actorIn(org.users.hr, org.orgId);
    await members.updateHrProfile(hr.ctx, org.membership.exec2!, {
      employeeCode: 'E-042',
      designation: 'Senior Executive',
    });
    expect(
      (await migrator().member.findUniqueOrThrow({ where: { id: org.membership.exec2! } }))
        .employeeCode,
    ).toBe('E-042');
    const exec = await actorIn(org.users.exec1, org.orgId);
    expect(
      await code(members.updateHrProfile(exec.ctx, org.membership.exec2!, { employeeCode: 'X' })),
    ).toBe('FORBIDDEN');
  });
});
