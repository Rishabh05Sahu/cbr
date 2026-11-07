// Lead hygiene commands (Phase 2 M5): archive / restore (FR-061) and the duplicate review queue
// (lead-lifecycle §5; owner decision D2 of 2026-10-24). Migration 0006 enforces the same rules in
// the database: archive time = transaction time (lead_hygiene_guard), cases start OPEN and are
// resolved once by the session user at the transaction time (first_state_open,
// resolver_is_session_user), and a recorded outcome must be true (duplicate_match_guard).
//
// - Archived leads are read-only until restored (assertWritable). They still count for duplicate
//   checks, so a returning customer is never created twice.
// - An enquiry that matches an archived lead is attached to it, the lead STAYS archived, and one
//   ARCHIVED_ENQUIRY case is opened; only an explicit restore / keep-archived decision closes it.
// - Resolutions are conditional updates on status = 'OPEN': a concurrent second resolver updates
//   nothing and gets a conflict, never a second resolution.
import { z } from 'zod';
import { writeAudit } from '@/modules/audit';
import { authorize, can, type RequestContext, type Scope } from '@/platform/authz';
import { tenantRunner, type Prisma, type Tx } from '@/platform/db';
import { conflict, DomainError, forbidden, notFound, ruleViolation } from '@/platform/errors';
import { cleanText, parseId, scopeFilter, staleVersion } from './access';
import {
  decisionOutcome,
  ReviewRefused,
  routeMatchedEnquiry,
  type CaseStatus,
  type MatchType,
  type ReviewDecision,
} from './duplicate-review';
import { opt, text } from './input';

const versionOnly = z.object({ version: z.coerce.number().int().min(1) });
const archiveInput = versionOnly.extend({ reason: opt(text(500)) });

/** Archive (FR-061): Owner/Admin. The lead keeps its owner, history and duplicate protection. */
export async function archiveLead(
  ctx: RequestContext,
  leadId: string,
  raw: unknown,
): Promise<void> {
  const scope = authorize(ctx, 'lead.archive');
  const id = parseId(leadId);
  const input = archiveInput.parse(raw);
  const reason = input.reason ? cleanText(input.reason) || null : null;
  await tenantRunner().withTenant(ctx.tenant, async (tx) => {
    const lead = await loadLead(tx, ctx, scope, id);
    if (lead.mergedIntoLeadId) throw ruleViolation('This lead was merged into another lead');
    if (lead.archivedAt) throw conflict('This lead is already archived');
    if (lead.version !== input.version) throw staleVersion();
    // archived_at must be the transaction time (lead_hygiene_guard), so the database sets it.
    const n = await tx.$executeRaw`
      UPDATE lead SET archived_at = now(), version = version + 1, updated_at = now()
       WHERE id = ${id}::uuid AND version = ${input.version}
         AND archived_at IS NULL AND merged_into_lead_id IS NULL`;
    if (n !== 1) throw staleVersion();
    await tx.leadActivity.create({
      data: {
        orgId: ctx.orgId,
        leadId: id,
        type: 'ARCHIVED',
        actorId: ctx.userId,
        summary: reason ? { reason } : {},
      },
    });
    await writeAudit(tx, ctx.orgId, {
      action: 'lead.archived',
      entityType: 'lead',
      entityId: id,
      actorUserId: ctx.userId,
      metadata: { stage: lead.stage },
    });
  });
}

/** Restore (FR-061): Owner/Admin. Also closes the lead's open archived-enquiry case as RESTORED. */
export async function restoreLead(
  ctx: RequestContext,
  leadId: string,
  raw: unknown,
): Promise<void> {
  const scope = authorize(ctx, 'lead.archive');
  const id = parseId(leadId);
  const input = versionOnly.parse(raw);
  await tenantRunner().withTenant(ctx.tenant, async (tx) => {
    const lead = await loadLead(tx, ctx, scope, id);
    if (lead.mergedIntoLeadId) throw ruleViolation('This lead was merged into another lead');
    if (!lead.archivedAt) throw conflict('This lead is not archived');
    if (lead.version !== input.version) throw staleVersion();
    await unarchive(tx, ctx, id, input.version);
    const closed = await tx.$executeRaw`
      UPDATE lead_duplicate_match
         SET status = 'RESTORED', resolved_by = ${ctx.userId}::uuid, resolved_at = now()
       WHERE lead_id = ${id}::uuid AND match_type = 'ARCHIVED_ENQUIRY' AND status = 'OPEN'`;
    await writeAudit(tx, ctx.orgId, {
      action: 'lead.restored',
      entityType: 'lead',
      entityId: id,
      actorUserId: ctx.userId,
      metadata: { closedReviewCases: closed },
    });
  });
}

async function unarchive(tx: Tx, ctx: RequestContext, id: string, version: number | null) {
  const n =
    version === null
      ? await tx.$executeRaw`
          UPDATE lead SET archived_at = NULL, version = version + 1, updated_at = now()
           WHERE id = ${id}::uuid AND archived_at IS NOT NULL AND merged_into_lead_id IS NULL`
      : await tx.$executeRaw`
          UPDATE lead SET archived_at = NULL, version = version + 1, updated_at = now()
           WHERE id = ${id}::uuid AND version = ${version}
             AND archived_at IS NOT NULL AND merged_into_lead_id IS NULL`;
  if (n !== 1)
    throw version === null ? conflict('This lead is no longer archived') : staleVersion();
  await tx.leadActivity.create({
    data: { orgId: ctx.orgId, leadId: id, type: 'RESTORED', actorId: ctx.userId, summary: {} },
  });
}

async function loadLead(tx: Tx, ctx: RequestContext, scope: Scope, id: string) {
  const lead = await tx.lead.findFirst({
    where: { AND: [{ id }, await scopeFilter(tx, ctx, scope)] },
    select: { id: true, version: true, stage: true, archivedAt: true, mergedIntoLeadId: true },
  });
  if (!lead) throw notFound('Lead not found');
  return lead;
}

// ---------------------------------------------------------------------------------------------
// Enquiries for archived leads (D2)

/**
 * Called by every path that attaches an enquiry to a phone-matched or chosen lead (manual attach,
 * reported duplicate, import), inside the same transaction, after the enquiry row exists. An
 * archived lead stays archived; one review case is opened for it (later enquiries wait with the
 * open case). Concurrent openers are safe: the partial unique index lets only one case exist and
 * ON CONFLICT DO NOTHING turns the loser into a no-op.
 */
export async function routeEnquiryForArchivedLead(
  tx: Tx,
  ctx: RequestContext,
  lead: { id: string; archivedAt: Date | null },
  enquiryId: string,
): Promise<boolean> {
  if (!lead.archivedAt) return false;
  const open = await tx.leadDuplicateMatch.findFirst({
    where: { leadId: lead.id, matchType: 'ARCHIVED_ENQUIRY', status: 'OPEN' },
    select: { id: true },
  });
  if (!routeMatchedEnquiry(lead, !!open).openCase) return false;
  const n = await tx.$executeRaw`
    INSERT INTO lead_duplicate_match (org_id, match_type, lead_id, enquiry_id, detected_by)
    VALUES (${ctx.orgId}::uuid, 'ARCHIVED_ENQUIRY', ${lead.id}::uuid, ${enquiryId}::uuid,
            ${ctx.kind === 'member' ? ctx.userId : null}::uuid)
    ON CONFLICT DO NOTHING`;
  return n === 1;
}

// ---------------------------------------------------------------------------------------------
// Review queue

export interface DuplicateCase {
  id: string;
  matchType: MatchType;
  status: CaseStatus;
  leadId: string;
  candidateLeadId: string | null;
  enquiryId: string | null;
  createdAt: Date;
  resolvedAt: Date | null;
  /** Names of the leads the case names (both are in the caller's scope by construction). */
  leadName: string;
  leadArchived: boolean;
  candidateName: string | null;
}

/** Who may see the queue: anyone who may decide one of its case types. */
function reviewScope(ctx: RequestContext) {
  const merge = can(ctx, 'lead.merge') ? authorize(ctx, 'lead.merge') : null;
  const archive = can(ctx, 'lead.archive') ? authorize(ctx, 'lead.archive') : null;
  if (!merge && !archive) throw forbidden();
  return { merge, archive };
}

/** Case visibility: every lead the case names must be visible in the deciding permission's scope. */
async function caseFilter(
  tx: Tx,
  ctx: RequestContext,
): Promise<Prisma.LeadDuplicateMatchWhereInput> {
  const { merge, archive } = reviewScope(ctx);
  const or: Prisma.LeadDuplicateMatchWhereInput[] = [];
  if (merge) {
    const leads = await scopeFilter(tx, ctx, merge);
    or.push({
      matchType: { not: 'ARCHIVED_ENQUIRY' },
      lead: leads,
      candidate: leads,
    });
  }
  if (archive)
    or.push({ matchType: 'ARCHIVED_ENQUIRY', lead: await scopeFilter(tx, ctx, archive) });
  return { OR: or };
}

const listInput = z.object({
  status: z.enum(['OPEN', 'RESOLVED']).default('OPEN'),
  /** One case only (still filtered by the caller's scope), e.g. after a concurrent decision. */
  caseId: z.uuid().optional(),
});

export async function listDuplicateCases(
  ctx: RequestContext,
  raw: unknown = {},
): Promise<DuplicateCase[]> {
  const input = listInput.parse(raw);
  return tenantRunner().withTenant(ctx.tenant, async (tx) => {
    const rows = await tx.leadDuplicateMatch.findMany({
      where: {
        AND: [
          await caseFilter(tx, ctx),
          input.status === 'OPEN' ? { status: 'OPEN' } : { status: { not: 'OPEN' } },
          ...(input.caseId ? [{ id: input.caseId }] : []),
        ],
      },
      orderBy: [{ createdAt: 'desc' }, { id: 'desc' }],
      take: 200,
      select: {
        id: true,
        matchType: true,
        status: true,
        leadId: true,
        candidateLeadId: true,
        enquiryId: true,
        createdAt: true,
        resolvedAt: true,
        lead: { select: { fullName: true, archivedAt: true } },
        candidate: { select: { fullName: true } },
      },
    });
    return rows.map(({ lead, candidate, ...r }) => ({
      ...r,
      matchType: r.matchType as MatchType,
      status: r.status as CaseStatus,
      leadName: lead.fullName,
      leadArchived: lead.archivedAt !== null,
      candidateName: candidate?.fullName ?? null,
    }));
  });
}

const resolveInput = z.object({
  decision: z.enum(['dismiss', 'restore', 'keep_archived']),
});

/**
 * Resolves one case. Merging is not a decision here: it is the merge command (preview, explicit
 * conflict choices), which closes the pair as MERGED in its own transaction.
 */
export async function resolveDuplicateCase(
  ctx: RequestContext,
  caseId: string,
  raw: unknown,
): Promise<{ status: CaseStatus }> {
  const id = parseId(caseId, 'Review case');
  const { decision } = resolveInput.parse(raw);
  reviewScope(ctx);
  return tenantRunner().withTenant(ctx.tenant, async (tx) => {
    const row = await tx.leadDuplicateMatch.findFirst({
      where: { AND: [{ id }, await caseFilter(tx, ctx)] },
      select: { id: true, matchType: true, status: true, leadId: true },
    });
    if (!row) throw notFound('Review case not found');
    let outcome: { status: CaseStatus; permission: 'lead.merge' | 'lead.archive' };
    try {
      outcome = decisionOutcome(
        row.matchType as MatchType,
        row.status as CaseStatus,
        decision as ReviewDecision,
      ) as typeof outcome;
    } catch (e) {
      if (e instanceof ReviewRefused)
        throw e.code === 'ALREADY_RESOLVED'
          ? conflict('This case was already resolved')
          : ruleViolation('This decision does not apply to this case');
      throw e;
    }
    authorize(ctx, outcome.permission);
    if (decision === 'restore') await unarchive(tx, ctx, row.leadId, null);
    // Conditional on OPEN: a concurrent resolver that committed first leaves nothing to update.
    const n = await tx.$executeRaw`
      UPDATE lead_duplicate_match
         SET status = ${outcome.status}, resolved_by = ${ctx.userId}::uuid, resolved_at = now()
       WHERE id = ${id}::uuid AND status = 'OPEN'`;
    if (n !== 1) throw conflict('This case was already resolved');
    await writeAudit(tx, ctx.orgId, {
      action: 'lead.duplicate_resolved',
      entityType: 'lead_duplicate_match',
      entityId: id,
      actorUserId: ctx.userId,
      metadata: { matchType: row.matchType, status: outcome.status, leadId: row.leadId },
    });
    return { status: outcome.status };
  });
}

// ---------------------------------------------------------------------------------------------
// Automatic duplicate detection (lead-lifecycle §5)

/** Most pair cases one new lead opens (a shared mailbox can match many leads). */
const MAX_EMAIL_CASES = 10;

/**
 * Called inside the transaction that created a lead (manual create and import share
 * insertNewLead). An exact, case-insensitive email match — and
 * email is the only approved normalised signal not already handled by the phone rules — with
 * another live lead of the org opens an EMAIL review case. Never merges, never tells the creator
 * about the other lead (cases are visible only in the review queue, to those who may decide them).
 *
 * Signals NOT used, by design: a shared phone with an OPEN lead attaches the enquiry instead
 * (findOpenMatch), and with a closed lead links the returning customer (previousLeadId); a
 * similar name alone is not conclusive and opens nothing (no approved rule; documented).
 *
 * Concurrency: a per-(org, email) advisory lock serialises creates with the same email, so two
 * simultaneous creates cannot both miss each other; the unordered-pair unique index plus
 * ON CONFLICT DO NOTHING makes it idempotent.
 */
export async function detectEmailDuplicates(
  tx: Tx,
  ctx: RequestContext,
  leadId: string,
  email: string | null,
): Promise<number> {
  if (!email) return 0;
  const norm = email.trim().toLowerCase();
  await tx.$executeRaw`SELECT pg_advisory_xact_lock(hashtextextended(${`lead-email:${ctx.orgId}:${norm}`}, 0))`;
  // Case-insensitive exact match, as with citext equality: email_normalized is lower(email::text),
  // kept by the database (generated column, M6 P-B), and lower() is applied to the search value
  // here too, so both sides go through the same PostgreSQL function. Plain equality, so _ and %
  // are not wildcards. Unlike citext equality, text equality is LEAKPROOF, so the
  // (org_id, email_normalized) index serves this under RLS instead of a scan of the whole table.
  const others = await tx.$queryRaw<{ id: string }[]>`
    SELECT id FROM lead
     WHERE org_id = ${ctx.orgId}::uuid AND email_normalized = lower(${norm})
       AND id <> ${leadId}::uuid AND merged_into_lead_id IS NULL AND deleted_at IS NULL
     ORDER BY created_at ASC
     LIMIT ${MAX_EMAIL_CASES}`;
  let opened = 0;
  for (const o of others)
    opened += await tx.$executeRaw`
      INSERT INTO lead_duplicate_match (org_id, match_type, lead_id, candidate_lead_id, detected_by)
      VALUES (${ctx.orgId}::uuid, 'EMAIL', ${leadId}::uuid, ${o.id}::uuid,
              ${ctx.kind === 'member' ? ctx.userId : null}::uuid)
      ON CONFLICT DO NOTHING`;
  return opened;
}

// ---------------------------------------------------------------------------------------------
// Bulk archive (FR-063 "archive"; Should)

/** Same selection limit as bulk assign (FR-063 runs above 500 as a job; selections stay ≤ 100). */
export const BULK_ARCHIVE_MAX = 100;

const bulkArchiveInput = z.object({
  items: z
    .array(z.object({ id: z.uuid(), version: z.coerce.number().int().min(1) }))
    .min(1, 'Select at least one lead')
    .max(BULK_ARCHIVE_MAX, `Select at most ${BULK_ARCHIVE_MAX} leads`),
  reason: opt(text(500)),
});

/**
 * Archives a selection all-or-nothing (Owner/Admin: lead.bulk_update and lead.archive, org
 * scope). Each lead must be in scope, live, not yet archived and at the version the user saw; if
 * any is not, nothing is archived and the refusal names the leads. One timeline entry per lead
 * and ONE audit entry with the item list (ids only, no personal data).
 */
export async function bulkArchiveLeads(
  ctx: RequestContext,
  raw: unknown,
): Promise<{ archived: number }> {
  authorize(ctx, 'lead.bulk_update');
  const scope = authorize(ctx, 'lead.archive');
  const input = bulkArchiveInput.parse(raw);
  const want = new Map<string, number>();
  for (const i of input.items) want.set(i.id.toLowerCase(), i.version);
  const ids = [...want.keys()].sort();
  const reason = input.reason ? cleanText(input.reason) || null : null;
  return tenantRunner().withTenant(ctx.tenant, async (tx) => {
    // Lock the selection in id order (no deadlock with another bulk action), then check it.
    await tx.$queryRaw`SELECT id FROM lead WHERE id = ANY(${ids}::uuid[]) ORDER BY id FOR UPDATE`;
    const rows = await tx.lead.findMany({
      where: { AND: [{ id: { in: ids } }, await scopeFilter(tx, ctx, scope)] },
      select: { id: true, version: true, archivedAt: true, mergedIntoLeadId: true },
    });
    if (rows.length !== ids.length) throw notFound('One or more selected leads were not found');
    const stale = rows.filter((r) => r.version !== want.get(r.id)).map((r) => r.id);
    const ineligible = rows.filter((r) => r.archivedAt || r.mergedIntoLeadId).map((r) => r.id);
    if (ineligible.length)
      throw new DomainError(
        'RULE_VIOLATION',
        `${ineligible.length} selected ${ineligible.length === 1 ? 'lead is' : 'leads are'} already archived or merged; nothing was archived`,
        { leadIds: ineligible },
      );
    if (stale.length)
      throw new DomainError(
        'CONFLICT',
        `${stale.length} selected ${stale.length === 1 ? 'lead' : 'leads'} changed since the list was loaded; reload and try again`,
        { leadIds: stale },
      );
    for (const id of ids) {
      const n = await tx.$executeRaw`
        UPDATE lead SET archived_at = now(), version = version + 1, updated_at = now()
         WHERE id = ${id}::uuid AND version = ${want.get(id)!}
           AND archived_at IS NULL AND merged_into_lead_id IS NULL`;
      if (n !== 1) throw staleVersion();
      await tx.leadActivity.create({
        data: {
          orgId: ctx.orgId,
          leadId: id,
          type: 'ARCHIVED',
          actorId: ctx.userId,
          summary: reason ? { reason, bulk: true } : { bulk: true },
        },
      });
    }
    await writeAudit(tx, ctx.orgId, {
      action: 'lead.bulk_archived',
      entityType: 'lead',
      actorUserId: ctx.userId,
      metadata: { count: ids.length, leadIds: ids.join(',') },
    });
    return { archived: ids.length };
  });
}
