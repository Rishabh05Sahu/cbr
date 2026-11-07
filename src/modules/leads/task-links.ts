// What the tasks module needs to know about a lead, inside the caller's transaction
// (module-boundaries: tasks → leads). The same scope rules as every lead command apply: a lead
// outside the caller's scope, in another org, or missing is reported as not found.
import type { RequestContext, Scope } from '@/platform/authz';
import type { Prisma, Tx } from '@/platform/db';
import { assertWritable, findInScope, parseId, scopeFilter } from './access';
import type { LeadStage } from './stages';

export interface TaskLead {
  id: string;
  stage: LeadStage;
  archivedAt: Date | null;
  mergedIntoLeadId: string | null;
  /** FR-065 contact status (OK, DO_NOT_CONTACT, INVALID): a Call task is refused on DO_NOT_CONTACT. */
  contactStatus: string;
}

/**
 * The lead a task belongs to, in `scope` (the caller's lead.read or lead.update scope).
 * With `write`, the lead must also be writable: not merged and not archived (FR-061).
 */
export async function leadForTask(
  tx: Tx,
  ctx: RequestContext,
  scope: Scope,
  leadId: string,
  { write }: { write: boolean },
): Promise<TaskLead> {
  const lead = (await findInScope(tx, ctx, scope, parseId(leadId), {
    id: true,
    stage: true,
    archivedAt: true,
    mergedIntoLeadId: true,
    contactStatus: true,
  })) as TaskLead;
  if (write) assertWritable(lead);
  return lead;
}

/** Leads in `scope` as a filter (TEAM task scope: tasks on the leads a manager can see). */
export function leadScopeFilter(
  tx: Tx,
  ctx: RequestContext,
  scope: Scope,
): Promise<Prisma.LeadWhereInput> {
  return scopeFilter(tx, ctx, scope);
}
