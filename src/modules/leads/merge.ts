// Lead merge (FR-062; owner decision D1 of 2026-10-24: merge by reference). The merged lead
// becomes a frozen tombstone pointing at the survivor; no historical row is moved or rewritten.
// The survivor's combined timeline is read through the pointers (getTimeline).
//
// Concurrency: both leads' phone keys are locked (lockPhones, sorted, the same advisory locks
// that create / report-duplicate / import take), then both lead rows FOR UPDATE in id order, and
// both leads are re-read before planning. A phone-matched enquiry therefore either commits before
// the merge (and is history of the merged lead) or waits and then sees the tombstone excluded by
// OPEN; an enquiry or note addressed by id waits on the row lock (canonicalLeadId) and is
// redirected. Crossing merges (A into B, B into A) serialise and the second is refused.
//
// The database independently refuses cycles, archived/merged/foreign targets and any change to a
// tombstone (lead_hygiene_guard), and accepts a MERGED review outcome only when it is true.
import { z } from 'zod';
import { writeAudit } from '@/modules/audit';
import { authorize, type RequestContext, type Scope } from '@/platform/authz';
import { tenantRunner, type Prisma, type Tx } from '@/platform/db';
import { notFound, ruleViolation } from '@/platform/errors';
import { invalid, lockPhones, scopeFilter, staleVersion } from './access';
import { phoneDisplay, phoneMaskingPolicy } from './phone-masking';
import {
  MERGE_FIELDS,
  MergeRefused,
  planMerge,
  resolveMerge,
  type MergeField,
  type MergeLead,
  type MergePlan,
} from './merge-plan';

const SELECT = {
  id: true,
  orgId: true,
  version: true,
  primaryPhoneE164: true,
  preferredLocalities: true,
  mergedIntoLeadId: true,
  deletedAt: true,
  archivedAt: true,
  contactStatus: true,
  ...Object.fromEntries(MERGE_FIELDS.map((f) => [f, true])),
} as const;

type Row = { id: string; version: number; contactStatus: string } & MergeLead;

async function load(tx: Tx, ctx: RequestContext, scope: Scope, id: string): Promise<Row> {
  const r = (await tx.lead.findFirst({
    where: { AND: [{ id }, await scopeFilter(tx, ctx, scope)] },
    select: SELECT,
  })) as Record<string, unknown> | null;
  if (!r) throw notFound('Lead not found');
  const fields = Object.fromEntries(
    MERGE_FIELDS.map((f) => {
      const v = r[f];
      // Decimal budgets compare and travel as fixed-point strings (as in the M0 budget parser).
      const out =
        v !== null && typeof v === 'object' && 'toFixed' in v
          ? (v as { toFixed(n: number): string }).toFixed(2)
          : (v as string | number | null);
      return [f, out];
    }),
  ) as MergeLead['fields'];
  return {
    id: r.id as string,
    orgId: r.orgId as string,
    version: r.version as number,
    contactStatus: r.contactStatus as string,
    primaryPhoneE164: r.primaryPhoneE164 as string,
    preferredLocalities: r.preferredLocalities as string[],
    mergedIntoLeadId: r.mergedIntoLeadId as string | null,
    deletedAt: r.deletedAt as Date | null,
    archivedAt: r.archivedAt as Date | null,
    fields,
  };
}

function refusal(e: unknown): never {
  if (!(e instanceof MergeRefused)) throw e;
  switch (e.code) {
    case 'CONFLICTS_UNRESOLVED':
      throw invalid(Object.fromEntries(e.fields.map((f) => [f, ['Choose which value to keep']])));
    case 'UNKNOWN_RESOLUTION':
      throw invalid(Object.fromEntries(e.fields.map((f) => [f, ['This field has no conflict']])));
    case 'SAME_LEAD':
      throw ruleViolation('A lead cannot be merged into itself');
    case 'SURVIVOR_ARCHIVED':
      throw ruleViolation('Restore the archived lead before merging into it');
    case 'ALREADY_MERGED':
      throw ruleViolation('One of these leads was already merged');
    default:
      throw ruleViolation('These leads cannot be merged');
  }
}

const pairInput = z.object({ survivorId: z.uuid(), mergedId: z.uuid() });

export interface MergePreview extends MergePlan {
  survivorVersion: number;
  mergedVersion: number;
  /** FR-065: the duplicate asked not to be contacted, so the survivor becomes do-not-contact. */
  carriesDoNotContact: boolean;
}

/** A do-not-contact request is the person's, so it survives a merge (ADR-0012). */
const carriesDoNotContact = (s: Row, m: Row) =>
  m.contactStatus === 'DO_NOT_CONTACT' && s.contactStatus !== 'DO_NOT_CONTACT';

/** The fills and conflicts the user must see (and resolve) before merging. */
export async function previewMerge(ctx: RequestContext, raw: unknown): Promise<MergePreview> {
  const scope = authorize(ctx, 'lead.merge');
  const { survivorId, mergedId } = pairInput.parse(raw);
  if (survivorId === mergedId) refusal(new MergeRefused('SAME_LEAD'));
  return tenantRunner().withTenant(ctx.tenant, async (tx) => {
    const s = await load(tx, ctx, scope, survivorId);
    const m = await load(tx, ctx, scope, mergedId);
    try {
      // FR-060: the preview shows alternate-phone values masked when masking is on.
      const phone = phoneDisplay(await phoneMaskingPolicy(tx, ctx.orgId));
      const plan = planMerge(s, m);
      const show = <V>(field: string, v: V) =>
        field === 'alternatePhoneE164' && typeof v === 'string' ? (phone(v) as V) : v;
      return {
        ...plan,
        fills: plan.fills.map((f) => ({ ...f, value: show(f.field, f.value) })),
        conflicts: plan.conflicts.map((c) => ({
          ...c,
          survivor: show(c.field, c.survivor),
          merged: show(c.field, c.merged),
        })),
        survivorVersion: s.version,
        mergedVersion: m.version,
        carriesDoNotContact: carriesDoNotContact(s, m),
      };
    } catch (e) {
      refusal(e);
    }
  });
}

const mergeInput = pairInput.extend({
  survivorVersion: z.coerce.number().int().min(1),
  mergedVersion: z.coerce.number().int().min(1),
  resolutions: z.record(z.string().max(50), z.enum(['survivor', 'merged'])).default({}),
});

/** Merges `mergedId` into `survivorId` with the user's explicit choice for every conflict. */
export async function mergeLeads(
  ctx: RequestContext,
  raw: unknown,
): Promise<{ survivorId: string; mergedId: string }> {
  const scope = authorize(ctx, 'lead.merge');
  const input = mergeInput.parse(raw);
  const { survivorId, mergedId } = input;
  if (survivorId === mergedId) refusal(new MergeRefused('SAME_LEAD'));
  return tenantRunner().withTenant(ctx.tenant, async (tx) => {
    // 1. Lock every phone key of both leads (deterministic order), then both rows (id order).
    const before = [await load(tx, ctx, scope, survivorId), await load(tx, ctx, scope, mergedId)];
    const phones = phonesOf(before);
    await lockPhones(tx, ctx.orgId, phones);
    await tx.$queryRaw`
      SELECT id FROM lead WHERE id IN (${survivorId}::uuid, ${mergedId}::uuid) ORDER BY id FOR UPDATE`;
    // 2. Re-read under the locks: what the plan is built from.
    const s = await load(tx, ctx, scope, survivorId);
    const m = await load(tx, ctx, scope, mergedId);
    if (phonesOf([s, m]).some((p) => !phones.includes(p))) throw staleVersion(); // a phone changed between the first read and the lock
    if (s.version !== input.survivorVersion || m.version !== input.mergedVersion)
      throw staleVersion();
    let changes: ReturnType<typeof resolveMerge>;
    let plan: MergePlan;
    try {
      plan = planMerge(s, m);
      changes = resolveMerge(plan, input.resolutions);
    } catch (e) {
      refusal(e);
    }
    checkRanges(s, changes);

    // 3. An archived merged lead's open review case follows the merge: closed as kept archived
    //    while the lead is still a live (unmerged) row, as duplicate_match_guard requires.
    await tx.$executeRaw`
      UPDATE lead_duplicate_match
         SET status = 'KEPT_ARCHIVED', resolved_by = ${ctx.userId}::uuid, resolved_at = now()
       WHERE lead_id = ${mergedId}::uuid AND match_type = 'ARCHIVED_ENQUIRY' AND status = 'OPEN'`;

    // 3b. Open follow-ups (FR-062 "tasks moved", FR-108) move to the survivor while both rows
    //     are still live, so the next-follow-up trigger updates both leads. One open follow-up
    //     per lead and assignee: where the survivor already has one for the same person, it is
    //     kept and the merged lead's is cancelled with a reason. Closed ones stay as history.
    //     (Plain SQL: the tasks module depends on leads, not the other way round.)
    const followUpsCancelled = await tx.$executeRaw`
      UPDATE task t
         SET status = 'CANCELLED', cancelled_at = now(), version = t.version + 1, updated_at = now(),
             cancel_reason = 'Lead merged: the surviving lead already had an open follow-up for this person'
       WHERE t.lead_id = ${mergedId}::uuid AND t.status = 'OPEN' AND t.type = 'FOLLOW_UP'
         AND EXISTS (SELECT 1 FROM task s
                      WHERE s.lead_id = ${survivorId}::uuid AND s.status = 'OPEN'
                        AND s.type = 'FOLLOW_UP' AND s.assignee_user_id = t.assignee_user_id)`;
    const followUpsMoved = await tx.$executeRaw`
      UPDATE task SET lead_id = ${survivorId}::uuid, version = version + 1, updated_at = now()
       WHERE lead_id = ${mergedId}::uuid AND status = 'OPEN'`;
    // 3b'. Site visits (ADR-0022), open and closed, move to the survivor with their history: they
    //      are the customer's visits, and the survivor's stage and timeline carry on from them.
    const visitsMoved = await tx.$executeRaw`
      UPDATE site_visit SET lead_id = ${survivorId}::uuid, version = version + 1, updated_at = now()
       WHERE lead_id = ${mergedId}::uuid`;

    // 3c. FR-065: the duplicate's do-not-contact goes to the survivor before the tombstone (the
    //     database refuses to merge a do-not-contact lead into one that is not). The event's
    //     trigger raises the survivor's version, timeline and audit.
    const dncCarried = carriesDoNotContact(s, m);
    if (dncCarried)
      await tx.leadContactStatusEvent.create({
        data: {
          orgId: ctx.orgId,
          leadId: survivorId,
          fromStatus: s.contactStatus,
          toStatus: 'DO_NOT_CONTACT',
          origin: 'MERGE',
          relatedLeadId: mergedId,
          changedBy: ctx.userId,
        },
        select: { id: true },
      });

    // 4. Tombstone first (the guard re-checks and locks the target), then the survivor.
    const t = await tx.lead.updateMany({
      where: { id: mergedId, version: m.version, mergedIntoLeadId: null },
      data: { mergedIntoLeadId: survivorId, version: { increment: 1 }, updatedAt: new Date() },
    });
    if (t.count !== 1) throw staleVersion();
    const { preferredLocalities, ...fieldChanges } = changes;
    const u = await tx.lead.updateMany({
      where: { id: survivorId, version: s.version + (dncCarried ? 1 : 0) },
      data: {
        // Values come from the other lead's validated columns; a fill is never null.
        ...(fieldChanges as Prisma.LeadUpdateManyMutationInput),
        ...(preferredLocalities ? { preferredLocalities } : {}),
        version: { increment: 1 },
        updatedAt: new Date(),
      },
    });
    if (u.count !== 1) throw staleVersion();

    // 5. The tombstone no longer belongs to anyone's working set.
    await tx.$executeRaw`
      UPDATE lead_assignment_history SET ended_at = now()
       WHERE lead_id = ${mergedId}::uuid AND ended_at IS NULL`;

    // 6. Review cases: this pair is MERGED (true now); other open pairs naming the tombstone are
    //    dismissed (the survivor is the lead to review from now on).
    await tx.$executeRaw`
      UPDATE lead_duplicate_match
         SET status = 'MERGED', resolved_by = ${ctx.userId}::uuid, resolved_at = now()
       WHERE status = 'OPEN' AND match_type <> 'ARCHIVED_ENQUIRY'
         AND least(lead_id, candidate_lead_id) = least(${survivorId}::uuid, ${mergedId}::uuid)
         AND greatest(lead_id, candidate_lead_id) = greatest(${survivorId}::uuid, ${mergedId}::uuid)`;
    await tx.$executeRaw`
      UPDATE lead_duplicate_match
         SET status = 'DISMISSED', resolved_by = ${ctx.userId}::uuid, resolved_at = now()
       WHERE status = 'OPEN' AND match_type <> 'ARCHIVED_ENQUIRY'
         AND (lead_id = ${mergedId}::uuid OR candidate_lead_id = ${mergedId}::uuid)`;

    // 7. Timeline (both leads) and audit: field names and counts only, never values.
    const filled = plan.fills.map((f) => f.field);
    const chosen = plan.conflicts.map((c) => `${c.field}:${input.resolutions[c.field]}`);
    await tx.leadActivity.create({
      data: {
        orgId: ctx.orgId,
        leadId: survivorId,
        type: 'MERGED',
        actorId: ctx.userId,
        summary: {
          mergedLeadId: mergedId,
          filled,
          chosen,
          localitiesDropped: plan.localitiesDropped,
        },
        refType: 'lead',
        refId: mergedId,
      },
    });
    await tx.leadActivity.create({
      data: {
        orgId: ctx.orgId,
        leadId: mergedId,
        type: 'MERGED',
        actorId: ctx.userId,
        summary: { mergedIntoLeadId: survivorId },
        refType: 'lead',
        refId: survivorId,
      },
    });
    await writeAudit(tx, ctx.orgId, {
      action: 'lead.merged',
      entityType: 'lead',
      entityId: survivorId,
      actorUserId: ctx.userId,
      metadata: {
        mergedLeadId: mergedId,
        filled: filled.length,
        conflictsResolved: chosen.length,
        mergedWasArchived: m.archivedAt !== null,
        followUpsMoved,
        visitsMoved,
        followUpsCancelled,
        doNotContactCarried: dncCarried,
      },
    });
    return { survivorId, mergedId };
  });
}

function phonesOf(leads: MergeLead[]): string[] {
  return [
    ...new Set(
      leads.flatMap((l) => [l.primaryPhoneE164, l.fields.alternatePhoneE164 as string | null]),
    ),
  ]
    .filter((p): p is string => !!p)
    .sort();
}

/** Mixed choices must still form valid ranges (the lead CHECKs would refuse them). */
function checkRanges(s: MergeLead, changes: Partial<Record<MergeField, unknown>>) {
  const v = (f: MergeField) => (f in changes ? changes[f] : s.fields[f]) as string | number | null;
  const errors: Record<string, string[]> = {};
  const bhkMin = v('bhkMin');
  const bhkMax = v('bhkMax');
  if (bhkMin !== null && bhkMax !== null && Number(bhkMin) > Number(bhkMax))
    errors.bhkMax = ['These choices give a minimum BHK above the maximum'];
  const bMin = v('budgetMin');
  const bMax = v('budgetMax');
  if (bMin !== null && bMax !== null && Number(bMin) > Number(bMax))
    errors.budgetMax = ['These choices give a minimum budget above the maximum'];
  if (Object.keys(errors).length) throw invalid(errors);
}
