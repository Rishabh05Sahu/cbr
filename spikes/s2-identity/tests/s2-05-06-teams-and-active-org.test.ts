// S2-05 teams from our table only; S2-06 active org drives withTenant context.
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { ledTeamIds, listLeads } from '../harness/commands';
import { resolveRequestContext } from '../harness/request-context';
import { createOrg, createVerifiedUser, setup, signIn, type Env } from './helpers';

let env: Env;
beforeAll(() => {
  env = setup();
});
afterAll(() => env.close());

const deps = () => ({ auth: env.auth, runner: env.runner, platform: env.platform });

describe('S2-05 teams', () => {
  it('the plugin exposes no team endpoints and created no team tables', async () => {
    const api = env.auth.api as Record<string, unknown>;
    for (const name of ['createTeam', 'listTeams', 'addTeamMember', 'setActiveTeam']) {
      expect(api[name], name).toBeUndefined();
    }
    const tables = await env.migrator.prisma.$queryRaw<{ t: string }[]>`
      SELECT relname AS t FROM pg_class WHERE relnamespace = 'public'::regnamespace AND relkind = 'r'
        AND relname IN ('team_member', 'teamMember', 'organization_role')`;
    expect(tables).toEqual([]);
  });

  it('team-lead scope comes from our team_membership.team_role', async () => {
    const owner = await createVerifiedUser(env, 'owner');
    const mgr = await createVerifiedUser(env, 'mgr');
    const orgId = await createOrg(env, owner.id, 'Teams Co');
    const m = await env.auth.api.addMember({
      body: { userId: mgr.id, organizationId: orgId, role: 'sales_manager' },
    });
    const { north, south } = await env.runner.withTenant(
      { orgId, userId: owner.id },
      async (tx) => {
        const north = await tx.team.create({ data: { orgId, name: 'North' } });
        const south = await tx.team.create({ data: { orgId, name: 'South' } });
        await tx.teamMembership.create({
          data: { orgId, teamId: north.id, membershipId: m!.id, teamRole: 'LEAD' },
        });
        await tx.teamMembership.create({
          data: { orgId, teamId: south.id, membershipId: m!.id, teamRole: 'MEMBER' },
        });
        return { north: north.id, south: south.id };
      },
    );
    const h = await signIn(env, mgr.email);
    await env.auth.api.setActiveOrganization({ headers: h, body: { organizationId: orgId } });
    const r = await resolveRequestContext(deps(), h);
    if (!r.ok) throw new Error(r.reason);
    expect(await ledTeamIds(env.runner, r.ctx)).toEqual([north]);
    expect(await ledTeamIds(env.runner, r.ctx)).not.toContain(south);

    await env.migrator.prisma.teamMembership.updateMany({
      where: { teamId: north, membershipId: m!.id },
      data: { endedAt: new Date() },
    });
    expect(await ledTeamIds(env.runner, r.ctx)).toEqual([]);
  });
});

describe('S2-06 active organisation', () => {
  it('switching the active org switches tenant context; nothing from the previous org appears', async () => {
    const ownerA = await createVerifiedUser(env, 'ownerA');
    const ownerB = await createVerifiedUser(env, 'ownerB');
    const user = await createVerifiedUser(env, 'both');
    const orgA = await createOrg(env, ownerA.id, 'Alpha Realty');
    const orgB = await createOrg(env, ownerB.id, 'Bravo Realty');
    await env.auth.api.addMember({
      body: { userId: user.id, organizationId: orgA, role: 'sales_executive' },
    });
    await env.auth.api.addMember({
      body: { userId: user.id, organizationId: orgB, role: 'admin' },
    });
    await env.migrator.prisma.lead.createMany({
      data: [
        { orgId: orgA, fullName: 'A1' },
        { orgId: orgA, fullName: 'A2' },
        { orgId: orgB, fullName: 'B1' },
      ],
    });

    const h = await signIn(env, user.email);
    expect(await resolveRequestContext(deps(), h)).toEqual({ ok: false, reason: 'NO_ACTIVE_ORG' });

    await env.auth.api.setActiveOrganization({ headers: h, body: { organizationId: orgA } });
    const a = await resolveRequestContext(deps(), h);
    if (!a.ok) throw new Error(a.reason);
    expect(a.ctx).toMatchObject({ kind: 'member', orgId: orgA, role: 'SALES_EXECUTIVE' });
    expect((await listLeads(env.runner, a.ctx)).map((l) => l.fullName).sort()).toEqual([
      'A1',
      'A2',
    ]);

    await env.auth.api.setActiveOrganization({ headers: h, body: { organizationId: orgB } });
    const b = await resolveRequestContext(deps(), h);
    if (!b.ok) throw new Error(b.reason);
    expect(b.ctx).toMatchObject({ kind: 'member', orgId: orgB, role: 'ADMIN' });
    const bLeads = await listLeads(env.runner, b.ctx);
    expect(bLeads.map((l) => l.fullName)).toEqual(['B1']);
    expect(bLeads.every((l) => l.orgId === orgB)).toBe(true);
  });

  it('cannot activate an org without membership; a forged active org is refused', async () => {
    const owner = await createVerifiedUser(env, 'ownerC');
    const outsider = await createVerifiedUser(env, 'outsider');
    const orgC = await createOrg(env, owner.id, 'Charlie Realty');
    const h = await signIn(env, outsider.email);
    await expect(
      env.auth.api.setActiveOrganization({ headers: h, body: { organizationId: orgC } }),
    ).rejects.toThrow(/not a member/);

    await env.migrator.prisma.session.updateMany({
      where: { userId: outsider.id },
      data: { activeOrganizationId: orgC },
    });
    expect(await resolveRequestContext(deps(), h)).toEqual({ ok: false, reason: 'NOT_A_MEMBER' });
  });

  it('removal from the active org takes effect on the next request', async () => {
    const owner = await createVerifiedUser(env, 'ownerD');
    const exec = await createVerifiedUser(env, 'leaver');
    const orgD = await createOrg(env, owner.id, 'Delta Realty');
    const m = await env.auth.api.addMember({
      body: { userId: exec.id, organizationId: orgD, role: 'sales_executive' },
    });
    const h = await signIn(env, exec.email);
    await env.auth.api.setActiveOrganization({ headers: h, body: { organizationId: orgD } });
    expect((await resolveRequestContext(deps(), h)).ok).toBe(true);
    const ownerH = await signIn(env, owner.email);
    await env.auth.api.setActiveOrganization({ headers: ownerH, body: { organizationId: orgD } });
    await env.auth.api.removeMember({
      headers: ownerH,
      body: { memberIdOrEmail: m!.id, organizationId: orgD },
    });
    const after = await resolveRequestContext(deps(), h);
    expect(after.ok).toBe(false);
  });
});
