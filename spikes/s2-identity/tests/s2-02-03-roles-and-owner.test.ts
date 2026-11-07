// S2-02 role mapping + single role; S2-03 owner invariants.
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { Forbidden, suspendMember } from '../harness/commands';
import { resolveRequestContext } from '../harness/request-context';
import { createOrg, createVerifiedUser, setup, signIn, type Env } from './helpers';

let env: Env;
let orgId: string;
const u: Record<string, { id: string; email: string }> = {};
const h: Record<string, Headers> = {};
const memberId: Record<string, string> = {};

beforeAll(async () => {
  env = setup();
  for (const k of ['owner', 'admin', 'admin2', 'manager', 'exec', 'hr', 'extra']) {
    u[k] = await createVerifiedUser(env, k);
  }
  orgId = await createOrg(env, u.owner!.id, 'Roles Co');
  const roleOf = {
    admin: 'admin',
    admin2: 'admin',
    manager: 'sales_manager',
    exec: 'sales_executive',
    hr: 'hr_ops',
  } as const;
  for (const [k, role] of Object.entries(roleOf)) {
    const m = await env.auth.api.addMember({
      body: { userId: u[k]!.id, organizationId: orgId, role },
    });
    memberId[k] = m!.id;
  }
  for (const k of ['owner', 'admin', 'manager', 'exec', 'hr']) {
    h[k] = await signIn(env, u[k]!.email);
    await env.auth.api.setActiveOrganization({ headers: h[k]!, body: { organizationId: orgId } });
  }
  const ownerMember = await env.migrator.prisma.member.findFirst({
    where: { organizationId: orgId, userId: u.owner!.id },
  });
  memberId.owner = ownerMember!.id;
});
afterAll(() => env.close());

const deps = () => ({ auth: env.auth, runner: env.runner, platform: env.platform });

describe('S2-02 role mapping', () => {
  it('org creator is the plugin owner; roles map to our role codes', async () => {
    const expected = {
      owner: 'OWNER',
      admin: 'ADMIN',
      manager: 'SALES_MANAGER',
      exec: 'SALES_EXECUTIVE',
      hr: 'HR_OPS',
    };
    for (const [k, code] of Object.entries(expected)) {
      const r = await resolveRequestContext(deps(), h[k]!);
      expect(r.ok && r.ctx.kind === 'member' && r.ctx.role, k).toBe(code);
    }
  });

  it.each([
    ['array', ['admin', 'sales_manager']],
    ['comma list', 'admin,sales_manager'],
    ['unknown role', 'superuser'],
  ])('addMember with %s is rejected', async (_label, role) => {
    await expect(
      env.auth.api.addMember({
        body: { userId: u.extra!.id, organizationId: orgId, role: role as 'admin' },
      }),
    ).rejects.toThrow(/exactly one known role/);
    expect(await env.migrator.prisma.member.count({ where: { userId: u.extra!.id } })).toBe(0);
  });

  it('updateMemberRole to multiple roles is rejected (even by the owner)', async () => {
    await expect(
      env.auth.api.updateMemberRole({
        headers: h.owner!,
        body: {
          memberId: memberId.exec!,
          role: ['sales_executive', 'sales_manager'] as unknown as 'admin',
        },
      }),
    ).rejects.toThrow(/exactly one known role/);
    await expect(
      env.auth.api.updateMemberRole({
        headers: h.owner!,
        body: { memberId: memberId.exec!, role: 'sales_executive,hr_ops' as 'admin' },
      }),
    ).rejects.toThrow(/exactly one known role/);
    const m = await env.migrator.prisma.member.findUnique({ where: { id: memberId.exec! } });
    expect(m?.role).toBe('sales_executive');
  });

  it('invitations with multiple roles are rejected', async () => {
    await expect(
      env.auth.api.createInvitation({
        headers: h.owner!,
        body: {
          email: 'multi@example.test',
          role: 'sales_executive,admin' as 'admin',
          organizationId: orgId,
        },
      }),
    ).rejects.toThrow(/exactly one known role/);
  });

  it('the database rejects multi-role values even if the library is bypassed', async () => {
    await expect(
      env.migrator.prisma.member.update({
        where: { id: memberId.exec! },
        data: { role: 'admin,owner' },
      }),
    ).rejects.toThrow(/organization_membership_single_role/);
  });
});

describe('S2-03 owner invariants', () => {
  it('the last Owner cannot leave', async () => {
    await expect(
      env.auth.api.leaveOrganization({ headers: h.owner!, body: { organizationId: orgId } }),
    ).rejects.toThrow(/only owner/);
  });

  it('the last Owner cannot demote themselves', async () => {
    await expect(
      env.auth.api.updateMemberRole({
        headers: h.owner!,
        body: { memberId: memberId.owner!, role: 'admin' },
      }),
    ).rejects.toThrow(/without an owner/);
  });

  it('an Admin cannot demote or remove the Owner', async () => {
    await expect(
      env.auth.api.updateMemberRole({
        headers: h.admin!,
        body: { memberId: memberId.owner!, role: 'sales_manager' },
      }),
    ).rejects.toThrow(/Only an Owner/);
    await expect(
      env.auth.api.removeMember({
        headers: h.admin!,
        body: { memberIdOrEmail: memberId.owner!, organizationId: orgId },
      }),
    ).rejects.toThrow(/Only an Owner|only owner/);
  });

  it('an Admin cannot grant Owner or Admin (role change or invitation)', async () => {
    for (const role of ['owner', 'admin'] as const) {
      await expect(
        env.auth.api.updateMemberRole({
          headers: h.admin!,
          body: { memberId: memberId.exec!, role },
        }),
      ).rejects.toThrow(/Only an Owner/);
      await expect(
        env.auth.api.createInvitation({
          headers: h.admin!,
          body: { email: `grant-${role}@example.test`, role, organizationId: orgId },
        }),
      ).rejects.toThrow(/Only an Owner/);
    }
    const m = await env.migrator.prisma.member.findUnique({ where: { id: memberId.exec! } });
    expect(m?.role).toBe('sales_executive');
  });

  it('an Admin cannot demote, remove or suspend another Admin', async () => {
    await expect(
      env.auth.api.updateMemberRole({
        headers: h.admin!,
        body: { memberId: memberId.admin2!, role: 'sales_executive' },
      }),
    ).rejects.toThrow(/Only an Owner/);
    await expect(
      env.auth.api.removeMember({
        headers: h.admin!,
        body: { memberIdOrEmail: memberId.admin2!, organizationId: orgId },
      }),
    ).rejects.toThrow(/Only an Owner/);
    await expect(
      env.auth.api.removeMember({
        headers: h.admin!,
        body: { memberIdOrEmail: u.admin2!.email, organizationId: orgId },
      }),
    ).rejects.toThrow(/Only an Owner/);
    const adminCtx = await resolveRequestContext(deps(), h.admin!);
    if (!adminCtx.ok) throw new Error(adminCtx.reason);
    await expect(
      suspendMember({ auth: env.auth, runner: env.runner }, adminCtx.ctx, memberId.admin2!),
    ).rejects.toBeInstanceOf(Forbidden);
    const m = await env.migrator.prisma.member.findUnique({ where: { id: memberId.admin2! } });
    expect(m).toMatchObject({ role: 'admin', status: 'ACTIVE' });
  });

  it('an Admin can remove a non-admin member', async () => {
    const extra = await env.auth.api.addMember({
      body: { userId: u.extra!.id, organizationId: orgId, role: 'sales_executive' },
    });
    await env.auth.api.removeMember({
      headers: h.admin!,
      body: { memberIdOrEmail: extra!.id, organizationId: orgId },
    });
    expect(await env.migrator.prisma.member.count({ where: { id: extra!.id } })).toBe(0);
  });

  it('an Admin can assign non-admin roles', async () => {
    await env.auth.api.updateMemberRole({
      headers: h.admin!,
      body: { memberId: memberId.hr!, role: 'sales_executive' },
    });
    await env.auth.api.updateMemberRole({
      headers: h.admin!,
      body: { memberId: memberId.hr!, role: 'hr_ops' },
    });
    const m = await env.migrator.prisma.member.findUnique({ where: { id: memberId.hr! } });
    expect(m?.role).toBe('hr_ops');
  });

  it('non-admin roles cannot change roles at all', async () => {
    for (const k of ['manager', 'exec', 'hr']) {
      await expect(
        env.auth.api.updateMemberRole({
          headers: h[k]!,
          body: { memberId: memberId.exec!, role: 'sales_manager' },
        }),
      ).rejects.toThrow(/not allowed to update this member/);
    }
  });

  it('only the Owner can delete the organization', async () => {
    await expect(
      env.auth.api.deleteOrganization({ headers: h.admin!, body: { organizationId: orgId } }),
    ).rejects.toThrow(/not allowed to delete this organization/);
    // Owner deletion tested on a throwaway org.
    const owner2 = await createVerifiedUser(env, 'owner2');
    const throwaway = await createOrg(env, owner2.id, 'Throwaway');
    const h2 = await signIn(env, owner2.email);
    await env.auth.api.deleteOrganization({ headers: h2, body: { organizationId: throwaway } });
    expect(
      await env.migrator.prisma.organization.findUnique({ where: { id: throwaway } }),
    ).toBeNull();
  });

  it('the Owner can grant Admin; with two Owners one may step down', async () => {
    await env.auth.api.updateMemberRole({
      headers: h.owner!,
      body: { memberId: memberId.manager!, role: 'admin' },
    });
    await env.auth.api.updateMemberRole({
      headers: h.owner!,
      body: { memberId: memberId.admin!, role: 'owner' },
    });
    await env.auth.api.updateMemberRole({
      headers: h.owner!,
      body: { memberId: memberId.owner!, role: 'admin' },
    });
    const roles = await env.migrator.prisma.member.findMany({
      where: { organizationId: orgId },
      select: { userId: true, role: true },
    });
    expect(roles.filter((r) => r.role === 'owner')).toHaveLength(1);
  });

  it('a signed-in user cannot create organizations (self-service is off for the pilot)', async () => {
    await expect(
      env.auth.api.createOrganization({
        headers: h.exec!,
        body: { name: 'Mine', slug: `mine-${Date.now()}` },
      }),
    ).rejects.toThrow(/not allowed to create a new organization/);
  });
});
