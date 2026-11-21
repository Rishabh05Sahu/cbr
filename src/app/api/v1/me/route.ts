// GET /api/v1/me — the app's start-up call (ADR-0027): who is signed in, their organisations and,
// for the active one, the role, time zone and permission scopes from which the app builds its
// tabs. Answers without an active organisation too, so the app can show the organisation picker.
import { listMyMemberships } from '@/platform/auth/context';
import { scopeOf, type Permission, type Scope } from '@/platform/authz';
import { PERMISSIONS } from '@/platform/authz/permissions';
import { tenantRunner } from '@/platform/db';
import { unreadCount } from '@/modules/notifications';
import { apiSessionRoute } from '@/platform/http/api-route';

export const dynamic = 'force-dynamic';

export const GET = apiSessionRoute('me', async ({ user, resolved }) => {
  const memberships = await listMyMemberships(user.id);
  const base = {
    user: { id: user.id, name: user.name, email: user.email },
    memberships: memberships.map((m) => ({ orgId: m.orgId, orgName: m.orgName, role: m.role })),
  };
  if (!resolved.ok || resolved.ctx.kind !== 'member') {
    // NO_ACTIVE_ORG → pick one; TWO_FACTOR_REQUIRED → set it up on the website; a support
    // grant or an inactive membership → the website.
    return { ...base, active: null, blocked: resolved.ok ? 'SUPPORT_ON_WEB' : resolved.reason };
  }
  const ctx = resolved.ctx;
  const permissions: Partial<Record<Permission, Scope>> = {};
  for (const p of PERMISSIONS) {
    const s = scopeOf(ctx, p);
    if (s) permissions[p] = s;
  }
  const org = await tenantRunner().withTenant(ctx.tenant, (tx) =>
    tx.organization.findFirstOrThrow({ select: { timeZone: true, locale: true } }),
  );
  return {
    ...base,
    blocked: null,
    active: {
      orgId: ctx.orgId,
      orgName: ctx.orgName,
      role: ctx.role,
      timeZone: org.timeZone,
      locale: org.locale,
      permissions,
      unreadNotifications: await unreadCount(ctx),
    },
  };
});
