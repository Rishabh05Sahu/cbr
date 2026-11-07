// Members module (identity-access): memberships, invitations, roles, suspension.
// Role and invitation writes go through Better Auth (crm_auth) via the org-admin facade, so
// the plugin's invariants hold; status, HR fields, audit and events are ours (crm_app).
import { z } from 'zod';
import { writeAudit } from '@/modules/audit';
import { countOpenLeadsOwnedBy, handOverFollowUpsOf, handOverOpenLeads } from '@/modules/leads';
import { ledTeamIds } from '@/modules/teams';
import * as orgAdmin from '@/platform/auth/org-admin';
import { OWNER_GRANTED_ROLES, PLUGIN_ROLES, type PluginRole } from '@/platform/auth/roles';
import { authorize, isOwner, type RequestContext } from '@/platform/authz';
import { tenantRunner } from '@/platform/db';
import { conflict, forbidden, notFound, ruleViolation } from '@/platform/errors';
import { emitEvent } from '@/platform/outbox';
import { enforce, RULES } from '@/platform/rate-limit';

export interface MemberView {
  membershipId: string;
  userId: string;
  name: string;
  email: string;
  role: PluginRole;
  status: string;
  employeeCode: string | null;
  designation: string | null;
  joinedAt: Date;
  teams: string[];
}

export async function listMembers(ctx: RequestContext): Promise<MemberView[]> {
  const scope = authorize(ctx, 'user.read');
  return tenantRunner().withTenant(ctx.tenant, async (tx) => {
    let where: { id?: { in: string[] } } = {};
    if (scope !== 'ORG' && ctx.kind === 'member') {
      if (scope === 'OWN') where = { id: { in: [ctx.membershipId] } };
      else {
        const led = await ledTeamIds(tx, ctx.membershipId);
        const inLed = led.length
          ? await tx.teamMembership.findMany({
              where: { teamId: { in: led }, endedAt: null },
              select: { membershipId: true },
            })
          : [];
        where = {
          id: { in: [...new Set([ctx.membershipId, ...inLed.map((m) => m.membershipId)])] },
        };
      }
    }
    const rows = await tx.member.findMany({
      where,
      orderBy: { createdAt: 'asc' },
      select: {
        id: true,
        userId: true,
        role: true,
        status: true,
        employeeCode: true,
        designation: true,
        createdAt: true,
        user: { select: { name: true, email: true } },
        teamMemberships: {
          where: { endedAt: null, team: { archivedAt: null } },
          select: { team: { select: { name: true } } },
        },
      },
    });
    return rows.map((r) => ({
      membershipId: r.id,
      userId: r.userId,
      name: r.user.name,
      email: r.user.email,
      role: r.role as PluginRole,
      status: r.status,
      employeeCode: r.employeeCode,
      designation: r.designation,
      joinedAt: r.createdAt,
      teams: r.teamMemberships.map((t) => t.team.name).sort(),
    }));
  });
}

export interface InvitationView {
  id: string;
  email: string;
  role: string | null;
  status: string;
  expiresAt: Date;
  createdAt: Date;
  teamName: string | null;
}

/** D3: pending-invitation listing is restricted to users who may invite. */
export async function listPendingInvitations(ctx: RequestContext): Promise<InvitationView[]> {
  authorize(ctx, 'user.invite');
  return tenantRunner().withTenant(ctx.tenant, async (tx) => {
    const rows = await tx.invitation.findMany({
      where: { status: 'pending' },
      orderBy: { createdAt: 'desc' },
      select: {
        id: true,
        email: true,
        role: true,
        status: true,
        expiresAt: true,
        createdAt: true,
        team: { select: { name: true } },
      },
    });
    return rows.map(({ team, ...r }) => ({ ...r, teamName: team?.name ?? null }));
  });
}

const roleSchema = z.enum(PLUGIN_ROLES as [PluginRole, ...PluginRole[]]);

export const inviteInput = z.object({
  email: z.email().trim().toLowerCase().max(254),
  role: roleSchema,
  teamId: z
    .uuid()
    .optional()
    .or(z.literal('').transform(() => undefined)),
});

function assertMayGrant(ctx: RequestContext, role: string) {
  if (OWNER_GRANTED_ROLES.has(role) && !isOwner(ctx)) {
    throw forbidden('Only an Owner can add or change Owners and Admins');
  }
}

export async function inviteMember(
  ctx: RequestContext,
  headers: Headers,
  raw: unknown,
): Promise<{ id: string }> {
  authorize(ctx, 'user.invite');
  const input = inviteInput.parse(raw);
  assertMayGrant(ctx, input.role);
  await enforce(`invite:${ctx.orgId}:${ctx.userId}`, RULES.invitationCreate);
  await tenantRunner().withTenant(ctx.tenant, async (tx) => {
    const existing = await tx.member.findFirst({
      where: { user: { email: input.email } },
      select: { id: true },
    });
    if (existing) throw conflict('This person is already a member. Reactivate them instead.');
    if (input.teamId) {
      const team = await tx.team.findFirst({
        where: { id: input.teamId, archivedAt: null },
        select: { id: true },
      });
      if (!team) throw notFound('Team not found');
    }
  });
  const inv = await orgAdmin.inviteMember(headers, {
    orgId: ctx.orgId,
    email: input.email,
    role: input.role,
    teamId: input.teamId ?? null,
  });
  await tenantRunner().withTenant(ctx.tenant, (tx) =>
    writeAudit(tx, ctx.orgId, {
      action: 'invitation.created',
      entityType: 'invitation',
      entityId: inv.id,
      actorUserId: ctx.userId,
      metadata: { role: input.role, teamId: input.teamId ?? null },
    }),
  );
  return { id: inv.id };
}

export async function cancelInvitation(
  ctx: RequestContext,
  headers: Headers,
  invitationId: string,
): Promise<void> {
  authorize(ctx, 'user.invite');
  const id = z.uuid().parse(invitationId);
  const inv = await tenantRunner().withTenant(ctx.tenant, (tx) =>
    tx.invitation.findUnique({ where: { id }, select: { status: true, role: true } }),
  );
  if (!inv) throw notFound('Invitation not found');
  if (inv.status !== 'pending') throw ruleViolation('Only pending invitations can be cancelled');
  if (inv.role) assertMayGrant(ctx, inv.role);
  await orgAdmin.cancelInvitation(headers, id);
  await tenantRunner().withTenant(ctx.tenant, (tx) =>
    writeAudit(tx, ctx.orgId, {
      action: 'invitation.canceled',
      entityType: 'invitation',
      entityId: id,
      actorUserId: ctx.userId,
    }),
  );
}

async function loadTarget(ctx: RequestContext, membershipId: string) {
  const id = z.uuid().parse(membershipId);
  const m = await tenantRunner().withTenant(ctx.tenant, (tx) =>
    tx.member.findUnique({
      where: { id },
      select: { id: true, userId: true, role: true, status: true },
    }),
  );
  if (!m) throw notFound('Member not found');
  return m;
}

/** Owners and Admins may only be acted on by an Owner (roles §2.3). */
function assertMayActOn(ctx: RequestContext, target: { role: string; userId: string }) {
  if (OWNER_GRANTED_ROLES.has(target.role) && !isOwner(ctx)) {
    throw forbidden('Only an Owner can change Owners and Admins');
  }
}

export async function changeRole(
  ctx: RequestContext,
  headers: Headers,
  membershipId: string,
  rawRole: unknown,
): Promise<void> {
  authorize(ctx, 'user.change_role');
  const role = roleSchema.parse(rawRole);
  const target = await loadTarget(ctx, membershipId);
  assertMayActOn(ctx, target);
  assertMayGrant(ctx, role);
  if (target.role === role) return;
  await orgAdmin.updateMemberRole(headers, { orgId: ctx.orgId, memberId: target.id, role });
  await tenantRunner().withTenant(ctx.tenant, async (tx) => {
    // A demoted team lead keeps team membership but loses the lead spell.
    if (!['sales_manager', 'admin', 'owner'].includes(role)) {
      const leads = await tx.teamMembership.findMany({
        where: { membershipId: target.id, teamRole: 'LEAD', endedAt: null },
      });
      const now = new Date();
      for (const l of leads) {
        await tx.teamMembership.update({ where: { id: l.id }, data: { endedAt: now } });
        await tx.teamMembership.create({
          data: {
            orgId: ctx.orgId,
            teamId: l.teamId,
            membershipId: target.id,
            teamRole: 'MEMBER',
            startedAt: now,
          },
        });
      }
    }
    await writeAudit(tx, ctx.orgId, {
      action: 'membership.role_changed',
      entityType: 'organization_membership',
      entityId: target.id,
      actorUserId: ctx.userId,
      metadata: { from: target.role, to: role },
    });
    await emitEvent(tx, ctx.orgId, {
      type: 'membership.role_changed',
      payload: { membershipId: target.id, userId: target.userId, role },
    });
  });
}

type ClosedStatus = 'SUSPENDED' | 'DEACTIVATED';

async function closeMembership(
  ctx: RequestContext,
  membershipId: string,
  status: ClosedStatus,
  handover?: string,
): Promise<void> {
  authorize(ctx, status === 'SUSPENDED' ? 'user.suspend' : 'user.remove');
  const target = await loadTarget(ctx, membershipId);
  if (target.userId === ctx.userId) throw ruleViolation('You cannot suspend or remove yourself');
  assertMayActOn(ctx, target);
  if (target.status === status) return;
  await tenantRunner().withTenant(ctx.tenant, async (tx) => {
    if (target.role === 'owner') {
      const owners = await tx.member.count({ where: { role: 'owner', status: 'ACTIVE' } });
      if (owners <= 1) throw ruleViolation('The last active Owner cannot be suspended or removed');
    }
    if (status === 'DEACTIVATED') {
      // FR-077: a deactivated user may not keep open leads. Their leads move to the chosen
      // person or queue in this same transaction, or the deactivation is refused.
      const open = await countOpenLeadsOwnedBy(tx, target.userId);
      if (open > 0 && !handover)
        throw ruleViolation(
          `This person owns ${open} open ${open === 1 ? 'lead' : 'leads'}. Choose who takes them over before removing them.`,
        );
      if (open > 0) await handOverOpenLeads(tx, ctx, target.userId, handover);
      // ADR-0010: their remaining open lead tasks (on other people's leads) go to each lead's
      // active owner, or are cancelled with a reason; their tasks with no lead are cancelled
      // (ADR-0015). membership_open_tasks_guard re-checks.
      await handOverFollowUpsOf(tx, ctx, target.userId);
    }
    const now = new Date();
    await tx.member.update({ where: { id: target.id }, data: { status, suspendedAt: now } });
    if (status === 'DEACTIVATED') {
      await tx.teamMembership.updateMany({
        where: { membershipId: target.id, endedAt: null },
        data: { endedAt: now },
      });
    }
    await writeAudit(tx, ctx.orgId, {
      action: status === 'SUSPENDED' ? 'membership.suspended' : 'membership.deactivated',
      entityType: 'organization_membership',
      entityId: target.id,
      actorUserId: ctx.userId,
    });
    await emitEvent(tx, ctx.orgId, {
      type: 'membership.suspended',
      payload: { membershipId: target.id, userId: target.userId },
    });
  });
  // Immediate effect: every session of the user ends (S2-01).
  await orgAdmin.revokeAllSessions(target.userId);
}

export const suspendMember = (ctx: RequestContext, membershipId: string) =>
  closeMembership(ctx, membershipId, 'SUSPENDED');
/**
 * "Remove" = deactivate: memberships are never deleted (domain-model §4). `handover`
 * ("user:<id>", "team:<id>" or "queue") is required when the person owns open leads (FR-077).
 */
export const deactivateMember = (ctx: RequestContext, membershipId: string, handover?: string) =>
  closeMembership(ctx, membershipId, 'DEACTIVATED', handover || undefined);

export async function reactivateMember(ctx: RequestContext, membershipId: string): Promise<void> {
  authorize(ctx, 'user.suspend');
  const target = await loadTarget(ctx, membershipId);
  assertMayActOn(ctx, target);
  if (target.status === 'ACTIVE') return;
  await tenantRunner().withTenant(ctx.tenant, async (tx) => {
    await tx.member.update({
      where: { id: target.id },
      data: { status: 'ACTIVE', suspendedAt: null },
    });
    await writeAudit(tx, ctx.orgId, {
      action: 'membership.reactivated',
      entityType: 'organization_membership',
      entityId: target.id,
      actorUserId: ctx.userId,
    });
  });
}

export const hrProfileInput = z.object({
  employeeCode: z
    .string()
    .trim()
    .max(40)
    .optional()
    .transform((v) => v || null),
  designation: z
    .string()
    .trim()
    .max(80)
    .optional()
    .transform((v) => v || null),
});

export async function updateHrProfile(
  ctx: RequestContext,
  membershipId: string,
  raw: unknown,
): Promise<void> {
  authorize(ctx, 'user.update_hr_profile');
  const input = hrProfileInput.parse(raw);
  const target = await loadTarget(ctx, membershipId);
  await tenantRunner().withTenant(ctx.tenant, async (tx) => {
    await tx.member.update({ where: { id: target.id }, data: input });
    await writeAudit(tx, ctx.orgId, {
      action: 'membership.profile_updated',
      entityType: 'organization_membership',
      entityId: target.id,
      actorUserId: ctx.userId,
      metadata: { employeeCode: input.employeeCode, designation: input.designation },
    });
  });
}
