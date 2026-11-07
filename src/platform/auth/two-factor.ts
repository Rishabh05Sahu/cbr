// Two-step verification operations (owner decision 2026-10-20, item D): status, self-service
// authenticator replacement and the platform-assisted reset for a lost authenticator.
// Policy and security events: ./two-factor-policy.ts.
import { randomBytes } from 'node:crypto';
import { authPrisma } from '@/platform/db/client';
import { forbidden, notFound, unauthenticated } from '@/platform/errors';
import { enforce } from '@/platform/rate-limit';
import { auth } from './auth';
import { remainingRecoveryCodes } from './recovery-codes';
import { isTwoFactorMandatory, recordSecurityEvent } from './two-factor-policy';

export {
  MANDATORY_TWO_FACTOR_ROLES,
  isTwoFactorMandatory,
  twoFactorRequired,
} from './two-factor-policy';

export interface TwoFactorStatus {
  enabled: boolean;
  mandatory: boolean;
  /** Unused recovery codes; null when 2FA is off or the stored value is unreadable. */
  recoveryCodesLeft: number | null;
}

export async function twoFactorStatus(
  userId: string,
  platformRole: string | null,
): Promise<TwoFactorStatus> {
  const [user, row, mandatory] = await Promise.all([
    authPrisma().user.findUnique({ where: { id: userId }, select: { twoFactorEnabled: true } }),
    authPrisma().twoFactor.findFirst({
      where: { userId, verified: true },
      select: { backupCodes: true },
    }),
    isTwoFactorMandatory(userId, platformRole),
  ]);
  const enabled = Boolean(user?.twoFactorEnabled) && Boolean(row);
  return {
    enabled,
    mandatory,
    recoveryCodesLeft: enabled ? remainingRecoveryCodes(row?.backupCodes) : null,
  };
}

const AUTHENTICATOR_RESET_RULE = { window: 900, max: 5 };

/**
 * Lost or replaced phone, self-service: the signed-in user proves both their password and a
 * second factor (a current authenticator code or an unused recovery code, which is consumed).
 * The old authenticator and remaining recovery codes are removed; the user must enrol a new
 * authenticator before they can open an org that requires it. Rate-limited per user, because
 * the library does not count failed second-factor attempts made from an existing session.
 */
export async function resetOwnAuthenticator(
  headers: Headers,
  input: { password: string; code: string },
): Promise<void> {
  const session = await auth().api.getSession({ headers });
  if (!session) throw unauthenticated();
  const userId = session.user.id;
  await enforce(`2fa-reset:${userId}`, AUTHENTICATOR_RESET_RULE);
  if (!session.user.twoFactorEnabled) throw forbidden('Two-step verification is not turned on');

  const ctx = await auth().$context;
  const account = await authPrisma().account.findFirst({
    where: { userId, providerId: 'credential' },
    select: { password: true },
  });
  const passwordOk =
    !!account?.password &&
    (await ctx.password.verify({ hash: account.password, password: input.password }));
  if (!passwordOk) throw forbidden('Password or code is incorrect');

  const code = input.code.trim();
  try {
    if (/^\d{6}$/.test(code)) {
      await auth().api.verifyTOTP({ headers, body: { code } });
    } else {
      await auth().api.verifyBackupCode({ headers, body: { code, disableSession: true } });
    }
  } catch {
    throw forbidden('Password or code is incorrect');
  }

  await authPrisma().$transaction([
    authPrisma().twoFactor.deleteMany({ where: { userId } }),
    authPrisma().user.update({ where: { id: userId }, data: { twoFactorEnabled: false } }),
  ]);
  await recordSecurityEvent({ userId, event: 'user.authenticator_reset' });
}

/**
 * Platform-assisted reset when a user has lost both the authenticator and the recovery codes.
 * Only after the identity checks in the runbook (docs/runbooks/two-factor-recovery.md). It
 * does NOT grant access: every session is revoked, the current password is replaced by an
 * unusable one, and the user must prove control of their email (password-reset link) and
 * then enrol a new authenticator before they can open an org that requires it.
 */
export async function platformResetTwoFactor(input: {
  platformUserId: string;
  targetEmail: string;
  reason: string;
  verificationReference: string;
  appUrl: string;
}): Promise<{ userId: string }> {
  const target = await authPrisma().user.findUnique({
    where: { email: input.targetEmail.toLowerCase() },
    select: { id: true, email: true },
  });
  if (!target) throw notFound('User not found');
  if (target.id === input.platformUserId)
    throw forbidden('Another platform administrator must reset your two-step verification');

  const ctx = await auth().$context;
  const unusable = await ctx.password.hash(randomBytes(32).toString('base64url'));
  await authPrisma().$transaction([
    authPrisma().twoFactor.deleteMany({ where: { userId: target.id } }),
    authPrisma().user.update({ where: { id: target.id }, data: { twoFactorEnabled: false } }),
    authPrisma().account.updateMany({
      where: { userId: target.id, providerId: 'credential' },
      data: { password: unusable },
    }),
    authPrisma().session.deleteMany({ where: { userId: target.id } }),
  ]);
  await recordSecurityEvent({
    userId: target.id,
    event: 'user.two_factor_reset_by_platform',
    actorUserId: input.platformUserId,
    actorKind: 'PLATFORM',
    metadata: { reason: input.reason, verificationReference: input.verificationReference },
  });
  await auth().api.requestPasswordReset({
    body: { email: target.email, redirectTo: `${input.appUrl}/reset-password` },
  });
  return { userId: target.id };
}
