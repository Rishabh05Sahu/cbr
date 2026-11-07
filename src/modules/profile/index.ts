// Profile module: a user's own name and mobile number. Email changes are disabled in Phase 1
// (they need re-verification flows); 2FA enrolment uses the auth client directly.
import { z } from 'zod';
import { writeAudit } from '@/modules/audit';
import { authorize, type RequestContext } from '@/platform/authz';
import { tenantRunner } from '@/platform/db';
import { notFound } from '@/platform/errors';

/** Accepts +E.164, or a 10-digit Indian mobile (6–9 leading digit) normalised to +91. */
export function normalisePhone(raw: string): string | null {
  const s = raw.replace(/[\s()-]/g, '');
  if (s === '') return null;
  if (/^[6-9]\d{9}$/.test(s)) return `+91${s}`;
  if (/^0[6-9]\d{9}$/.test(s)) return `+91${s.slice(1)}`;
  if (/^\+[1-9]\d{7,14}$/.test(s)) return s;
  throw new z.ZodError([
    { code: 'custom', path: ['phone'], message: 'Enter a valid mobile number', input: raw },
  ]);
}

export const profileInput = z.object({
  name: z.string().trim().min(2).max(100),
  phone: z.string().trim().max(20).optional().default(''),
});

export interface MyProfile {
  id: string;
  name: string;
  email: string;
  phoneE164: string | null;
  twoFactorEnabled: boolean;
}

export async function getMyProfile(userId: string): Promise<MyProfile> {
  const u = await tenantRunner().withUser(userId, (tx) =>
    tx.user.findUnique({
      where: { id: userId },
      select: { id: true, name: true, email: true, phoneE164: true, twoFactorEnabled: true },
    }),
  );
  if (!u) throw notFound();
  return { ...u, twoFactorEnabled: Boolean(u.twoFactorEnabled) };
}

export async function updateMyProfile(ctx: RequestContext, raw: unknown): Promise<void> {
  authorize(ctx, 'profile.update_own');
  const input = profileInput.parse(raw);
  const phoneE164 = normalisePhone(input.phone);
  await tenantRunner().withTenant(ctx.tenant, async (tx) => {
    // RLS: crm_app may update only its own user row (self_update policy).
    const res = await tx.user.updateMany({
      where: { id: ctx.userId },
      data: { name: input.name, phoneE164 },
    });
    if (res.count !== 1) throw notFound();
    await writeAudit(tx, ctx.orgId, {
      action: 'user.profile_updated',
      entityType: 'user',
      entityId: ctx.userId,
      actorUserId: ctx.userId,
      metadata: { phoneSet: phoneE164 !== null },
    });
  });
}
