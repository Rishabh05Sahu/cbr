// GET /api/v1/members — People (user.read): members in the caller's scope, and for those who may
// invite, pending invitations, teams and the roles they may grant. Same rules as the website's
// Members page; every change below is re-checked by the members module.
import * as members from '@/modules/members';
import { listTeams } from '@/modules/teams';
import { PLUGIN_ROLES } from '@/platform/auth/roles';
import { can, isOwner } from '@/platform/authz';
import { apiRoute, bearerHeaders, readJson } from '@/platform/http/api-route';

export const dynamic = 'force-dynamic';

export const GET = apiRoute('members', async ({ ctx }) => {
  const mayInvite = can(ctx, 'user.invite');
  const owner = isOwner(ctx);
  return {
    members: await members.listMembers(ctx),
    invitations: mayInvite ? await members.listPendingInvitations(ctx) : [],
    teams: mayInvite ? (await listTeams(ctx)).map((t) => ({ id: t.id, name: t.name })) : [],
    grantableRoles: PLUGIN_ROLES.filter((r) => owner || (r !== 'owner' && r !== 'admin')),
    can: {
      invite: mayInvite,
      changeRole: can(ctx, 'user.change_role'),
      suspend: can(ctx, 'user.suspend'),
    },
  };
});

// POST /api/v1/members — invite someone by email. Body: { email, role, teamId? }.
export const POST = apiRoute('member-invite', async ({ req, ctx }) =>
  members.inviteMember(ctx, bearerHeaders(req)!, await readJson(req)),
);
