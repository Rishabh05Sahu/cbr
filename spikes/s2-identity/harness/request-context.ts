// Session -> RequestContext (ADR-0003: "session -> RequestContext resolution happens in
// src/platform/auth; modules never call the auth library directly"). Spike version.
import type { TenantContext, TenantRunner } from '@/platform/db/with-tenant';
import type { Auth } from '../auth/auth';
import { ROLE_CODE, type PluginRole, type RoleCode } from '../auth/roles';
import type { ClientHandle, Prisma } from '../db/clients';

type Runner = TenantRunner<Prisma.TransactionClient>;

export type RequestContext =
  | {
      kind: 'member';
      userId: string;
      orgId: string;
      membershipId: string;
      role: RoleCode;
      tenant: TenantContext;
    }
  | {
      kind: 'support';
      userId: string;
      orgId: string;
      grantId: string;
      accessLevel: 'READ' | 'WRITE';
      tenant: TenantContext;
    };

export type ResolveResult =
  | { ok: true; ctx: RequestContext }
  | {
      ok: false;
      reason: 'UNAUTHENTICATED' | 'NO_ACTIVE_ORG' | 'NOT_A_MEMBER' | 'MEMBERSHIP_INACTIVE';
    };

interface MembershipRow {
  org_id: string;
  membership_id: string;
  role_code: string;
  status: string;
}

export async function resolveRequestContext(
  deps: { auth: Auth; runner: Runner; platform: ClientHandle },
  headers: Headers,
): Promise<ResolveResult> {
  const session = await deps.auth.api.getSession({ headers });
  if (!session) return { ok: false, reason: 'UNAUTHENTICATED' };
  const userId = session.user.id;
  const orgId = session.session.activeOrganizationId;
  if (!orgId) return { ok: false, reason: 'NO_ACTIVE_ORG' };

  // The active org in the session is only a preference; membership is re-checked every request.
  const rows = await deps.runner.withUser(
    userId,
    (tx) =>
      tx.$queryRaw<MembershipRow[]>`
      SELECT org_id, membership_id, role_code, status
      FROM app.auth_memberships_for_user(${userId}::uuid)
      WHERE org_id = ${orgId}::uuid`,
  );
  const m = rows[0];
  if (m) {
    if (m.status !== 'ACTIVE') return { ok: false, reason: 'MEMBERSHIP_INACTIVE' };
    return {
      ok: true,
      ctx: {
        kind: 'member',
        userId,
        orgId,
        membershipId: m.membership_id,
        role: ROLE_CODE[m.role_code as PluginRole],
        tenant: { orgId, userId },
      },
    };
  }

  // Platform staff: no implicit access; only an approved, unexpired support grant.
  if ((session.user as { platformRole?: string | null }).platformRole === 'PLATFORM_ADMIN') {
    const grants = await deps.runner.withUser(
      userId,
      (tx) =>
        tx.$queryRaw<{ grant_id: string; access_level: 'READ' | 'WRITE' }[]>`
        SELECT grant_id, access_level FROM app.active_support_grant(${orgId}::uuid)`,
    );
    const g = grants[0];
    if (g) {
      await auditSupportAccess(deps, { userId, orgId, grantId: g.grant_id });
      return {
        ok: true,
        ctx: {
          kind: 'support',
          userId,
          orgId,
          grantId: g.grant_id,
          accessLevel: g.access_level,
          tenant: { orgId, userId, readOnly: g.access_level === 'READ' },
        },
      };
    }
  }
  return { ok: false, reason: 'NOT_A_MEMBER' };
}

/** Every support-access use is recorded in both the org's and the platform's audit log. */
async function auditSupportAccess(
  deps: { runner: Runner; platform: ClientHandle },
  a: { userId: string; orgId: string; grantId: string },
) {
  await deps.runner.withTenant({ orgId: a.orgId, userId: a.userId }, (tx) =>
    tx.auditLog.create({
      data: {
        orgId: a.orgId,
        actorUserId: a.userId,
        action: 'support_access.used',
        entityType: 'support_access_grant',
        entityId: a.grantId,
      },
    }),
  );
  await deps.platform.prisma.auditLog.create({
    data: {
      actorUserId: a.userId,
      action: 'support_access.used',
      entityType: 'support_access_grant',
      entityId: a.grantId,
      metadata: { orgId: a.orgId },
    },
  });
}
