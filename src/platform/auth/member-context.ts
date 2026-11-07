// Membership → member RequestContext, without the auth library, so the worker can rebuild a
// user's context the same way the web does (app.auth_memberships_for_user, which only answers
// for the user set as app.user_id). Used per request by ./context.ts and before every import
// batch by the worker (Phase 2 M4: the import runs as its uploader, never as a system actor).
import type { RequestContext } from '@/platform/authz';
import { tenantRunner } from '@/platform/db';
import { ROLE_CODE, type PluginRole } from './roles';

export interface MembershipRow {
  org_id: string;
  membership_id: string;
  role_code: string;
  status: string;
  org_status: string;
  org_name: string;
}

export async function membershipsFor(userId: string): Promise<MembershipRow[]> {
  return tenantRunner().withUser(
    userId,
    (tx) =>
      tx.$queryRaw<MembershipRow[]>`
      SELECT org_id, membership_id, role_code, status, org_status, org_name
      FROM app.auth_memberships_for_user(${userId}::uuid)
      ORDER BY org_name`,
  );
}

export type MemberContextResult =
  | { ok: true; ctx: RequestContext & { kind: 'member' } }
  | { ok: false; reason: 'NOT_A_MEMBER' | 'MEMBERSHIP_INACTIVE' | 'ORG_SUSPENDED' };

export function memberContextFrom(
  userId: string,
  orgId: string,
  m: MembershipRow | undefined,
): MemberContextResult {
  if (!m) return { ok: false, reason: 'NOT_A_MEMBER' };
  if (m.org_status !== 'ACTIVE') return { ok: false, reason: 'ORG_SUSPENDED' };
  if (m.status !== 'ACTIVE') return { ok: false, reason: 'MEMBERSHIP_INACTIVE' };
  const pluginRole = m.role_code as PluginRole;
  return {
    ok: true,
    ctx: {
      kind: 'member',
      userId,
      orgId,
      orgName: m.org_name,
      membershipId: m.membership_id,
      role: ROLE_CODE[pluginRole],
      pluginRole,
      tenant: { orgId, userId },
    },
  };
}

/** The user's current context in the org, re-read from the database (no session involved). */
export async function memberContext(userId: string, orgId: string): Promise<MemberContextResult> {
  const rows = await membershipsFor(userId);
  return memberContextFrom(
    userId,
    orgId,
    rows.find((r) => r.org_id === orgId),
  );
}
