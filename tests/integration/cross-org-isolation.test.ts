// Cross-organisation isolation of every Phase 1 module function: an actor in org A using
// org B's ids must get NOT_FOUND/FORBIDDEN and change nothing. Also covers the auth
// library's own org APIs (D2: application-level permission checks preserved).
import { beforeAll, describe, expect, it } from 'vitest';
import { listAudit } from '@/modules/audit';
import * as members from '@/modules/members';
import { getOrgSettings } from '@/modules/organizations';
import * as support from '@/modules/support-access';
import * as teams from '@/modules/teams';
import { auth } from '@/platform/auth/auth';
import { DomainError } from '@/platform/errors';
import { migrator } from '../support/db';
import { actorIn, email, seedOrg, type Actor } from '../support/factory';

let A: Awaited<ReturnType<typeof seedOrg>>;
let B: Awaited<ReturnType<typeof seedOrg>>;
let ownerA: Actor;
let bTeam: string;
let bInvitation: string;
let bGrant: string;

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
  A = await seedOrg('IsoA');
  B = await seedOrg('IsoB');
  ownerA = await actorIn(A.users.owner, A.orgId);
  const ownerB = await actorIn(B.users.owner, B.orgId);
  bTeam = (await teams.createTeam(ownerB.ctx, { name: 'B team' })).id;
  await teams.addTeamMember(ownerB.ctx, { teamId: bTeam, membershipId: B.membership.exec1! });
  bInvitation = (
    await members.inviteMember(ownerB.ctx, ownerB.headers, {
      email: email('b-invitee'),
      role: 'sales_executive',
    })
  ).id;
  bGrant = (
    await migrator().supportAccessGrant.create({
      data: {
        orgId: B.orgId,
        platformUserId: B.users.owner.id,
        reason: 'test grant reason',
        accessLevel: 'READ',
        startsAt: new Date(),
        expiresAt: new Date(Date.now() + 3_600_000),
      },
    })
  ).id;
});

describe('reads never return another org', () => {
  it('lists contain only org A data', async () => {
    const m = await members.listMembers(ownerA.ctx);
    expect(m.length).toBe(6);
    expect(m.some((x) => Object.values(B.users).some((u) => u.id === x.userId))).toBe(false);
    expect(
      (await members.listPendingInvitations(ownerA.ctx)).some((i) => i.id === bInvitation),
    ).toBe(false);
    expect((await teams.listTeams(ownerA.ctx)).some((t) => t.id === bTeam)).toBe(false);
    expect((await support.listGrants(ownerA.ctx)).some((g) => g.id === bGrant)).toBe(false);
    expect((await getOrgSettings(ownerA.ctx)).id).toBe(A.orgId);
    const audit = await listAudit(ownerA.ctx, { limit: 200 });
    const bAudit = await migrator().auditLog.findMany({
      where: { orgId: B.orgId },
      select: { id: true },
    });
    expect(audit.rows.some((r) => bAudit.some((b) => b.id === r.id))).toBe(false);
  });
});

describe("writes with org B's ids from org A fail and change nothing", () => {
  it.each([
    [
      'changeRole',
      () => members.changeRole(ownerA.ctx, ownerA.headers, B.membership.exec1!, 'sales_manager'),
    ],
    ['suspendMember', () => members.suspendMember(ownerA.ctx, B.membership.exec1!)],
    ['deactivateMember', () => members.deactivateMember(ownerA.ctx, B.membership.exec1!)],
    ['reactivateMember', () => members.reactivateMember(ownerA.ctx, B.membership.exec1!)],
    [
      'updateHrProfile',
      () => members.updateHrProfile(ownerA.ctx, B.membership.exec1!, { employeeCode: 'X' }),
    ],
    ['cancelInvitation', () => members.cancelInvitation(ownerA.ctx, ownerA.headers, bInvitation)],
    ['renameTeam', () => teams.renameTeam(ownerA.ctx, bTeam, { name: 'pwned' })],
    ['archiveTeam', () => teams.archiveTeam(ownerA.ctx, bTeam)],
    [
      'addTeamMember (B team)',
      () => teams.addTeamMember(ownerA.ctx, { teamId: bTeam, membershipId: A.membership.exec1! }),
    ],
    [
      'addTeamMember (B member)',
      async () => {
        const t = await teams.createTeam(ownerA.ctx, { name: `A-${Math.random()}` });
        return teams.addTeamMember(ownerA.ctx, { teamId: t.id, membershipId: B.membership.exec1! });
      },
    ],
    ['approveGrant', () => support.approveGrant(ownerA.ctx, bGrant)],
    ['revokeGrant', () => support.revokeGrant(ownerA.ctx, bGrant)],
  ])('%s -> NOT_FOUND', async (_name, fn) => {
    expect(await code(fn())).toBe('NOT_FOUND');
  });

  it('org B state is untouched', async () => {
    const m = await migrator().member.findUniqueOrThrow({ where: { id: B.membership.exec1! } });
    expect(m).toMatchObject({ role: 'sales_executive', status: 'ACTIVE', employeeCode: null });
    expect(await migrator().team.findUniqueOrThrow({ where: { id: bTeam } })).toMatchObject({
      name: 'B team',
      archivedAt: null,
    });
    expect(
      (await migrator().invitation.findUniqueOrThrow({ where: { id: bInvitation } })).status,
    ).toBe('pending');
    expect(
      await migrator().supportAccessGrant.findUniqueOrThrow({ where: { id: bGrant } }),
    ).toMatchObject({ approvedByUserId: null, revokedAt: null });
  });

  it('inviting into org A with a team from org B fails', async () => {
    expect(
      await code(
        members.inviteMember(ownerA.ctx, ownerA.headers, {
          email: email('x'),
          role: 'sales_executive',
          teamId: bTeam,
        }),
      ),
    ).toBe('NOT_FOUND');
  });
});

describe('D2: the auth library still enforces org membership on its own APIs', () => {
  it('an org A owner cannot use library APIs against org B', async () => {
    await expect(
      auth().api.updateMemberRole({
        headers: ownerA.headers,
        body: { organizationId: B.orgId, memberId: B.membership.exec1!, role: 'sales_manager' },
      }),
    ).rejects.toThrow();
    await expect(
      auth().api.createInvitation({
        headers: ownerA.headers,
        body: { organizationId: B.orgId, email: email('x'), role: 'sales_executive' },
      }),
    ).rejects.toThrow();
    await expect(
      auth().api.cancelInvitation({ headers: ownerA.headers, body: { invitationId: bInvitation } }),
    ).rejects.toThrow();
    await expect(
      auth().api.setActiveOrganization({
        headers: ownerA.headers,
        body: { organizationId: B.orgId },
      }),
    ).rejects.toThrow();
    await expect(
      auth().api.getInvitation({ headers: ownerA.headers, query: { id: bInvitation } }),
    ).rejects.toThrow();
    expect(
      (await migrator().member.findUniqueOrThrow({ where: { id: B.membership.exec1! } })).role,
    ).toBe('sales_executive');
  });
});
