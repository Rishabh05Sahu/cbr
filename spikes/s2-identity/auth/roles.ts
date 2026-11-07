// System roles (user-personas-and-roles §2) mapped onto the organization plugin.
// OWNER/ADMIN use the plugin's built-in owner/admin semantics. The plugin's access
// control covers only org administration (org, members, invitations); business
// permissions and own/team/org scopes stay in our authz module.
import { createAccessControl } from 'better-auth/plugins/access';
import { defaultStatements } from 'better-auth/plugins/organization/access';

export const ac = createAccessControl(defaultStatements);

export const roles = {
  owner: ac.newRole({
    organization: ['update', 'delete'],
    member: ['create', 'update', 'delete'],
    invitation: ['create', 'cancel'],
  }),
  // Day-to-day administration; cannot delete the org (owner-only).
  admin: ac.newRole({
    organization: ['update'],
    member: ['create', 'update', 'delete'],
    invitation: ['create', 'cancel'],
  }),
  sales_manager: ac.newRole({}),
  sales_executive: ac.newRole({}),
  hr_ops: ac.newRole({}),
};

export type PluginRole = keyof typeof roles;
export const PLUGIN_ROLES = Object.keys(roles) as PluginRole[];

/** Our role codes (domain model) <-> plugin role strings. */
export const ROLE_CODE = {
  owner: 'OWNER',
  admin: 'ADMIN',
  sales_manager: 'SALES_MANAGER',
  sales_executive: 'SALES_EXECUTIVE',
  hr_ops: 'HR_OPS',
} as const satisfies Record<PluginRole, string>;

export type RoleCode = (typeof ROLE_CODE)[PluginRole];

/** Roles only an Owner may grant (owner-only actions, roles §2.3). */
export const OWNER_GRANTED_ROLES: ReadonlySet<string> = new Set(['owner', 'admin']);

export class RolePolicyError extends Error {
  override readonly name = 'RolePolicyError';
}

/** Exactly one known role. Rejects arrays, comma lists and unknown values. */
export function assertSingleKnownRole(role: unknown): PluginRole {
  if (
    typeof role !== 'string' ||
    role.includes(',') ||
    !PLUGIN_ROLES.includes(role as PluginRole)
  ) {
    throw new RolePolicyError(`exactly one known role is required, got ${JSON.stringify(role)}`);
  }
  return role as PluginRole;
}
