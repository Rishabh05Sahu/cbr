// Teams module: operational teams and team leads (ADR-0003: ours, not the auth plugin's).
// Membership in a team is a history of spells (started_at/ended_at); current = ended_at NULL.
import { z } from 'zod';
import { writeAudit } from '@/modules/audit';
import { authorize, type RequestContext } from '@/platform/authz';
import { tenantRunner, type Tx } from '@/platform/db';
import { conflict, notFound, ruleViolation } from '@/platform/errors';

export interface TeamView {
  id: string;
  name: string;
  description: string | null;
  members: {
    spellId: string;
    membershipId: string;
    userId: string;
    name: string;
    teamRole: 'MEMBER' | 'LEAD';
  }[];
}

/** Teams the membership currently leads. Used for TEAM scope everywhere. */
export async function ledTeamIds(tx: Tx, membershipId: string): Promise<string[]> {
  const rows = await tx.teamMembership.findMany({
    where: { membershipId, teamRole: 'LEAD', endedAt: null, team: { archivedAt: null } },
    select: { teamId: true },
  });
  return rows.map((r) => r.teamId);
}

export async function myTeamIds(tx: Tx, membershipId: string): Promise<string[]> {
  const rows = await tx.teamMembership.findMany({
    where: { membershipId, endedAt: null, team: { archivedAt: null } },
    select: { teamId: true },
  });
  return [...new Set(rows.map((r) => r.teamId))];
}

export async function listTeams(ctx: RequestContext): Promise<TeamView[]> {
  const scope = authorize(ctx, 'team.read');
  return tenantRunner().withTenant(ctx.tenant, async (tx) => {
    let ids: string[] | null = null; // null = all
    if (scope !== 'ORG' && ctx.kind === 'member') {
      ids =
        scope === 'TEAM'
          ? [
              ...new Set([
                ...(await ledTeamIds(tx, ctx.membershipId)),
                ...(await myTeamIds(tx, ctx.membershipId)),
              ]),
            ]
          : await myTeamIds(tx, ctx.membershipId);
    }
    const teams = await tx.team.findMany({
      where: { archivedAt: null, ...(ids ? { id: { in: ids } } : {}) },
      orderBy: { name: 'asc' },
      select: {
        id: true,
        name: true,
        description: true,
        members: {
          where: { endedAt: null },
          select: {
            id: true,
            teamRole: true,
            membershipId: true,
            membership: { select: { userId: true, user: { select: { name: true } } } },
          },
        },
      },
    });
    return teams.map((t) => ({
      id: t.id,
      name: t.name,
      description: t.description,
      members: t.members
        .map((m) => ({
          spellId: m.id,
          membershipId: m.membershipId,
          userId: m.membership.userId,
          name: m.membership.user.name,
          teamRole: m.teamRole,
        }))
        .sort((a, b) =>
          a.teamRole === b.teamRole ? a.name.localeCompare(b.name) : a.teamRole === 'LEAD' ? -1 : 1,
        ),
    }));
  });
}

const teamInput = z.object({
  name: z.string().trim().min(2).max(80),
  description: z
    .string()
    .trim()
    .max(500)
    .optional()
    .transform((v) => (v ? v : null)),
});

function isUniqueViolation(e: unknown): boolean {
  return e instanceof Error && /unique|P2002|team_org_name_active_uq/i.test(e.message);
}

export async function createTeam(ctx: RequestContext, raw: unknown): Promise<{ id: string }> {
  authorize(ctx, 'team.manage');
  const input = teamInput.parse(raw);
  try {
    return await tenantRunner().withTenant(ctx.tenant, async (tx) => {
      const team = await tx.team.create({
        data: { orgId: ctx.orgId, name: input.name, description: input.description },
        select: { id: true },
      });
      await writeAudit(tx, ctx.orgId, {
        action: 'team.created',
        entityType: 'team',
        entityId: team.id,
        actorUserId: ctx.userId,
        metadata: { name: input.name },
      });
      return team;
    });
  } catch (e) {
    if (isUniqueViolation(e)) throw conflict('A team with this name already exists');
    throw e;
  }
}

export async function renameTeam(ctx: RequestContext, teamId: string, raw: unknown): Promise<void> {
  authorize(ctx, 'team.manage');
  const id = z.uuid().parse(teamId);
  const input = teamInput.parse(raw);
  try {
    await tenantRunner().withTenant(ctx.tenant, async (tx) => {
      const res = await tx.team.updateMany({
        where: { id, archivedAt: null },
        data: { name: input.name, description: input.description },
      });
      if (res.count !== 1) throw notFound('Team not found');
      await writeAudit(tx, ctx.orgId, {
        action: 'team.updated',
        entityType: 'team',
        entityId: id,
        actorUserId: ctx.userId,
        metadata: { name: input.name },
      });
    });
  } catch (e) {
    if (isUniqueViolation(e)) throw conflict('A team with this name already exists');
    throw e;
  }
}

export async function archiveTeam(ctx: RequestContext, teamId: string): Promise<void> {
  authorize(ctx, 'team.manage');
  const id = z.uuid().parse(teamId);
  await tenantRunner().withTenant(ctx.tenant, async (tx) => {
    const now = new Date();
    const res = await tx.team.updateMany({
      where: { id, archivedAt: null },
      data: { archivedAt: now },
    });
    if (res.count !== 1) throw notFound('Team not found');
    await tx.teamMembership.updateMany({
      where: { teamId: id, endedAt: null },
      data: { endedAt: now },
    });
    await writeAudit(tx, ctx.orgId, {
      action: 'team.archived',
      entityType: 'team',
      entityId: id,
      actorUserId: ctx.userId,
    });
  });
}

const memberInput = z.object({
  teamId: z.uuid(),
  membershipId: z.uuid(),
  teamRole: z.enum(['MEMBER', 'LEAD']).default('MEMBER'),
});

export async function addTeamMember(ctx: RequestContext, raw: unknown): Promise<void> {
  authorize(ctx, 'team.manage');
  const input = memberInput.parse(raw);
  await tenantRunner().withTenant(ctx.tenant, async (tx) => {
    const [team, member] = await Promise.all([
      tx.team.findFirst({ where: { id: input.teamId, archivedAt: null }, select: { id: true } }),
      tx.member.findUnique({
        where: { id: input.membershipId },
        select: { id: true, status: true, role: true },
      }),
    ]);
    if (!team) throw notFound('Team not found');
    if (!member || member.status !== 'ACTIVE') throw notFound('Member not found');
    if (input.teamRole === 'LEAD' && !['sales_manager', 'admin', 'owner'].includes(member.role)) {
      throw ruleViolation('Only Sales Managers, Admins or Owners can lead a team');
    }
    const open = await tx.teamMembership.findFirst({
      where: { teamId: team.id, membershipId: member.id, endedAt: null },
      select: { id: true },
    });
    if (open) throw conflict('Already a member of this team');
    const spell = await tx.teamMembership.create({
      data: {
        orgId: ctx.orgId,
        teamId: team.id,
        membershipId: member.id,
        teamRole: input.teamRole,
      },
      select: { id: true },
    });
    await writeAudit(tx, ctx.orgId, {
      action: 'team.member_added',
      entityType: 'team',
      entityId: team.id,
      actorUserId: ctx.userId,
      metadata: { membershipId: member.id, teamRole: input.teamRole, spellId: spell.id },
    });
  });
}

export async function removeTeamMember(ctx: RequestContext, spellId: string): Promise<void> {
  authorize(ctx, 'team.manage');
  const id = z.uuid().parse(spellId);
  await tenantRunner().withTenant(ctx.tenant, async (tx) => {
    const spell = await tx.teamMembership.findFirst({
      where: { id, endedAt: null },
      select: { teamId: true, membershipId: true },
    });
    if (!spell) throw notFound('Team membership not found');
    await tx.teamMembership.update({ where: { id }, data: { endedAt: new Date() } });
    await writeAudit(tx, ctx.orgId, {
      action: 'team.member_removed',
      entityType: 'team',
      entityId: spell.teamId,
      actorUserId: ctx.userId,
      metadata: { membershipId: spell.membershipId },
    });
  });
}

/** Changing lead/member closes the current spell and opens a new one (history retained). */
export async function setTeamRole(
  ctx: RequestContext,
  spellId: string,
  role: unknown,
): Promise<void> {
  authorize(ctx, 'team.manage');
  const id = z.uuid().parse(spellId);
  const teamRole = z.enum(['MEMBER', 'LEAD']).parse(role);
  await tenantRunner().withTenant(ctx.tenant, async (tx) => {
    const spell = await tx.teamMembership.findFirst({
      where: { id, endedAt: null },
      select: {
        teamId: true,
        membershipId: true,
        teamRole: true,
        membership: { select: { role: true } },
      },
    });
    if (!spell) throw notFound('Team membership not found');
    if (spell.teamRole === teamRole) return;
    if (
      teamRole === 'LEAD' &&
      !['sales_manager', 'admin', 'owner'].includes(spell.membership.role)
    ) {
      throw ruleViolation('Only Sales Managers, Admins or Owners can lead a team');
    }
    const now = new Date();
    await tx.teamMembership.update({ where: { id }, data: { endedAt: now } });
    await tx.teamMembership.create({
      data: {
        orgId: ctx.orgId,
        teamId: spell.teamId,
        membershipId: spell.membershipId,
        teamRole,
        startedAt: now,
      },
    });
    await writeAudit(tx, ctx.orgId, {
      action: 'team.role_changed',
      entityType: 'team',
      entityId: spell.teamId,
      actorUserId: ctx.userId,
      metadata: { membershipId: spell.membershipId, teamRole },
    });
  });
}
