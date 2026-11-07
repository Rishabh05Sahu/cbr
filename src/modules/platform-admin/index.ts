// Platform console (roles §3): org provisioning and suspension, support-grant requests,
// platform audit. Runs as crm_platform; never reads tenant PII.
import { randomUUID } from 'node:crypto';
import { z } from 'zod';
import type { SessionUser } from '@/platform/auth/context';
import { provisionOrganization } from '@/platform/auth/org-admin';
import { setSupportOrganization } from '@/platform/auth/platform-session';
import { platformResetTwoFactor, twoFactorRequired } from '@/platform/auth/two-factor';
import { platformPrisma } from '@/platform/db/client';
import { forbidden, notFound } from '@/platform/errors';

export function assertPlatformAdmin(user: SessionUser | null): asserts user is SessionUser {
  if (!user || user.platformRole !== 'PLATFORM_ADMIN') throw forbidden('Platform staff only');
  if (!user.twoFactorEnabled) throw twoFactorRequired(); // item D
}

async function platformAudit(
  actor: SessionUser,
  action: string,
  entityType: string,
  entityId: string | null,
  metadata?: Record<string, string>,
) {
  await platformPrisma().auditLog.create({
    data: {
      actorUserId: actor.id,
      actorKind: 'PLATFORM',
      action,
      entityType,
      entityId,
      ...(metadata ? { metadata } : {}),
    },
  });
}

export interface OrgOverview {
  orgId: string;
  name: string;
  status: string;
  createdAt: Date;
  activeMembers: number;
}

export async function listOrganizations(actor: SessionUser | null): Promise<OrgOverview[]> {
  assertPlatformAdmin(actor);
  const rows = await platformPrisma().$queryRaw<
    { org_id: string; name: string; status: string; created_at: Date; active_members: bigint }[]
  >`SELECT * FROM app.platform_org_overview()`;
  return rows.map((r) => ({
    orgId: r.org_id,
    name: r.name,
    status: r.status,
    createdAt: r.created_at,
    activeMembers: Number(r.active_members),
  }));
}

export const createOrgInput = z.object({
  name: z.string().trim().min(2).max(120),
  ownerName: z.string().trim().min(2).max(100),
  ownerEmail: z.email().trim().toLowerCase().max(254),
});

function slugify(name: string): string {
  const base =
    name
      .toLowerCase()
      .replace(/[^a-z0-9]+/g, '-')
      .replace(/^-|-$/g, '')
      .slice(0, 40) || 'org';
  return `${base}-${randomUUID().slice(0, 6)}`;
}

export async function createOrganization(actor: SessionUser | null, raw: unknown, appUrl: string) {
  assertPlatformAdmin(actor);
  const input = createOrgInput.parse(raw);
  const result = await provisionOrganization({
    platformUserId: actor.id,
    name: input.name,
    slug: slugify(input.name),
    ownerEmail: input.ownerEmail,
    ownerName: input.ownerName,
    appUrl,
  });
  await platformAudit(actor, 'organization.created', 'organization', result.orgId, {
    ownerUserId: result.ownerUserId,
    ownerAccountCreated: String(result.ownerCreated),
  });
  return result;
}

export async function setOrganizationStatus(
  actor: SessionUser | null,
  orgId: string,
  status: unknown,
) {
  assertPlatformAdmin(actor);
  const id = z.uuid().parse(orgId);
  const next = z.enum(['ACTIVE', 'SUSPENDED']).parse(status);
  const res = await platformPrisma().organization.updateMany({
    where: { id },
    data: { status: next },
  });
  if (res.count !== 1) throw notFound('Organisation not found');
  await platformAudit(
    actor,
    next === 'SUSPENDED' ? 'organization.suspended' : 'organization.reactivated',
    'organization',
    id,
  );
}

export const grantRequestInput = z.object({
  orgId: z.uuid(),
  reason: z.string().trim().min(10).max(500),
  hours: z.coerce.number().int().min(1).max(72),
});

export async function requestSupportGrant(actor: SessionUser | null, raw: unknown) {
  assertPlatformAdmin(actor);
  const input = grantRequestInput.parse(raw);
  const now = new Date();
  const grant = await platformPrisma().supportAccessGrant.create({
    data: {
      orgId: input.orgId,
      platformUserId: actor.id,
      reason: input.reason,
      accessLevel: 'READ',
      startsAt: now,
      expiresAt: new Date(now.getTime() + input.hours * 3_600_000),
    },
    select: { id: true },
  });
  await platformAudit(actor, 'support_access.requested', 'support_access_grant', grant.id, {
    orgId: input.orgId,
  });
  return grant;
}

/** Opens an org in the platform user's session; access still requires an active grant. */
export async function openOrgForSupport(
  actor: SessionUser | null,
  headers: Headers,
  orgId: string,
) {
  assertPlatformAdmin(actor);
  const id = z.uuid().parse(orgId);
  await setSupportOrganization(headers, actor.id, id);
}

export async function listPlatformAudit(actor: SessionUser | null) {
  assertPlatformAdmin(actor);
  return platformPrisma().auditLog.findMany({
    orderBy: [{ occurredAt: 'desc' }, { id: 'desc' }],
    take: 100,
    select: {
      id: true,
      action: true,
      entityType: true,
      entityId: true,
      actorUserId: true,
      metadata: true,
      occurredAt: true,
    },
  });
}

export const twoFactorResetInput = z.object({
  email: z.email().trim().toLowerCase().max(254),
  reason: z.string().trim().min(10).max(500),
  verificationReference: z.string().trim().min(3).max(120),
});

/**
 * Lost authenticator and recovery codes: reset only after the identity checks in
 * docs/runbooks/two-factor-recovery.md. The user must then reset their password by email
 * and enrol a new authenticator; nothing here grants access.
 */
export async function resetUserTwoFactor(actor: SessionUser | null, raw: unknown, appUrl: string) {
  assertPlatformAdmin(actor);
  const input = twoFactorResetInput.parse(raw);
  return platformResetTwoFactor({
    platformUserId: actor.id,
    targetEmail: input.email,
    reason: input.reason,
    verificationReference: input.verificationReference,
    appUrl,
  });
}
