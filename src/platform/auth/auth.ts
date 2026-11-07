// Better Auth configuration (ADR-0003, Spike S2, owner decisions D2/D3 of 2026-10-19).
import { randomUUID } from 'node:crypto';
import { betterAuth } from 'better-auth';
import { prismaAdapter } from 'better-auth/adapters/prisma';
import { APIError, createAuthMiddleware, getSessionFromCtx } from 'better-auth/api';
import { organization } from 'better-auth/plugins/organization';
import { twoFactor } from 'better-auth/plugins/two-factor';
import { serverEnv } from '@/env';
import { uuidv7 } from '@/lib/uuidv7';
import { writeAudit } from '@/modules/audit';
import { authPrisma } from '@/platform/db/client';
import { tenantRunner } from '@/platform/db';
import { logger, scrubUrls } from '@/platform/observability/logger';
import { enqueueEmail } from '@/platform/queue';
import { consume } from '@/platform/rate-limit';
import {
  generateRecoveryCodes,
  hashRecoveryCode,
  hashedRecoveryCodeStorage,
  RECOVERY_CODE_COUNT,
} from './recovery-codes';
import { ac, assertSingleKnownRole, OWNER_GRANTED_ROLES, RolePolicyError, roles } from './roles';
import {
  isTwoFactorMandatory,
  recordSecurityEvent,
  remainingRecoveryCodesFor,
  type SecurityEvent,
} from './two-factor-policy';

export const INVITATION_TTL_SECONDS = 7 * 24 * 60 * 60; // D3
export const RESET_TOKEN_TTL_SECONDS = 30 * 60;

/**
 * HTTP endpoints we do not expose. Org administration (invite, role change, removal,
 * cancellation, listings, org settings) goes through our Server Actions, which authorise
 * with our permission catalog, rate-limit, and audit. The library's server API is still
 * used by those actions (disabledPaths only affects the HTTP router).
 */
export const DISABLED_PATHS = [
  '/organization/create',
  '/organization/update',
  '/organization/delete',
  '/organization/add-member',
  '/organization/invite-member',
  '/organization/cancel-invitation',
  '/organization/update-member-role',
  '/organization/remove-member',
  '/organization/leave',
  '/organization/list-members',
  '/organization/list-invitations',
  '/organization/get-full-organization',
  '/organization/check-slug',
  '/delete-user',
  '/change-email',
  '/update-user',
  '/link-social',
  '/unlink-account',
  '/sign-in/social',
];

function asApiError(e: unknown): never {
  if (e instanceof RolePolicyError) {
    throw new APIError('BAD_REQUEST', { message: e.message, code: 'ROLE_POLICY' });
  }
  throw e;
}

const ROLE_GRANTING_PATHS = new Set([
  '/organization/update-member-role',
  '/organization/invite-member',
]);
const OWNER_GUARDED_PATHS = new Set([...ROLE_GRANTING_PATHS, '/organization/remove-member']);

/** Second-factor verification endpoints: trusted devices are never honoured (item D). */
const TWO_FACTOR_VERIFY_PATHS = new Set([
  '/two-factor/verify-totp',
  '/two-factor/verify-backup-code',
  '/two-factor/verify-otp',
]);

type PendingTwoFactorEvent =
  | { kind: 'enrol'; userId: string }
  | { kind: 'recovery-code'; userId: string | null }
  | { kind: 'regenerate' | 'disable'; userId: string };

/**
 * Two-factor events observed by the before-hook and completed by the after-hook of the same
 * request. Keyed by the per-dispatch context object, so nothing is shared between requests.
 */
const pendingTwoFactorEvents = new WeakMap<object, PendingTwoFactorEvent>();

const isApiErrorLike = (v: unknown) =>
  !!v && typeof v === 'object' && (v as { name?: unknown }).name === 'APIError';

function createAuth() {
  const env = serverEnv();
  const baseURL = env.BETTER_AUTH_URL;
  const production = env.NODE_ENV === 'production';

  return betterAuth({
    appName: 'CBR Property CRM',
    baseURL,
    secret: env.BETTER_AUTH_SECRET,
    trustedOrigins: [baseURL],
    telemetry: { enabled: false },
    database: prismaAdapter(authPrisma(), { provider: 'postgresql', transaction: true }),
    disabledPaths: DISABLED_PATHS,
    logger: {
      level: 'warn',
      // Library messages may embed URLs/emails: scrub, and never forward extra args.
      log: (level, message) => logger[level]({ src: 'better-auth' }, scrubUrls(message)),
    },
    advanced: {
      // Never let the environment switch CSRF/origin checks off: the library disables them
      // when NODE_ENV=test or TEST is truthy unless this is set explicitly.
      disableOriginCheck: false,
      disableCSRFCheck: false,
      cookiePrefix: 'cbr',
      useSecureCookies: production,
      // Invitation ids travel in emailed links (D3): fully random v4 (122 bits). Other ids are
      // time-ordered v7 for index locality (database-design §1).
      database: { generateId: ({ model }) => (model === 'invitation' ? randomUUID() : uuidv7()) },
      // Behind the hosting load balancer the client IP arrives in X-Forwarded-For.
      ipAddress: { ipAddressHeaders: ['x-forwarded-for', 'x-real-ip'] },
    },
    session: {
      expiresIn: 60 * 60 * 24 * 7,
      updateAge: 60 * 60 * 24,
      cookieCache: { enabled: false }, // revocation takes effect on the next request
    },
    rateLimit: {
      enabled: true,
      window: 60,
      max: 100,
      customStorage: { consume },
      customRules: {
        '/sign-in/email': { window: 60, max: 10 },
        '/sign-up/email': { window: 3600, max: 10 },
        '/request-password-reset': { window: 900, max: 5 },
        '/reset-password': { window: 900, max: 10 },
        '/send-verification-email': { window: 900, max: 5 },
        '/two-factor/verify-totp': { window: 300, max: 10 },
        '/two-factor/verify-backup-code': { window: 300, max: 5 },
        // D3: invitation lookup and acceptance.
        '/organization/get-invitation': { window: 600, max: 30 },
        '/organization/accept-invitation': { window: 600, max: 10 },
        '/organization/reject-invitation': { window: 600, max: 10 },
        '/organization/list-user-invitations': { window: 600, max: 30 },
      },
    },
    emailAndPassword: {
      enabled: true,
      requireEmailVerification: true,
      minPasswordLength: 12,
      maxPasswordLength: 128,
      resetPasswordTokenExpiresIn: RESET_TOKEN_TTL_SECONDS,
      revokeSessionsOnPasswordReset: true,
      sendResetPassword: async ({ user, url }) => {
        await enqueueEmail({
          template: 'reset-password',
          to: user.email,
          params: { name: user.name, url },
        });
      },
    },
    emailVerification: {
      sendOnSignUp: true,
      sendOnSignIn: true,
      autoSignInAfterVerification: false,
      expiresIn: 60 * 60 * 24,
      sendVerificationEmail: async ({ user, url }) => {
        await enqueueEmail({
          template: 'verify-email',
          to: user.email,
          params: { name: user.name, url },
        });
      },
    },
    user: {
      additionalFields: {
        platformRole: { type: 'string', required: false, input: false },
        phoneE164: { type: 'string', required: false, input: false },
      },
      // Closed sign-up (OD-16 pilot). Public email/password sign-up needs a pending,
      // unexpired invitation for that address. `admin` creation is only reachable from our
      // server code (platform owner provisioning). Every other method is refused.
      validateUserInfo: async ({ user, source }) => {
        if (source.action !== 'create-user') return;
        if (source.method === 'admin') return;
        if (source.method === 'email-password' && typeof user.email === 'string') {
          const pending = await authPrisma().invitation.count({
            where: {
              email: user.email.toLowerCase(),
              status: 'pending',
              expiresAt: { gt: new Date() },
            },
          });
          if (pending > 0) return;
        }
        return {
          error: 'INVITATION_REQUIRED',
          errorDescription: 'Accounts are created by invitation only',
        };
      },
    },
    hooks: {
      // Owner-only actions (roles §2.3): add/remove/demote Owners and Admins. The plugin's
      // organizationHooks do not receive the acting user, so this runs per request. These
      // paths are HTTP-disabled; the guard still applies to server-side calls.
      before: createAuthMiddleware(async (ctx) => {
        if (TWO_FACTOR_VERIFY_PATHS.has(ctx.path)) {
          const body: Record<string, unknown> = { ...(ctx.body as object), trustDevice: false };
          const session = await getSessionFromCtx(ctx);
          if (ctx.path === '/two-factor/verify-backup-code') {
            // Stored codes are keyed hashes; compare like with like (recovery-codes.ts).
            body.code = hashRecoveryCode(String(body.code ?? ''), env.BETTER_AUTH_SECRET);
            pendingTwoFactorEvents.set(ctx.context, {
              kind: 'recovery-code',
              userId: session?.user.id ?? null,
            });
          } else if (
            ctx.path === '/two-factor/verify-totp' &&
            session &&
            !session.user.twoFactorEnabled
          ) {
            pendingTwoFactorEvents.set(ctx.context, { kind: 'enrol', userId: session.user.id });
          }
          return { context: { body } };
        }
        if (
          ctx.path === '/two-factor/disable' ||
          ctx.path === '/two-factor/generate-backup-codes'
        ) {
          const session = await getSessionFromCtx(ctx);
          if (!session) return;
          const user = session.user as typeof session.user & { platformRole?: string | null };
          if (
            ctx.path === '/two-factor/disable' &&
            (await isTwoFactorMandatory(user.id, user.platformRole))
          ) {
            throw new APIError('FORBIDDEN', {
              message:
                'Two-step verification is required for your role. To change phones, replace your authenticator instead.',
              code: 'TWO_FACTOR_REQUIRED_FOR_ROLE',
            });
          }
          pendingTwoFactorEvents.set(ctx.context, {
            kind: ctx.path === '/two-factor/disable' ? 'disable' : 'regenerate',
            userId: user.id,
          });
          return;
        }
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
        if (!session) return;
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
        const ref = body.memberId ?? body.memberIdOrEmail;
        let target: { role: string } | null = null;
        if (ref) {
          const userId = ref.includes('@')
            ? ((await ctx.context.internalAdapter.findUserByEmail(ref))?.user.id ?? null)
            : null;
          target = await ctx.context.adapter.findOne<{ role: string }>({
            model: 'member',
            where: userId
              ? [
                  { field: 'organizationId', value: orgId },
                  { field: 'userId', value: userId },
                ]
              : [{ field: 'id', value: ref }],
          });
        }
        if (
          OWNER_GRANTED_ROLES.has(body.role as string) ||
          (target && OWNER_GRANTED_ROLES.has(target.role))
        ) {
          throw new APIError('FORBIDDEN', {
            message: 'Only an Owner can add, remove or change Owners and Admins',
            code: 'OWNER_ONLY_ROLE',
          });
        }
      }),
      // Completes the two-factor events recorded above, only when the endpoint succeeded.
      after: createAuthMiddleware(async (ctx) => {
        const pending = pendingTwoFactorEvents.get(ctx.context);
        if (!pending) return;
        pendingTwoFactorEvents.delete(ctx.context);
        if (isApiErrorLike(ctx.context.returned)) return;
        const newSession = ctx.context.newSession;
        try {
          let event: SecurityEvent;
          let userId: string | null = pending.userId;
          let metadata: Record<string, number> | undefined;
          switch (pending.kind) {
            case 'enrol':
              // Sessions that predate the second factor are ended; only this one survives.
              await authPrisma().session.deleteMany({
                where: {
                  userId: pending.userId,
                  ...(newSession ? { NOT: { token: newSession.session.token } } : {}),
                },
              });
              event = 'user.two_factor_enabled';
              break;
            case 'recovery-code':
              userId ??= newSession?.user.id ?? null;
              event = 'user.recovery_code_used';
              if (userId)
                metadata = { recoveryCodesLeft: (await remainingRecoveryCodesFor(userId)) ?? 0 };
              break;
            case 'regenerate':
              event = 'user.recovery_codes_regenerated';
              break;
            case 'disable':
              event = 'user.two_factor_disabled';
              break;
          }
          if (userId)
            await recordSecurityEvent({ userId, event, ...(metadata ? { metadata } : {}) });
        } catch (err) {
          logger.error(
            { err: err instanceof Error ? err.message : String(err), kind: pending.kind },
            'two-factor security event not recorded',
          );
        }
      }),
    },
    plugins: [
      organization({
        ac,
        roles,
        creatorRole: 'owner',
        allowUserToCreateOrganization: false, // platform provisions orgs (OD-16)
        membershipLimit: 500,
        invitationLimit: 200,
        invitationExpiresIn: INVITATION_TTL_SECONDS,
        cancelPendingInvitationsOnReInvite: true,
        requireEmailVerificationOnInvitation: true, // D3
        teams: { enabled: false }, // teams + leads are ours (ADR-0003)
        schema: {
          organization: {
            additionalFields: {
              status: { type: 'string', required: false, input: false, defaultValue: 'ACTIVE' },
              timeZone: {
                type: 'string',
                required: false,
                input: false,
                defaultValue: 'Asia/Kolkata',
              },
              locale: { type: 'string', required: false, input: false, defaultValue: 'en-IN' },
            },
          },
          member: {
            additionalFields: {
              status: { type: 'string', required: false, input: false, defaultValue: 'ACTIVE' },
            },
          },
          invitation: {
            additionalFields: { teamId: { type: 'string', required: false, input: true } },
          },
        },
        sendInvitationEmail: async (data) => {
          await enqueueEmail(
            {
              template: 'invitation',
              to: data.email,
              params: {
                orgName: data.organization.name,
                inviterName: data.inviter.user.name,
                role: data.role,
                url: `${baseURL}/invite/${data.id}`,
                expiresAt: data.invitation.expiresAt.toLocaleDateString('en-IN', {
                  day: 'numeric',
                  month: 'short',
                  year: 'numeric',
                  timeZone: (data.organization as { timeZone?: string }).timeZone ?? 'Asia/Kolkata',
                }),
              },
            },
            `invitation-${data.id}`,
          );
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
          // The accepting user is the actor: team placement + audit under their org context.
          afterAcceptInvitation: async ({ invitation, member, user }) => {
            const teamId = (invitation as { teamId?: string | null }).teamId ?? null;
            await tenantRunner().withTenant(
              { orgId: member.organizationId, userId: user.id },
              async (tx) => {
                if (teamId) {
                  const team = await tx.team.findFirst({
                    where: { id: teamId, archivedAt: null },
                    select: { id: true },
                  });
                  if (team) {
                    await tx.teamMembership.create({
                      data: {
                        orgId: member.organizationId,
                        teamId: team.id,
                        membershipId: member.id,
                      },
                    });
                  }
                }
                await writeAudit(tx, member.organizationId, {
                  action: 'invitation.accepted',
                  entityType: 'invitation',
                  entityId: invitation.id,
                  actorUserId: user.id,
                  metadata: { role: member.role, teamId },
                });
              },
            );
          },
        },
      }),
      twoFactor({
        issuer: 'CBR Property CRM',
        backupCodeOptions: {
          amount: RECOVERY_CODE_COUNT,
          customBackupCodesGenerate: () => generateRecoveryCodes(),
          // Keyed hashes only; never reversible (recovery-codes.ts).
          storeBackupCodes: hashedRecoveryCodeStorage(env.BETTER_AUTH_SECRET),
        },
      }),
    ],
  });
}

export type Auth = ReturnType<typeof createAuth>;

const g = globalThis as unknown as { __crmAuth?: Auth };

/** Lazily created so that importing modules does not require env at build time. */
export function auth(): Auth {
  g.__crmAuth ??= createAuth();
  return g.__crmAuth;
}
