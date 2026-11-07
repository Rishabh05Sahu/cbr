// Lead-source management (FR-040 source attribution; deferred from M1): Owner/Admin
// (org.settings.manage) add sources so imports and the lead form can name them. Migration 0003
// already enforces the rules in the database: RLS tenant isolation, a 1-100 character name, a
// fixed channel list, and one name per org ignoring case (lead_source_org_name_uq).
//
// - Names are stored normalized (trimmed, inner whitespace collapsed), and a new name is refused
//   if it equals an existing one after the same normalization, so "99 Acres", " 99  acres " and
//   "99 ACRES" are one source. Import matching uses the same key (sourceKey).
// - Create and list only. crm_app has no UPDATE on lead_source (0003), so renaming and
//   deactivating need a separate, owner-approved migration.
import { z } from 'zod';
import { writeAudit } from '@/modules/audit';
import { authorize, type RequestContext } from '@/platform/authz';
import { tenantRunner } from '@/platform/db';
import { conflict } from '@/platform/errors';

export const LEAD_SOURCE_CHANNELS = [
  'PORTAL',
  'SOCIAL_ADS',
  'WEBSITE',
  'REFERRAL',
  'WALK_IN',
  'CHANNEL_PARTNER',
  'COLD',
  'OTHER',
] as const;
export type LeadSourceChannel = (typeof LEAD_SOURCE_CHANNELS)[number];

/** Trimmed, inner whitespace collapsed to one space: the stored form of a source name. */
export const normalizeSourceName = (name: string) => name.trim().replace(/\s+/g, ' ');

/** Comparison key for source names (stored names and import cells alike). */
export const sourceKey = (name: string) => normalizeSourceName(name).toLowerCase();

export interface LeadSourceRow {
  id: string;
  name: string;
  channel: string;
  isActive: boolean;
  createdAt: Date;
}

/** Every source of the org, inactive ones included (settings page). */
export async function listLeadSourcesForSettings(ctx: RequestContext): Promise<LeadSourceRow[]> {
  authorize(ctx, 'org.settings.manage');
  return tenantRunner().withTenant(ctx.tenant, (tx) =>
    tx.leadSource.findMany({
      orderBy: [{ isActive: 'desc' }, { name: 'asc' }],
      select: { id: true, name: true, channel: true, isActive: true, createdAt: true },
    }),
  );
}

const createInput = z.object({
  name: z
    .string()
    .transform(normalizeSourceName)
    .pipe(z.string().min(1, 'Enter a name').max(100, 'At most 100 characters')),
  channel: z.enum(LEAD_SOURCE_CHANNELS, { message: 'Choose a channel' }),
});

const duplicate = (name: string) =>
  conflict(`A lead source named "${name}" already exists (names ignore case and spacing)`);

export async function createLeadSource(ctx: RequestContext, raw: unknown): Promise<{ id: string }> {
  authorize(ctx, 'org.settings.manage');
  const input = createInput.parse(raw);
  const key = sourceKey(input.name);
  try {
    return await tenantRunner().withTenant(ctx.tenant, async (tx) => {
      // Older rows may hold unnormalized names that the case-only unique index would not catch.
      const existing = await tx.leadSource.findMany({ select: { name: true } });
      const clash = existing.find((s) => sourceKey(s.name) === key);
      if (clash) throw duplicate(clash.name);
      const row = await tx.leadSource.create({
        data: { orgId: ctx.orgId, name: input.name, channel: input.channel },
        select: { id: true },
      });
      await writeAudit(tx, ctx.orgId, {
        action: 'lead_source.created',
        entityType: 'lead_source',
        entityId: row.id,
        actorUserId: ctx.userId,
        metadata: { name: input.name, channel: input.channel },
      });
      return row;
    });
  } catch (e) {
    // A concurrent create of the same name loses on the database's unique index.
    const msg = e instanceof Error ? e.message : '';
    if (/lead_source_org_name_uq|Unique constraint/i.test(msg)) throw duplicate(input.name);
    throw e;
  }
}
