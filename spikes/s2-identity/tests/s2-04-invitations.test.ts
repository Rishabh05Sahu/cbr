// S2-04 invitations: 7-day expiry, email must match (and be verified), acceptance creates
// a membership with our role and, optionally, our team membership.
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { INVITATION_TTL_SECONDS } from '../auth/auth';
import {
  PASSWORD,
  createOrg,
  createVerifiedUser,
  setup,
  signIn,
  uniqueEmail,
  type Env,
} from './helpers';

let env: Env;
let orgId: string;
let ownerH: Headers;
let teamId: string;

beforeAll(async () => {
  env = setup();
  const owner = await createVerifiedUser(env, 'owner');
  orgId = await createOrg(env, owner.id, 'Invite Co');
  ownerH = await signIn(env, owner.email);
  await env.auth.api.setActiveOrganization({ headers: ownerH, body: { organizationId: orgId } });
  const team = await env.runner.withTenant({ orgId, userId: owner.id }, (tx) =>
    tx.team.create({ data: { orgId, name: 'Baner' } }),
  );
  teamId = team.id;
});
afterAll(() => env.close());

async function invite(email: string, extra: Record<string, unknown> = {}) {
  const inv = await env.auth.api.createInvitation({
    headers: ownerH,
    body: { email, role: 'sales_executive', organizationId: orgId, ...extra } as {
      email: string;
      role: 'sales_executive';
      organizationId: string;
    },
  });
  return inv!;
}

describe('S2-04 invitations', () => {
  it('expire after 7 days', async () => {
    const inv = await invite(uniqueEmail('ttl'));
    const row = await env.migrator.prisma.invitation.findUnique({ where: { id: inv.id } });
    const ttl = (row!.expiresAt.getTime() - Date.now()) / 1000;
    expect(Math.abs(ttl - INVITATION_TTL_SECONDS)).toBeLessThan(60);
  });

  it('cannot be accepted by a different (even verified) user', async () => {
    const inv = await invite(uniqueEmail('intended'));
    const other = await createVerifiedUser(env, 'other');
    const otherH = await signIn(env, other.email);
    await expect(
      env.auth.api.acceptInvitation({ headers: otherH, body: { invitationId: inv.id } }),
    ).rejects.toThrow(/not the recipient/);
    expect(await env.migrator.prisma.member.count({ where: { userId: other.id } })).toBe(0);
  });

  it('requires a verified email for the matching user; then creates membership + team membership', async () => {
    const email = uniqueEmail('invitee');
    const inv = await invite(email, { teamId });
    expect(
      (await env.migrator.prisma.invitation.findUnique({ where: { id: inv.id } }))?.teamId,
    ).toBe(teamId);

    // Unverified account with the matching email cannot accept.
    const signUp = await env.auth.api.signUpEmail({
      body: { email, password: PASSWORD, name: 'Invitee' },
    });
    await env.migrator.prisma.user.update({
      where: { id: signUp.user.id },
      data: { emailVerified: true },
    });
    const h = await signIn(env, email);
    await env.migrator.prisma.user.update({
      where: { id: signUp.user.id },
      data: { emailVerified: false },
    });
    await expect(
      env.auth.api.acceptInvitation({ headers: h, body: { invitationId: inv.id } }),
    ).rejects.toThrow(/verif/i);

    await env.migrator.prisma.user.update({
      where: { id: signUp.user.id },
      data: { emailVerified: true },
    });
    await env.auth.api.acceptInvitation({ headers: h, body: { invitationId: inv.id } });

    const m = await env.migrator.prisma.member.findFirst({
      where: { organizationId: orgId, userId: signUp.user.id },
    });
    expect(m).toMatchObject({ role: 'sales_executive', status: 'ACTIVE' });
    const tm = await env.migrator.prisma.teamMembership.findFirst({
      where: { membershipId: m!.id },
    });
    expect(tm).toMatchObject({ orgId, teamId, teamRole: 'MEMBER' });
    expect(
      (await env.migrator.prisma.invitation.findUnique({ where: { id: inv.id } }))?.status,
    ).toBe('accepted');
  });

  it('an expired invitation cannot be accepted', async () => {
    const u = await createVerifiedUser(env, 'late');
    const inv = await invite(u.email);
    await env.migrator.prisma.invitation.update({
      where: { id: inv.id },
      data: { expiresAt: new Date(Date.now() - 1000) },
    });
    const h = await signIn(env, u.email);
    await expect(
      env.auth.api.acceptInvitation({ headers: h, body: { invitationId: inv.id } }),
    ).rejects.toThrow(/Invitation not found|expired/i);
    expect(await env.migrator.prisma.member.count({ where: { userId: u.id } })).toBe(0);
  });

  it('a team id from another org is rejected by the composite FK', async () => {
    const otherOwner = await createVerifiedUser(env, 'otherowner');
    const otherOrg = await createOrg(env, otherOwner.id, 'Other Co');
    const otherTeam = await env.runner.withTenant(
      { orgId: otherOrg, userId: otherOwner.id },
      (tx) => tx.team.create({ data: { orgId: otherOrg, name: 'Theirs' } }),
    );
    await expect(invite(uniqueEmail('crossteam'), { teamId: otherTeam.id })).rejects.toThrow(
      /foreign key/i,
    );
  });
});
