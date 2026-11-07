// S2-07 plugin/auth tables under RLS; S2-08 platform admin + support grants.
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { approveSupportGrant, createLead, Forbidden, listLeads } from '../harness/commands';
import { resolveRequestContext } from '../harness/request-context';
import { createOrg, createVerifiedUser, setup, signIn, type Env } from './helpers';

let env: Env;
beforeAll(() => {
  env = setup();
});
afterAll(() => env.close());

const deps = () => ({ auth: env.auth, runner: env.runner, platform: env.platform });

describe('S2-07 tables under RLS', () => {
  it('every table is RLS enabled + forced (auth, plugin and ours)', async () => {
    const off = await env.migrator.prisma.$queryRaw<{ t: string }[]>`
      SELECT relname AS t FROM pg_class
      WHERE relnamespace = 'public'::regnamespace AND relkind = 'r' AND relname <> '_prisma_migrations'
        AND NOT (relrowsecurity AND relforcerowsecurity)`;
    expect(off).toEqual([]);
  });

  it('plugin org-owned tables carry org_id and a crm_app tenant policy', async () => {
    const rows = await env.migrator.prisma.$queryRaw<{ t: string }[]>`
      SELECT tablename AS t FROM pg_policies
      WHERE schemaname = 'public' AND policyname = 'tenant_isolation' AND 'crm_app' = ANY (roles)
        AND tablename IN ('organization_membership', 'invitation') ORDER BY 1`;
    expect(rows.map((r) => r.t)).toEqual(['invitation', 'organization_membership']);
  });

  it('crm_app cannot touch credential/session tables at all', async () => {
    const [p] = await env.migrator.prisma.$queryRaw<Record<string, boolean>[]>`
      SELECT has_table_privilege('crm_app', 'session', 'SELECT') AS session,
             has_table_privilege('crm_app', 'account', 'SELECT') AS account,
             has_table_privilege('crm_app', 'verification', 'SELECT') AS verification,
             has_table_privilege('crm_app', 'two_factor', 'SELECT') AS two_factor,
             has_table_privilege('crm_app', 'organization_membership', 'INSERT') AS member_insert,
             has_table_privilege('crm_app', 'invitation', 'INSERT') AS invitation_insert`;
    expect(Object.values(p!).every((v) => v === false)).toBe(true);
  });

  it('crm_auth (the library) has no access to business tables', async () => {
    const [p] = await env.migrator.prisma.$queryRaw<Record<string, boolean>[]>`
      SELECT has_table_privilege('crm_auth', 'lead', 'SELECT') AS lead,
             has_table_privilege('crm_auth', 'team', 'SELECT') AS team,
             has_table_privilege('crm_auth', 'team_membership', 'SELECT') AS team_membership,
             has_table_privilege('crm_auth', 'audit_log', 'SELECT') AS audit_log,
             has_table_privilege('crm_auth', 'support_access_grant', 'SELECT') AS grants`;
    expect(Object.values(p!).every((v) => v === false)).toBe(true);
  });

  it('memberships and invitations: crm_app sees only the current org; none without context', async () => {
    const o1 = await createVerifiedUser(env, 'o1');
    const o2 = await createVerifiedUser(env, 'o2');
    const org1 = await createOrg(env, o1.id, 'One');
    const org2 = await createOrg(env, o2.id, 'Two');
    const h1 = await signIn(env, o1.email);
    await env.auth.api.setActiveOrganization({ headers: h1, body: { organizationId: org1 } });
    await env.auth.api.createInvitation({
      headers: h1,
      body: { email: 'x1@example.test', role: 'sales_executive', organizationId: org1 },
    });
    const h2 = await signIn(env, o2.email);
    await env.auth.api.setActiveOrganization({ headers: h2, body: { organizationId: org2 } });
    await env.auth.api.createInvitation({
      headers: h2,
      body: { email: 'x2@example.test', role: 'sales_executive', organizationId: org2 },
    });

    const seen = await env.runner.withTenant({ orgId: org1, userId: o1.id }, async (tx) => ({
      members: await tx.member.findMany({ select: { organizationId: true } }),
      invitations: await tx.invitation.findMany({ select: { organizationId: true } }),
    }));
    expect(seen.members.length).toBeGreaterThan(0);
    expect(seen.invitations.length).toBeGreaterThan(0);
    expect([...seen.members, ...seen.invitations].every((r) => r.organizationId === org1)).toBe(
      true,
    );

    const none = await env.runner.withUser(o1.id, async (tx) => ({
      members: await tx.member.count(),
      invitations: await tx.invitation.count(),
    }));
    expect(none).toEqual({ members: 0, invitations: 0 });
  });
});

describe('S2-08 platform admin and support grants', () => {
  let orgA: string;
  let orgB: string;
  let ownerH: Headers;
  let adminH: Headers;
  let staff: { id: string; email: string };
  let staffH: Headers;

  beforeAll(async () => {
    const owner = await createVerifiedUser(env, 'owner');
    const admin = await createVerifiedUser(env, 'admin');
    const ownerB = await createVerifiedUser(env, 'ownerB');
    orgA = await createOrg(env, owner.id, 'Support A');
    orgB = await createOrg(env, ownerB.id, 'Support B');
    await env.auth.api.addMember({
      body: { userId: admin.id, organizationId: orgA, role: 'admin' },
    });
    await env.migrator.prisma.lead.createMany({
      data: [
        { orgId: orgA, fullName: 'A lead' },
        { orgId: orgB, fullName: 'B lead' },
      ],
    });
    ownerH = await signIn(env, owner.email);
    await env.auth.api.setActiveOrganization({ headers: ownerH, body: { organizationId: orgA } });
    adminH = await signIn(env, admin.email);
    await env.auth.api.setActiveOrganization({ headers: adminH, body: { organizationId: orgA } });
    staff = await createVerifiedUser(env, 'staff', 'PLATFORM_ADMIN');
    staffH = await signIn(env, staff.email);
  });

  // Stand-in for the platform console's "open org for support" action.
  const openOrg = (orgId: string) =>
    env.migrator.prisma.session.updateMany({
      where: { userId: staff.id },
      data: { activeOrganizationId: orgId },
    });

  async function requestGrant(orgId: string, level: 'READ' | 'WRITE' = 'READ', hours = 2) {
    const now = Date.now();
    return env.platform.prisma.supportAccessGrant.create({
      data: {
        orgId,
        platformUserId: staff.id,
        reason: 'Pilot support ticket #1',
        accessLevel: level,
        startsAt: new Date(now - 1000),
        expiresAt: new Date(now + hours * 3_600_000),
      },
    });
  }

  it('platform admin has no membership and is denied tenant data', async () => {
    await expect(
      env.auth.api.setActiveOrganization({ headers: staffH, body: { organizationId: orgA } }),
    ).rejects.toThrow(/not a member/);
    await openOrg(orgA);
    expect(await resolveRequestContext(deps(), staffH)).toEqual({
      ok: false,
      reason: 'NOT_A_MEMBER',
    });
  });

  it('a requested but unapproved grant gives no access; only the Owner can approve', async () => {
    const g = await requestGrant(orgA);
    expect(await resolveRequestContext(deps(), staffH)).toEqual({
      ok: false,
      reason: 'NOT_A_MEMBER',
    });
    const adminCtx = await resolveRequestContext(deps(), adminH);
    if (!adminCtx.ok) throw new Error(adminCtx.reason);
    await expect(approveSupportGrant(env.runner, adminCtx.ctx, g.id)).rejects.toBeInstanceOf(
      Forbidden,
    );
    const ownerCtx = await resolveRequestContext(deps(), ownerH);
    if (!ownerCtx.ok) throw new Error(ownerCtx.reason);
    await approveSupportGrant(env.runner, ownerCtx.ctx, g.id);
  });

  it('an approved READ grant gives time-boxed, read-only, audited access to that org only', async () => {
    const r = await resolveRequestContext(deps(), staffH);
    if (!r.ok) throw new Error(r.reason);
    expect(r.ctx).toMatchObject({ kind: 'support', orgId: orgA, accessLevel: 'READ' });
    expect((await listLeads(env.runner, r.ctx)).map((l) => l.fullName)).toEqual(['A lead']);
    await expect(createLead(env.runner, r.ctx, 'support wrote this')).rejects.toThrow(/read-only/);

    const orgAudit = await env.migrator.prisma.auditLog.findMany({
      where: { orgId: orgA },
      select: { action: true },
    });
    expect(orgAudit.map((a) => a.action)).toEqual(
      expect.arrayContaining(['support_access.approved', 'support_access.used']),
    );
    const platformAudit = await env.migrator.prisma.auditLog.findMany({
      where: { orgId: null, actorUserId: staff.id, action: 'support_access.used' },
    });
    expect(platformAudit.length).toBeGreaterThan(0);

    await openOrg(orgB);
    expect(await resolveRequestContext(deps(), staffH)).toEqual({
      ok: false,
      reason: 'NOT_A_MEMBER',
    });
    await openOrg(orgA);
  });

  it('expired or revoked grants stop working; grants longer than 72 h are refused', async () => {
    await env.migrator.prisma.supportAccessGrant.updateMany({
      where: { orgId: orgA, platformUserId: staff.id },
      data: {
        startsAt: new Date(Date.now() - 3 * 3_600_000),
        expiresAt: new Date(Date.now() - 1000),
      },
    });
    expect((await resolveRequestContext(deps(), staffH)).ok).toBe(false);

    const g = await requestGrant(orgA);
    const ownerCtx = await resolveRequestContext(deps(), ownerH);
    if (!ownerCtx.ok) throw new Error(ownerCtx.reason);
    await approveSupportGrant(env.runner, ownerCtx.ctx, g.id);
    expect((await resolveRequestContext(deps(), staffH)).ok).toBe(true);
    await env.runner.withTenant(ownerCtx.ctx.tenant, (tx) =>
      tx.supportAccessGrant.update({ where: { id: g.id }, data: { revokedAt: new Date() } }),
    );
    expect((await resolveRequestContext(deps(), staffH)).ok).toBe(false);

    await expect(requestGrant(orgA, 'READ', 73)).rejects.toThrow(/support_access_grant_window/);
  });
});
