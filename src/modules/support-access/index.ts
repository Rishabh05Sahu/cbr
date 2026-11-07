// Support access (roles §3): platform staff request, the org Owner approves/revokes.
// Access while active is read-only and audited on every request (see platform/auth/context).
import { z } from 'zod';
import { writeAudit } from '@/modules/audit';
import { authorize, type RequestContext } from '@/platform/authz';
import { tenantRunner } from '@/platform/db';
import { notFound } from '@/platform/errors';

export interface GrantView {
  id: string;
  platformUserId: string;
  reason: string;
  accessLevel: string;
  approved: boolean;
  startsAt: Date;
  expiresAt: Date;
  revokedAt: Date | null;
  createdAt: Date;
}

export async function listGrants(ctx: RequestContext): Promise<GrantView[]> {
  authorize(ctx, 'support_access.approve');
  const rows = await tenantRunner().withTenant(ctx.tenant, (tx) =>
    tx.supportAccessGrant.findMany({ orderBy: { createdAt: 'desc' }, take: 100 }),
  );
  return rows.map((r) => ({
    id: r.id,
    platformUserId: r.platformUserId,
    reason: r.reason,
    accessLevel: r.accessLevel,
    approved: r.approvedByUserId !== null,
    startsAt: r.startsAt,
    expiresAt: r.expiresAt,
    revokedAt: r.revokedAt,
    createdAt: r.createdAt,
  }));
}

export async function approveGrant(ctx: RequestContext, grantId: string): Promise<void> {
  authorize(ctx, 'support_access.approve');
  const id = z.uuid().parse(grantId);
  await tenantRunner().withTenant(ctx.tenant, async (tx) => {
    const res = await tx.supportAccessGrant.updateMany({
      where: { id, approvedByUserId: null, revokedAt: null, expiresAt: { gt: new Date() } },
      data: { approvedByUserId: ctx.userId },
    });
    if (res.count !== 1) throw notFound('No pending grant to approve');
    await writeAudit(tx, ctx.orgId, {
      action: 'support_access.approved',
      entityType: 'support_access_grant',
      entityId: id,
      actorUserId: ctx.userId,
    });
  });
}

export async function revokeGrant(ctx: RequestContext, grantId: string): Promise<void> {
  authorize(ctx, 'support_access.approve');
  const id = z.uuid().parse(grantId);
  await tenantRunner().withTenant(ctx.tenant, async (tx) => {
    const res = await tx.supportAccessGrant.updateMany({
      where: { id, revokedAt: null },
      data: { revokedAt: new Date() },
    });
    if (res.count !== 1) throw notFound('Grant not found');
    await writeAudit(tx, ctx.orgId, {
      action: 'support_access.revoked',
      entityType: 'support_access_grant',
      entityId: id,
      actorUserId: ctx.userId,
    });
  });
}
