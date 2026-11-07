// Leads module: committing validated import rows (FR-045, FR-048, FR-051). The import module
// validates rows (prepareLead) and calls this per batch; all lead writes stay here, through the
// same insertNewLead path, duplicate rules (lead-lifecycle §5) and assignment code (M3) as manual
// work. One transaction per batch.
//
// Retry safety (FR-048): every row's enquiry carries external_id "<importId>:<row>" (unique per
// org and source, lead_enquiry_external_uq). A row whose enquiry already exists is reported as
// ALREADY_IMPORTED and not written again, so re-running a batch after a crash, timeout or worker
// restart never creates a second lead or enquiry. Phones of the whole batch are locked up front
// in sorted order (lockPhones), so concurrent imports and manual creates cannot race the
// duplicate check or deadlock on each other.
//
// Custom fields (M5, FR-064): every row that would CREATE a lead is checked against the org's
// current definitions (locked FOR SHARE for the batch) with required fields enforced, exactly as
// manual create. This also covers callers that skip the import job's own validation. A row that
// fails is reported FAILED with a stable code and nothing is written for it.
import { z } from 'zod';
import { authorize, type RequestContext } from '@/platform/authz';
import { tenantRunner, type Tx } from '@/platform/db';
import { DomainError, ruleViolation } from '@/platform/errors';
import { emitEvent } from '@/platform/outbox';
import { ensureUnknownSource, findOpenMatch, lockPhones, OPEN } from './access';
import { routeEnquiryForArchivedLead } from './hygiene';
import { emitImportAssigned, importAssigner } from './assignment';
import { checkCustomValues, lockedDefinitions } from './custom-field-commands';
import { customIssueField } from './custom-fields';
import type { PreparedLead } from './input';
import { commitImportBatchSet } from './importing-set';
import { insertNewLead } from './write';

/** Rows per transaction: bounded so one batch stays well inside the transaction timeout. */
export const IMPORT_BATCH_MAX = 500;
export const IMPORT_CHANNEL_REF = 'IMPORT';

export interface ImportRowInput {
  /** 1-based spreadsheet row number. */
  row: number;
  lead: PreparedLead;
  sourceId: string;
  /** Typed custom values for a new lead (validated again at commit). */
  customFields?: Record<string, unknown>;
}

export type ImportRowOutcome =
  | { row: number; outcome: 'CREATED'; leadId: string }
  /** Open lead with the same phone: enquiry attached, owner notified (lead-lifecycle §5.2). */
  | { row: number; outcome: 'ATTACHED'; leadId: string }
  /** Open lead with the same phone and the import's policy is "skip". Nothing written. */
  | { row: number; outcome: 'SKIPPED_DUPLICATE'; leadId: string }
  /** Committed by an earlier attempt of this import. Nothing written. */
  | { row: number; outcome: 'ALREADY_IMPORTED'; leadId: string }
  /** Refused at commit (custom fields invalid or a required one missing). Nothing written. */
  | { row: number; outcome: 'FAILED'; leadId: null; field: string; code: string };

const batchOptions = z.object({
  importId: z.uuid(),
  duplicatePolicy: z.enum(['ATTACH', 'SKIP']),
  assignment: z.unknown(),
  /**
   * 'set' (default since the M6 acceptance, 2026-10-26): importing-set.ts
   * (docs/PHASE-2-M6-SET-BASED-IMPORT.md), a constant number of statements per batch. 'row': one
   * row at a time, below, with the same outcomes; kept as the rollback
   * (IMPORT_COMMIT_STRATEGY=row).
   */
  strategy: z.enum(['row', 'set']).default('set'),
});
export type ImportBatchOptions = z.input<typeof batchOptions>;

export const importExternalId = (importId: string, row: number) => `${importId}:${row}`;

/** Checks shared by both entry points; returns the parsed options. */
function prepareBatch(
  ctx: RequestContext,
  rows: readonly ImportRowInput[],
  raw: ImportBatchOptions,
) {
  authorize(ctx, 'lead.import');
  authorize(ctx, 'lead.create');
  if (ctx.kind !== 'member') throw ruleViolation('Only organisation members can import leads');
  const opts = batchOptions.parse(raw);
  if (rows.length > IMPORT_BATCH_MAX) throw ruleViolation('Import batch is too large');
  if (new Set(rows.map((r) => r.row)).size !== rows.length)
    throw ruleViolation('Import batch has repeated row numbers');
  return opts;
}

/** One batch in its own transaction. */
export async function importLeadBatch(
  ctx: RequestContext,
  rows: readonly ImportRowInput[],
  raw: ImportBatchOptions,
): Promise<ImportRowOutcome[]> {
  prepareBatch(ctx, rows, raw);
  if (rows.length === 0) return [];
  return tenantRunner().withTenant(ctx.tenant, (tx) => commitImportBatch(tx, ctx, rows, raw), {
    timeout: 60_000,
  });
}

/**
 * One batch inside the caller's transaction (opened with ctx.tenant), so the import job can
 * record its progress atomically with the leads it wrote.
 */
export async function commitImportBatch(
  tx: Tx,
  ctx: RequestContext,
  rows: readonly ImportRowInput[],
  raw: ImportBatchOptions,
): Promise<ImportRowOutcome[]> {
  const opts = prepareBatch(ctx, rows, raw);
  if (ctx.kind !== 'member' || rows.length === 0) return [];
  const assigner = await importAssigner(tx, ctx, opts.assignment);
  // Sources must be active sources of this org (RLS hides other orgs' rows).
  const sourceIds = [...new Set(rows.map((r) => r.sourceId))];
  const active = await tx.leadSource.count({
    where: { id: { in: sourceIds }, isActive: true },
  });
  if (active !== sourceIds.length) throw ruleViolation('An import source is no longer active');
  if (opts.strategy === 'set') return commitImportBatchSet(tx, ctx, rows, opts, assigner);
  await lockPhones(
    tx,
    ctx.orgId,
    rows.flatMap((r) => r.lead.phones),
  );

  const outcomes: ImportRowOutcome[] = [];
  let defs: Awaited<ReturnType<typeof lockedDefinitions>> | undefined;
  const created: { leadId: string; userId: string | null; teamId: string | null }[] = [];
  for (const r of rows) {
    const externalId = importExternalId(opts.importId, r.row);
    const done = await tx.leadEnquiry.findFirst({
      where: { sourceId: r.sourceId, externalId, channelRef: IMPORT_CHANNEL_REF },
      select: { leadId: true },
    });
    if (done) {
      outcomes.push({ row: r.row, outcome: 'ALREADY_IMPORTED', leadId: done.leadId });
      continue;
    }
    const match = await findOpenMatch(tx, r.lead.phones);
    if (match && opts.duplicatePolicy === 'SKIP') {
      outcomes.push({ row: r.row, outcome: 'SKIPPED_DUPLICATE', leadId: match.id });
      continue;
    }
    if (match) {
      const enquiry = await tx.leadEnquiry.create({
        data: {
          orgId: ctx.orgId,
          leadId: match.id,
          sourceId: r.sourceId,
          campaign: r.lead.input.campaign ?? null,
          externalId,
          channelRef: IMPORT_CHANNEL_REF,
          createdBy: ctx.userId,
        },
        select: { id: true },
      });
      await tx.leadActivity.create({
        data: {
          orgId: ctx.orgId,
          leadId: match.id,
          type: 'ENQUIRY',
          actorId: ctx.userId,
          summary: { channel: 'IMPORT' },
          refType: 'lead_enquiry',
          refId: enquiry.id,
        },
      });
      await emitEvent(tx, ctx.orgId, {
        type: 'lead.enquiry_returned',
        payload: { leadId: match.id, enquiryId: enquiry.id, actorUserId: ctx.userId },
      });
      // D2: an archived lead stays archived; the enquiry opens a review case instead.
      await routeEnquiryForArchivedLead(tx, ctx, match, enquiry.id);
      outcomes.push({ row: r.row, outcome: 'ATTACHED', leadId: match.id });
      continue;
    }
    defs ??= await lockedDefinitions(tx);
    let customFields: Record<string, unknown>;
    try {
      customFields = checkCustomValues(defs, r.customFields ?? {}, { requireRequired: true });
    } catch (e) {
      if (!(e instanceof DomainError) || !e.fieldErrors) throw e;
      const [k] = Object.keys(e.fieldErrors);
      const key = k!.replace(/^customFields\./, '');
      outcomes.push({
        row: r.row,
        outcome: 'FAILED',
        leadId: null,
        field: customIssueField(key),
        // A value that is absent is a missing required field; anything else is invalid.
        code: key in (r.customFields ?? {}) ? 'CUSTOM_FIELD_INVALID' : 'CUSTOM_FIELD_REQUIRED',
      });
      continue;
    }
    const target = assigner.next();
    const lead = await insertNewLead(tx, ctx, r.lead, {
      customFields,
      sourceId: r.sourceId,
      ownerUserId: target.userId,
      teamId: target.teamId,
      origin: 'IMPORT',
      externalId,
      channelRef: IMPORT_CHANNEL_REF,
    });
    created.push({ leadId: lead.leadId, ...target });
    outcomes.push({ row: r.row, outcome: 'CREATED', leadId: lead.leadId });
  }
  await assigner.finish();
  await emitImportAssigned(tx, ctx, created);
  return outcomes;
}

/**
 * Read-only duplicate preview for validation (lead-lifecycle §5.1): for each phone, the oldest
 * open lead that has it as primary or alternate. Not locked; the commit re-checks under lock.
 */
export async function openLeadsByPhone(
  tx: Tx,
  phones: readonly string[],
): Promise<Map<string, string>> {
  const found = new Map<string, { id: string; at: number }>();
  const unique = [...new Set(phones)];
  for (let i = 0; i < unique.length; i += 1000) {
    const chunk = unique.slice(i, i + 1000);
    const leads = await tx.lead.findMany({
      where: {
        ...OPEN,
        OR: [{ primaryPhoneE164: { in: chunk } }, { alternatePhoneE164: { in: chunk } }],
      },
      select: { id: true, createdAt: true, primaryPhoneE164: true, alternatePhoneE164: true },
    });
    for (const l of leads)
      for (const p of [l.primaryPhoneE164, l.alternatePhoneE164]) {
        if (!p || !chunk.includes(p)) continue;
        const prev = found.get(p);
        if (!prev || l.createdAt.getTime() < prev.at)
          found.set(p, { id: l.id, at: l.createdAt.getTime() });
      }
  }
  return new Map([...found].map(([p, v]) => [p, v.id]));
}

class DryRun extends Error {}

/**
 * Checks an import's assignment plan as `ctx` would run it (target rules, round-robin team),
 * without keeping anything: the transaction is always rolled back.
 */
export async function checkImportAssignment(ctx: RequestContext, raw: unknown): Promise<void> {
  try {
    await tenantRunner().withTenant(ctx.tenant, async (tx) => {
      await importAssigner(tx, ctx, raw);
      throw new DryRun();
    });
  } catch (e) {
    if (!(e instanceof DryRun)) throw e;
  }
}

/** The org's "Unknown" source (created on first use), for imports without a chosen source. */
export const unknownSourceId = (tx: Tx, orgId: string) => ensureUnknownSource(tx, orgId);
