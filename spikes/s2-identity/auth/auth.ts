// Better Auth configuration under evaluation in S2 (ADR-0003).
import { betterAuth } from 'better-auth';
import { prismaAdapter } from 'better-auth/adapters/prisma';
import { APIError, createAuthMiddleware, getSessionFromCtx } from 'better-auth/api';
import { organization } from 'better-auth/plugins/organization';
import { twoFactor } from 'better-auth/plugins/two-factor';
import type { TenantRunner } from '@/platform/db/with-tenant';
import { uuidv7 } from '@/lib/uuidv7';
import type { AuthPrismaClient, Prisma } from '../db/clients';
import { ac, assertSingleKnownRole, OWNER_GRANTED_ROLES, RolePolicyError, roles } from './roles';

export interface CapturedEmail {
  kind: 'verify-email' | 'reset-password' | 'invitation';
  to: string;
  token: string;
  url?: string;
}

export interface AuthDeps {
  /** crm_auth connection: the library's own tables only. */
  authPrisma: AuthPrismaClient;
  /** crm_app runner: our tables (team membership on invitation acceptance). */
  appRunner: TenantRunner<Prisma.TransactionClient>;
  /** Stand-in for the email adapter (Mailpit/SES come with the worker in Phase 1). */
  outbox: CapturedEmail[];
}

export const INVITATION_TTL_SECONDS = 7 * 24 * 60 * 60;
export const RESET_TOKEN_TTL_SECONDS = 30 * 60;

function asApiError(e: unknown): never {
  if (e instanceof RolePolicyError)
    throw new APIError('BAD_REQUEST', { message: e.message, code: 'ROLE_POLICY' });
  throw e;
}

const ROLE_GRANTING_PATHS = new Set([
  '/organization/update-member-role',
  '/organization/invite-member',
]);
const OWNER_GUARDED_PATHS = new Set([...ROLE_GRANTING_PATHS, '/organization/remove-member']);

export function createAuth({ authPrisma, appRunner, outbox }: AuthDeps) {
  return betterAuth({
    appName: 'CBR Property CRM',
    baseURL: process.env.BETTER_AUTH_URL ?? 'http://localhost:3000',
    secret: process.env.BETTER_AUTH_SECRET,
    telemetry: { enabled: false },
    database: prismaAdapter(authPrisma, { provider: 'postgresql', transaction: true }),
    advanced: { database: { generateId: () => uuidv7() } },
    session: { cookieCache: { enabled: false } }, // revocation takes effect on the next request
    emailAndPassword: {
      enabled: true,
      requireEmailVerification: true,
      minPasswordLength: 12,
      resetPasswordTokenExpiresIn: RESET_TOKEN_TTL_SECONDS,
      revokeSessionsOnPasswordReset: true,
      sendResetPassword: async ({ user, url, token }) => {
        outbox.push({ kind: 'reset-password', to: user.email, token, url });
      },
    },
    emailVerification: {
      sendVerificationEmail: async ({ user, url, token }) => {
        outbox.push({ kind: 'verify-email', to: user.email, token, url });
      },
    },
    user: {
      additionalFields: {
        platformRole: { type: 'string', required: false, input: false },
      },
    },
    hooks: {
      // Owner-only actions (roles §2.3): add/remove/demote Owners and Admins. The plugin
      // already stops non-owners granting or touching `owner`; this extends it to `admin`.
      // The plugin's organizationHooks do not receive the acting user, so this runs here.
      before: createAuthMiddleware(async (ctx) => {
        if (!OWNER_GUARDED_PATHS.has(ctx.path)) return;
        const body = (ctx.body ?? {}) as {
          role?: unknown;
          organizationId?: string;
          memberId?: string;
          memberIdOrEmail?: string;
        };
        if (ROLE_GRANTING_PATHS.has(ctx.path)) {
          try {
            assertSingleKnownRole(body.role);
          } catch (e) {
            asApiError(e);
          }
        }
        const session = await getSessionFromCtx(ctx);
        if (!session) return; // the endpoint itself rejects unauthenticated calls
        const orgId = body.organizationId ?? session.session.activeOrganizationId;
        if (!orgId) return;
        const actor = await ctx.context.adapter.findOne<{ role: string }>({
          model: 'member',
          where: [
            { field: 'organizationId', value: orgId },
            { field: 'userId', value: session.user.id },
          ],
        });
        if (actor?.role === 'owner') return;

        const targetRef = body.memberId ?? body.memberIdOrEmail;
        const target = targetRef
          ? await ctx.context.adapter.findOne<{ role: string; organizationId: string }>({
              model: 'member',
              where: targetRef.includes('@')
                ? [
                    { field: 'organizationId', value: orgId },
                    {
                      field: 'userId',
                      value:
                        (await ctx.context.internalAdapter.findUserByEmail(targetRef))?.user.id ??
                        '',
                    },
                  ]
                : [{ field: 'id', value: targetRef }],
            })
          : null;
        const grantsPrivileged = OWNER_GRANTED_ROLES.has(body.role as string);
        const touchesPrivileged = target !== null && OWNER_GRANTED_ROLES.has(target.role);
        if (grantsPrivileged || touchesPrivileged) {
          throw new APIError('FORBIDDEN', {
            message: 'Only an Owner can add, remove or change Owners and Admins',
            code: 'OWNER_ONLY_ROLE',
          });
        }
      }),
    },
    plugins: [
      organization({
        ac,
        roles,
        creatorRole: 'owner',
        // Pilot: orgs are created by the platform (system action), not self-service (OD-16).
        allowUserToCreateOrganization: false,
        membershipLimit: 500,
        invitationExpiresIn: INVITATION_TTL_SECONDS,
        cancelPendingInvitationsOnReInvite: true,
        requireEmailVerificationOnInvitation: true,
        // Teams and team leads live in our own tables (ADR-0003).
        teams: { enabled: false },
        schema: {
          member: {
            additionalFields: {
              status: { type: 'string', required: false, input: false, defaultValue: 'ACTIVE' },
            },
          },
          invitation: {
            additionalFields: {
              teamId: { type: 'string', required: false, input: true },
            },
          },
        },
        sendInvitationEmail: async (data) => {
          outbox.push({ kind: 'invitation', to: data.email, token: data.id });
        },
        organizationHooks: {
          beforeAddMember: async ({ member }) => {
            try {
              assertSingleKnownRole(member.role);
            } catch (e) {
              asApiError(e);
            }
          },
          beforeUpdateMemberRole: async ({ newRole }) => {
            try {
              assertSingleKnownRole(newRole);
            } catch (e) {
              asApiError(e);
            }
          },
          beforeCreateInvitation: async ({ invitation }) => {
            try {
              assertSingleKnownRole(invitation.role);
            } catch (e) {
              asApiError(e);
            }
          },
          afterAcceptInvitation: async ({ invitation, member, user }) => {
            const teamId = (invitation as { teamId?: string | null }).teamId;
            if (!teamId) return;
            await appRunner.withTenant({ orgId: member.organizationId, userId: user.id }, (tx) =>
              tx.teamMembership.create({
                data: { orgId: member.organizationId, teamId, membershipId: member.id },
              }),
            );
          },
        },
      }),
      twoFactor({ issuer: 'CBR Property CRM' }),
    ],
  });
}

export type Auth = ReturnType<typeof createAuth>;
