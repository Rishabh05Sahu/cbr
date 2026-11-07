// Organisations module: org settings (name, time zone, locale) and the phone masking policy
// (FR-060, Owner only). Public API.
import { z } from 'zod';
import { writeAudit } from '@/modules/audit';
import { authorize, can, type RequestContext } from '@/platform/authz';
import { tenantRunner } from '@/platform/db';
import { notFound } from '@/platform/errors';

export interface OrgSettings {
  id: string;
  name: string;
  slug: string;
  timeZone: string;
  locale: string;
  status: string;
}

/** Accepts any IANA zone or alias the runtime knows (ICU lists Asia/Calcutta, not Asia/Kolkata). */
export function isValidTimeZone(tz: string): boolean {
  try {
    new Intl.DateTimeFormat('en-IN', { timeZone: tz });
    return /^[A-Za-z]+\/[A-Za-z_+-]+(\/[A-Za-z_+-]+)?$/.test(tz) || tz === 'UTC';
  } catch {
    return false;
  }
}

export const orgSettingsInput = z.object({
  name: z.string().trim().min(2).max(120),
  timeZone: z.string().max(64).refine(isValidTimeZone, 'Unknown time zone'),
  locale: z.enum(['en-IN']),
});

export async function getOrgSettings(ctx: RequestContext): Promise<OrgSettings> {
  authorize(ctx, 'org.settings.read');
  const org = await tenantRunner().withTenant(ctx.tenant, (tx) =>
    tx.organization.findUnique({
      where: { id: ctx.orgId },
      select: { id: true, name: true, slug: true, timeZone: true, locale: true, status: true },
    }),
  );
  if (!org) throw notFound();
  return org;
}

export async function updateOrgSettings(ctx: RequestContext, raw: unknown): Promise<void> {
  authorize(ctx, 'org.settings.manage');
  const input = orgSettingsInput.parse(raw);
  await tenantRunner().withTenant(ctx.tenant, async (tx) => {
    const before = await tx.organization.findUnique({
      where: { id: ctx.orgId },
      select: { name: true, timeZone: true, locale: true },
    });
    if (!before) throw notFound();
    await tx.organization.update({ where: { id: ctx.orgId }, data: input });
    await writeAudit(tx, ctx.orgId, {
      action: 'organization.settings_updated',
      entityType: 'organization',
      entityId: ctx.orgId,
      actorUserId: ctx.userId,
      metadata: {
        nameChanged: before.name !== input.name,
        timeZone: input.timeZone,
        previousTimeZone: before.timeZone,
      },
    });
  });
}

export interface PhoneMaskingSettings {
  enabled: boolean;
  dailyCap: number;
  /** org.security_policy.manage (Owner only, roles §4.6). */
  canManage: boolean;
}

/**
 * Owner/Admin only (org.settings.manage; owner decision 2026-10-30): other roles see no masking
 * status or reveal limit. Changing them stays Owner-only (canManage).
 */
export async function getPhoneMaskingSettings(ctx: RequestContext): Promise<PhoneMaskingSettings> {
  authorize(ctx, 'org.settings.manage');
  const o = await tenantRunner().withTenant(ctx.tenant, (tx) =>
    tx.organization.findUnique({
      where: { id: ctx.orgId },
      select: { phoneMasking: true, phoneRevealDailyCap: true },
    }),
  );
  if (!o) throw notFound();
  return {
    enabled: o.phoneMasking,
    dailyCap: o.phoneRevealDailyCap,
    canManage: can(ctx, 'org.security_policy.manage'),
  };
}

export const phoneMaskingInput = z.object({
  enabled: z.boolean(),
  dailyCap: z.coerce.number().int().min(1).max(1000),
});

/** FR-060: turn phone masking on or off and set the per-person daily reveal cap (audited). */
export async function updatePhoneMasking(ctx: RequestContext, raw: unknown): Promise<void> {
  authorize(ctx, 'org.security_policy.manage');
  const input = phoneMaskingInput.parse(raw);
  await tenantRunner().withTenant(ctx.tenant, async (tx) => {
    const before = await tx.organization.findUnique({
      where: { id: ctx.orgId },
      select: { phoneMasking: true, phoneRevealDailyCap: true },
    });
    if (!before) throw notFound();
    await tx.organization.update({
      where: { id: ctx.orgId },
      data: { phoneMasking: input.enabled, phoneRevealDailyCap: input.dailyCap },
    });
    await writeAudit(tx, ctx.orgId, {
      action: 'organization.phone_masking_updated',
      entityType: 'organization',
      entityId: ctx.orgId,
      actorUserId: ctx.userId,
      metadata: {
        enabled: input.enabled,
        dailyCap: input.dailyCap,
        previousEnabled: before.phoneMasking,
        previousDailyCap: before.phoneRevealDailyCap,
      },
    });
  });
}
