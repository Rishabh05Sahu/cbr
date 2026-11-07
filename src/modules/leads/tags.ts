// Lead tags (FR-063 "add tag", migration 0011, OD-05 default): organisation-defined labels.
// Owner/Admin create tags (org.settings.manage); bulk "add tag" is Owner/Admin
// (lead.bulk_update, with lead.update in scope), like bulk archive. Labels only: no stage, owner
// or report changes. Adding is idempotent (the (lead, tag) primary key); no remove or rename yet.
import { z } from 'zod';
import { writeAudit } from '@/modules/audit';
import { authorize, type RequestContext } from '@/platform/authz';
import { tenantRunner } from '@/platform/db';
import { conflict, DomainError, notFound, ruleViolation } from '@/platform/errors';
import { scopeFilter } from './access';
import { normalizeSourceName, sourceKey } from './source-commands';

export const MAX_TAGS_PER_ORG = 200;
const MAX_BATCH = 100;

export interface LeadTagView {
  id: string;
  name: string;
}

/** The org's tags (forms and settings). Any member who can read leads sees the labels. */
export async function listLeadTags(ctx: RequestContext): Promise<LeadTagView[]> {
  authorize(ctx, 'lead.read');
  return tenantRunner().withTenant(ctx.tenant, (tx) =>
    tx.leadTag.findMany({ orderBy: { name: 'asc' }, select: { id: true, name: true } }),
  );
}

const createInput = z.object({
  name: z
    .string()
    .transform(normalizeSourceName)
    .pipe(z.string().min(1, 'Enter a name').max(50, 'At most 50 characters')),
});

const duplicate = (name: string) =>
  conflict(`A tag named "${name}" already exists (names ignore case and spacing)`);

export async function createLeadTag(ctx: RequestContext, raw: unknown): Promise<{ id: string }> {
  authorize(ctx, 'org.settings.manage');
  const { name } = createInput.parse(raw);
  try {
    return await tenantRunner().withTenant(ctx.tenant, async (tx) => {
      const existing = await tx.leadTag.findMany({ select: { name: true } });
      if (existing.length >= MAX_TAGS_PER_ORG)
        throw ruleViolation(`An organisation can have at most ${MAX_TAGS_PER_ORG} tags`);
      const clash = existing.find((t) => sourceKey(t.name) === sourceKey(name));
      if (clash) throw duplicate(clash.name);
      const row = await tx.leadTag.create({
        data: { orgId: ctx.orgId, name, createdBy: ctx.userId },
        select: { id: true },
      });
      await writeAudit(tx, ctx.orgId, {
        action: 'lead_tag.created',
        entityType: 'lead_tag',
        entityId: row.id,
        actorUserId: ctx.userId,
        metadata: { name },
      });
      return row;
    });
  } catch (e) {
    const msg = e instanceof Error ? e.message : '';
    if (/lead_tag_org_name_uq|Unique constraint/i.test(msg)) throw duplicate(name);
    throw e;
  }
}

const bulkTagInput = z.object({
  leadIds: z.array(z.uuid()).min(1, 'Select at least one lead').max(MAX_BATCH),
  tagId: z.uuid({ message: 'Choose a tag' }),
});

/**
 * FR-063 bulk "add tag" (selection up to 100). Every selected lead must be in the caller's
 * scope and writable (not archived or merged), or nothing is tagged. Leads that already have the
 * tag are left as they are and counted. One audit entry with the item list; no lead contents.
 */
export async function bulkAddTag(
  ctx: RequestContext,
  raw: unknown,
): Promise<{ added: number; alreadyTagged: number }> {
  authorize(ctx, 'lead.bulk_update');
  const scope = authorize(ctx, 'lead.update');
  const input = bulkTagInput.parse(raw);
  const ids = [...new Set(input.leadIds.map((i) => i.toLowerCase()))].sort();
  return tenantRunner().withTenant(ctx.tenant, async (tx) => {
    const tag = await tx.leadTag.findFirst({
      where: { id: input.tagId.toLowerCase() },
      select: { id: true, name: true },
    });
    if (!tag) throw notFound('Tag not found');
    const rows = await tx.lead.findMany({
      where: { AND: [{ id: { in: ids } }, await scopeFilter(tx, ctx, scope)] },
      select: { id: true, archivedAt: true, mergedIntoLeadId: true },
    });
    if (rows.length !== ids.length) throw notFound('One or more selected leads were not found');
    const ineligible = rows.filter((r) => r.archivedAt || r.mergedIntoLeadId).map((r) => r.id);
    if (ineligible.length)
      throw new DomainError(
        'RULE_VIOLATION',
        `${ineligible.length} selected ${ineligible.length === 1 ? 'lead is' : 'leads are'} archived or merged; nothing was tagged`,
        { leadIds: ineligible },
      );
    const created = await tx.leadTagLink.createMany({
      data: ids.map((leadId) => ({ orgId: ctx.orgId, leadId, tagId: tag.id, addedBy: ctx.userId })),
      skipDuplicates: true, // already tagged: (lead_id, tag_id) is the primary key
    });
    if (created.count)
      await writeAudit(tx, ctx.orgId, {
        action: 'lead.bulk_tagged',
        entityType: 'lead',
        actorUserId: ctx.userId,
        metadata: { count: created.count, leadIds: ids.join(','), tagId: tag.id, tag: tag.name },
      });
    return { added: created.count, alreadyTagged: ids.length - created.count };
  });
}

/** Tags on one lead (lead page). The caller must be able to read the lead. */
export async function tagsForLead(ctx: RequestContext, leadId: string): Promise<LeadTagView[]> {
  const scope = authorize(ctx, 'lead.read');
  const id = z.uuid().safeParse(leadId);
  if (!id.success) throw notFound('Lead not found');
  return tenantRunner().withTenant(ctx.tenant, async (tx) => {
    const lead = await tx.lead.findFirst({
      where: { AND: [{ id: id.data }, await scopeFilter(tx, ctx, scope)] },
      select: { id: true },
    });
    if (!lead) throw notFound('Lead not found');
    return (
      await tx.leadTagLink.findMany({
        where: { leadId: id.data },
        select: { tag: { select: { id: true, name: true } } },
        orderBy: { tag: { name: 'asc' } },
      })
    ).map((l) => l.tag);
  });
}
