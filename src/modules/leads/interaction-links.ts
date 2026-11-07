// What the interactions module needs from a lead (FR-083/084, ADR-0014): the lead in the caller's
// scope, locked for the rest of the transaction, with the fields the outcome sheet decides on.
// Leads module internals stay here; the interactions module never reads lead columns directly.
import type { RequestContext, Scope } from '@/platform/authz';
import type { Tx } from '@/platform/db';
import { findInScope, parseId } from './access';
import type { ContactStatus } from './contactability';
import type { LeadStage, MilestoneField } from './stages';

export interface InteractionLead extends Record<MilestoneField, Date | null> {
  id: string;
  version: number;
  stage: LeadStage;
  contactStatus: ContactStatus;
  archivedAt: Date | null;
  mergedIntoLeadId: string | null;
  transactionType: string | null;
  propertyType: string | null;
  preferredCity: string | null;
  budgetMin: unknown;
  budgetMax: unknown;
}

/**
 * The lead in `scope` (not found otherwise, like another org's lead), locked FOR UPDATE: a second
 * submission for the same lead waits for this one, and a concurrent contact status change either
 * commits first or waits. Writability is left to the caller (a retried submission is answered
 * from its first result even if the lead was archived since).
 */
export async function lockLeadForInteraction(
  tx: Tx,
  ctx: RequestContext,
  scope: Scope,
  leadId: string,
): Promise<InteractionLead> {
  const id = parseId(leadId);
  await findInScope(tx, ctx, scope, id, { id: true });
  await tx.$queryRaw`SELECT id FROM lead WHERE id = ${id}::uuid FOR UPDATE`;
  const l = await tx.lead.findUniqueOrThrow({
    where: { id },
    select: {
      id: true,
      version: true,
      stage: true,
      contactStatus: true,
      archivedAt: true,
      mergedIntoLeadId: true,
      transactionType: true,
      propertyType: true,
      preferredCity: true,
      budgetMin: true,
      budgetMax: true,
      firstContactedAt: true,
      qualifiedAt: true,
      firstVisitScheduledAt: true,
      firstVisitCompletedAt: true,
      wonAt: true,
      lostAt: true,
    },
  });
  return { ...l, contactStatus: l.contactStatus as ContactStatus };
}

/** True when the caller has `permission` over this lead (its scope); used for optional writes. */
export async function leadInScope(
  tx: Tx,
  ctx: RequestContext,
  scope: Scope,
  leadId: string,
): Promise<boolean> {
  try {
    await findInScope(tx, ctx, scope, leadId, { id: true });
    return true;
  } catch {
    return false;
  }
}
