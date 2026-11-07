// Two-step verification policy and security events (owner decision 2026-10-20, item D).
// Kept free of the auth instance so the auth configuration's hooks can use it.
import { writeAudit } from '@/modules/audit';
import { authPrisma, platformPrisma } from '@/platform/db/client';
import { tenantRunner } from '@/platform/db';
import { DomainError } from '@/platform/errors';
import { enqueueEmail } from '@/platform/queue';
import { remainingRecoveryCodes } from './recovery-codes';
import type { PluginRole } from './roles';

/** Roles whose members must use an authenticator app before they can open the org. */
export const MANDATORY_TWO_FACTOR_ROLES: ReadonlySet<string> = new Set<PluginRole>([
  'owner',
  'admin',
]);

export const twoFactorRequired = () =>
  new DomainError(
    'TWO_FACTOR_REQUIRED',
    'Set up two-step verification with an authenticator app to continue',
  );

interface MembershipRow {
  org_id: string;
  role_code: string;
  status: string;
}

async function activeMemberships(userId: string): Promise<MembershipRow[]> {
  const rows = await tenantRunner().withUser(
    userId,
    (tx) =>
      tx.$queryRaw<MembershipRow[]>`
      SELECT org_id, role_code, status FROM app.auth_memberships_for_user(${userId}::uuid)`,
  );
  return rows.filter((r) => r.status === 'ACTIVE');
}

/** True when any active membership or platform role makes 2FA mandatory for this user. */
export async function isTwoFactorMandatory(
  userId: string,
  platformRole: string | null | undefined,
): Promise<boolean> {
  if (platformRole === 'PLATFORM_ADMIN') return true;
  return (await activeMemberships(userId)).some((m) => MANDATORY_TWO_FACTOR_ROLES.has(m.role_code));
}

export type SecurityEvent =
  | 'user.two_factor_enabled'
  | 'user.two_factor_disabled'
  | 'user.recovery_code_used'
  | 'user.recovery_codes_regenerated'
  | 'user.authenticator_reset'
  | 'user.two_factor_reset_by_platform';

const NOTICE: Record<SecurityEvent, string> = {
  'user.two_factor_enabled': 'Two-step verification was turned on for your account.',
  'user.two_factor_disabled': 'Two-step verification was turned off for your account.',
  'user.recovery_code_used': 'A recovery code was used to sign in to your account.',
  'user.recovery_codes_regenerated':
    'New recovery codes were generated for your account. Your old codes no longer work.',
  'user.authenticator_reset':
    'The authenticator app for your account was removed so that a new one can be set up.',
  'user.two_factor_reset_by_platform':
    'CBR support reset two-step verification on your account after verifying your identity. You must choose a new password and set up two-step verification again.',
};

/**
 * Audits a user-level security event in every organisation where the user is an active
 * member (so Owners can see it), and in the platform log for platform staff; then emails the
 * user. Metadata must be display-safe (no codes, secrets or URLs).
 */
export async function recordSecurityEvent(input: {
  userId: string;
  event: SecurityEvent;
  actorUserId?: string;
  actorKind?: 'USER' | 'PLATFORM';
  metadata?: Record<string, string | number | boolean | null>;
}): Promise<void> {
  const user = await authPrisma().user.findUnique({
    where: { id: input.userId },
    select: { id: true, email: true, name: true, platformRole: true },
  });
  if (!user) return;
  const actorUserId = input.actorUserId ?? user.id;
  const entry = {
    action: input.event,
    entityType: 'user',
    entityId: user.id,
    actorUserId,
    actorKind: input.actorKind ?? 'USER',
    ...(input.metadata ? { metadata: input.metadata } : {}),
  } as const;
  for (const m of await activeMemberships(user.id)) {
    await tenantRunner().withTenant({ orgId: m.org_id, userId: user.id }, (tx) =>
      writeAudit(tx, m.org_id, entry),
    );
  }
  if (user.platformRole === 'PLATFORM_ADMIN' || input.actorKind === 'PLATFORM') {
    await platformPrisma().auditLog.create({
      data: {
        actorUserId,
        actorKind: input.actorKind ?? 'USER',
        action: input.event,
        entityType: 'user',
        entityId: user.id,
        ...(input.metadata ? { metadata: input.metadata } : {}),
      },
    });
  }
  await enqueueEmail({
    template: 'security-notice',
    to: user.email,
    params: { name: user.name, notice: NOTICE[input.event] },
  });
}

/** Unused recovery codes for a user with a verified authenticator (null otherwise). */
export async function remainingRecoveryCodesFor(userId: string): Promise<number | null> {
  const row = await authPrisma().twoFactor.findFirst({
    where: { userId, verified: true },
    select: { backupCodes: true },
  });
  return remainingRecoveryCodes(row?.backupCodes);
}
