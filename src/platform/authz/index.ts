// Authorisation: every module command/query calls authorize() first (ADR-0004).
// The UI may mirror these checks but never replaces them.
import type { TenantContext } from '@/platform/db/with-tenant';
import type { PluginRole, RoleCode } from '@/platform/auth/roles';
import { forbidden } from '@/platform/errors';
import { ROLE_GRANTS, SUPPORT_READ_GRANTS, type Permission, type Scope } from './permissions';

export type { Permission, Scope } from './permissions';

export type RequestContext =
  | {
      kind: 'member';
      userId: string;
      orgId: string;
      orgName: string;
      membershipId: string;
      role: RoleCode;
      pluginRole: PluginRole;
      tenant: TenantContext;
    }
  | {
      kind: 'support';
      userId: string;
      orgId: string;
      orgName: string;
      grantId: string;
      accessLevel: 'READ' | 'WRITE';
      tenant: TenantContext;
    };

export function scopeOf(ctx: RequestContext, permission: Permission): Scope | null {
  // Support access is read-only in Phase 1 regardless of the grant's level; WRITE grants
  // are not enabled until a reviewed use case exists.
  const grants = ctx.kind === 'member' ? ROLE_GRANTS[ctx.role] : SUPPORT_READ_GRANTS;
  return grants[permission] ?? null;
}

export function can(ctx: RequestContext, permission: Permission): boolean {
  return scopeOf(ctx, permission) !== null;
}

/** Returns the caller's scope for the permission, or throws FORBIDDEN. */
export function authorize(ctx: RequestContext, permission: Permission): Scope {
  const scope = scopeOf(ctx, permission);
  if (!scope) throw forbidden();
  return scope;
}

export function isOwner(ctx: RequestContext): boolean {
  return ctx.kind === 'member' && ctx.role === 'OWNER';
}
