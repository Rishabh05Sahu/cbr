// Application commands exercised by S2 (our code, crm_app, under withTenant).
import type { TenantRunner } from '@/platform/db/with-tenant';
import type { Auth } from '../auth/auth';
import type { Prisma } from '../db/clients';
import type { RequestContext } from './request-context';

type Runner = TenantRunner<Prisma.TransactionClient>;

export class Forbidden extends Error {
  override readonly name = 'Forbidden';
}
export class NotFound extends Error {
  override readonly name = 'NotFound';
}

/** Suspend a membership and revoke all of the user's sessions immediately. */
export async function suspendMember(
  deps: { auth: Auth; runner: Runner },
  ctx: RequestContext,
  membershipId: string,
): Promise<void> {
  if (ctx.kind !== 'member' || (ctx.role !== 'OWNER' && ctx.role !== 'ADMIN'))
    throw new Forbidden();
  const target = await deps.runner.withTenant(ctx.tenant, async (tx) => {
    const m = await tx.member.findUnique({
      where: { id: membershipId },
      select: { id: true, userId: true, role: true },
    });
    if (!m) throw new NotFound();
    // Suspending an Owner or Admin is owner-only (roles §2.3).
    if ((m.role === 'owner' || m.role === 'admin') && ctx.role !== 'OWNER') throw new Forbidden();
    await tx.member.update({ where: { id: m.id }, data: { status: 'SUSPENDED' } });
    await tx.auditLog.create({
      data: {
        orgId: ctx.orgId,
        actorUserId: ctx.userId,
        action: 'membership.suspended',
        entityType: 'organization_membership',
        entityId: m.id,
      },
    });
    return m;
  });
  const authCtx = await deps.auth.$context;
  await authCtx.internalAdapter.deleteUserSessions(target.userId);
}

/** Team-lead scope comes from our team_membership.team_role, never from plugin data. */
export async function ledTeamIds(runner: Runner, ctx: RequestContext): Promise<string[]> {
  if (ctx.kind !== 'member') return [];
  const rows = await runner.withTenant(ctx.tenant, (tx) =>
    tx.teamMembership.findMany({
      where: { membershipId: ctx.membershipId, teamRole: 'LEAD', endedAt: null },
      select: { teamId: true },
    }),
  );
  return rows.map((r) => r.teamId);
}

/** Owner-only: approve a pending support-access grant (roles §2.3). */
export async function approveSupportGrant(runner: Runner, ctx: RequestContext, grantId: string) {
  if (ctx.kind !== 'member' || ctx.role !== 'OWNER') throw new Forbidden();
  await runner.withTenant(ctx.tenant, async (tx) => {
    const res = await tx.supportAccessGrant.updateMany({
      where: { id: grantId, approvedByUserId: null, revokedAt: null },
      data: { approvedByUserId: ctx.userId },
    });
    if (res.count !== 1) throw new NotFound();
    await tx.auditLog.create({
      data: {
        orgId: ctx.orgId,
        actorUserId: ctx.userId,
        action: 'support_access.approved',
        entityType: 'support_access_grant',
        entityId: grantId,
      },
    });
  });
}

export async function listLeads(runner: Runner, ctx: RequestContext) {
  return runner.withTenant(ctx.tenant, (tx) =>
    tx.lead.findMany({ select: { id: true, orgId: true, fullName: true } }),
  );
}

export async function createLead(runner: Runner, ctx: RequestContext, fullName: string) {
  return runner.withTenant(ctx.tenant, (tx) =>
    tx.lead.create({ data: { orgId: ctx.orgId, fullName }, select: { id: true } }),
  );
}
