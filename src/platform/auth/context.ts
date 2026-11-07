// Session -> RequestContext (ADR-0003). Framework-independent core; Next.js code uses
// ./session.ts which adds per-request caching. Membership and org status are re-checked on
// every request: the session's active org is only a preference.
import type { RequestContext } from '@/platform/authz';
import { platformPrisma } from '@/platform/db/client';
import { tenantRunner } from '@/platform/db';
import { membershipsFor, memberContextFrom } from './member-context';
import type { PluginRole } from './roles';
import { MANDATORY_TWO_FACTOR_ROLES } from './two-factor-policy';
import { auth } from './auth';

export interface SessionUser {
  id: string;
  name: string;
  email: string;
  emailVerified: boolean;
  twoFactorEnabled: boolean;
  platformRole: string | null;
}

export type ResolveResult =
  | { ok: true; user: SessionUser; ctx: RequestContext }
  | { ok: false; reason: 'UNAUTHENTICATED'; user: null }
  | {
      ok: false;
      reason:
        | 'NO_ACTIVE_ORG'
        | 'NOT_A_MEMBER'
        | 'MEMBERSHIP_INACTIVE'
        | 'ORG_SUSPENDED'
        | 'TWO_FACTOR_REQUIRED';
      user: SessionUser;
    };

export interface MembershipSummary {
  orgId: string;
  orgName: string;
  role: PluginRole;
  status: string;
  orgStatus: string;
}

export async function listMyMemberships(userId: string): Promise<MembershipSummary[]> {
  return (await membershipsFor(userId))
    .filter((m) => m.status === 'ACTIVE' && m.org_status === 'ACTIVE')
    .map((m) => ({
      orgId: m.org_id,
      orgName: m.org_name,
      role: m.role_code as PluginRole,
      status: m.status,
      orgStatus: m.org_status,
    }));
}

export async function resolveRequestContext(headers: Headers): Promise<ResolveResult> {
  const session = await auth().api.getSession({ headers });
  if (!session) return { ok: false, reason: 'UNAUTHENTICATED', user: null };
  const u = session.user as typeof session.user & { platformRole?: string | null };
  const user: SessionUser = {
    id: u.id,
    name: u.name,
    email: u.email,
    emailVerified: u.emailVerified,
    twoFactorEnabled: Boolean(u.twoFactorEnabled),
    platformRole: u.platformRole ?? null,
  };
  const orgId = session.session.activeOrganizationId;
  if (!orgId) return { ok: false, reason: 'NO_ACTIVE_ORG', user };

  const m = (await membershipsFor(user.id)).find((r) => r.org_id === orgId);
  if (m) {
    const member = memberContextFrom(user.id, orgId, m);
    if (!member.ok) return { ok: false, reason: member.reason, user };
    const pluginRole = member.ctx.pluginRole;
    // Item D: Owners and Admins cannot open the org until an authenticator is enrolled. A
    // session of a 2FA user only exists after the second factor (or after enrolment, which
    // ends every older session), so this flag implies a second-factor session.
    if (MANDATORY_TWO_FACTOR_ROLES.has(pluginRole) && !user.twoFactorEnabled)
      return { ok: false, reason: 'TWO_FACTOR_REQUIRED', user };
    return { ok: true, user, ctx: member.ctx };
  }

  // Platform staff: no implicit access; only an approved, unexpired support grant, and only
  // with two-step verification (item D).
  if (user.platformRole === 'PLATFORM_ADMIN') {
    if (!user.twoFactorEnabled) return { ok: false, reason: 'TWO_FACTOR_REQUIRED', user };
    const grant = (
      await tenantRunner().withUser(
        user.id,
        (tx) =>
          tx.$queryRaw<{ grant_id: string; access_level: 'READ' | 'WRITE' }[]>`
          SELECT grant_id, access_level FROM app.active_support_grant(${orgId}::uuid)`,
      )
    )[0];
    if (grant) {
      const org = await tenantRunner().withTenant({ orgId, userId: user.id }, async (tx) => {
        const o = await tx.organization.findUnique({
          where: { id: orgId },
          select: { name: true, status: true },
        });
        await tx.auditLog.create({
          data: {
            orgId,
            actorUserId: user.id,
            actorKind: 'PLATFORM',
            action: 'support_access.used',
            entityType: 'support_access_grant',
            entityId: grant.grant_id,
          },
        });
        return o;
      });
      await platformPrisma().auditLog.create({
        data: {
          actorUserId: user.id,
          actorKind: 'PLATFORM',
          action: 'support_access.used',
          entityType: 'support_access_grant',
          entityId: grant.grant_id,
          metadata: { orgId },
        },
      });
      if (org?.status !== 'ACTIVE') return { ok: false, reason: 'ORG_SUSPENDED', user };
      return {
        ok: true,
        user,
        ctx: {
          kind: 'support',
          userId: user.id,
          orgId,
          orgName: org.name,
          grantId: grant.grant_id,
          accessLevel: grant.access_level,
          tenant: { orgId, userId: user.id, readOnly: true },
        },
      };
    }
  }
  return { ok: false, reason: 'NOT_A_MEMBER', user };
}
