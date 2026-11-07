// FR-065 contact status / Do-Not-Contact commands (ADR-0012). Rules in contactability.ts; the
// database enforces them again (migration 0015): a change is an append-only
// lead_contact_status_event whose trigger updates the lead and writes the timeline entry and
// audit row, and lead.contact_status cannot be changed any other way.
import { z } from 'zod';
import { authorize, can, type RequestContext } from '@/platform/authz';
import { tenantRunner, type Tx } from '@/platform/db';
import { ruleViolation } from '@/platform/errors';
import { cleanText, findInScope, invalid, parseId, staleVersion } from './access';
import {
  CONTACT_STATUSES,
  contactStatusChangeErrors,
  outboundEligibility,
  type ContactStatus,
  type OutboundChannel,
} from './contactability';

const optText = (max: number) =>
  z
    .string()
    .max(max * 2)
    .optional()
    .transform((s) => (s ? cleanText(s).slice(0, max) || null : null));

const changeInput = z.object({
  toStatus: z.enum(CONTACT_STATUSES),
  version: z.coerce.number().int().min(1),
  reason: optText(500),
  method: optText(30),
  evidenceRef: optText(300),
});

/** Records a contact status change for a lead the caller may update (lead.update scope). */
export async function changeContactStatus(
  ctx: RequestContext,
  leadId: string,
  raw: unknown,
): Promise<{ contactStatus: ContactStatus }> {
  const scope = authorize(ctx, 'lead.update');
  const id = parseId(leadId);
  const input = changeInput.parse(raw);
  await tenantRunner().withTenant(ctx.tenant, async (tx) => {
    await findInScope(tx, ctx, scope, id, { id: true });
    await recordContactStatusChange(tx, ctx, id, input, { expectedVersion: input.version });
  });
  return { contactStatus: input.toStatus };
}

export interface ContactStatusRequest {
  toStatus: ContactStatus;
  reason: string | null;
  method: string | null;
  evidenceRef: string | null;
}

/**
 * The one way a person's contact status change is written, inside the caller's transaction
 * (the caller has checked lead.update scope). Locks the lead row, checks the version the form
 * was built from (when given), validates the change and inserts the event; the database
 * re-checks it and its trigger updates the lead, the timeline and the audit log in the same
 * transaction. Used by the contact status card and by the interaction sheet (FR-084, Q3), so an
 * outcome-driven change commits or rolls back with the interaction.
 */
export async function recordContactStatusChange(
  tx: Tx,
  ctx: RequestContext,
  id: string,
  req: ContactStatusRequest,
  opts: { expectedVersion: number | null },
): Promise<void> {
  if (ctx.kind !== 'member') throw ruleViolation('Only organisation members can change this');
  // Lock the row, then check what the form was built from.
  const [l] = await tx.$queryRaw<
    {
      version: number;
      contact_status: ContactStatus;
      archived_at: Date | null;
      merged_into_lead_id: string | null;
    }[]
  >`SELECT version, contact_status, archived_at, merged_into_lead_id
      FROM lead WHERE id = ${id}::uuid FOR UPDATE`;
  if (!l) throw staleVersion();
  if (l.merged_into_lead_id) throw ruleViolation('This lead was merged into another lead');
  if (opts.expectedVersion !== null && l.version !== opts.expectedVersion) throw staleVersion();
  const change = {
    from: l.contact_status,
    to: req.toStatus,
    reason: req.reason,
    method:
      req.toStatus === 'DO_NOT_CONTACT' || l.contact_status === 'DO_NOT_CONTACT'
        ? req.method
        : null,
    evidenceRef: req.evidenceRef,
  };
  const errors = contactStatusChangeErrors(change, {
    canLift: can(ctx, 'lead.lift_do_not_contact'),
    archived: l.archived_at !== null,
  });
  if (Object.keys(errors).length) throw invalid(errors);
  await tx.leadContactStatusEvent.create({
    data: {
      orgId: ctx.orgId,
      leadId: id,
      fromStatus: change.from,
      toStatus: change.to,
      origin: 'MANUAL',
      method: change.method,
      reason: change.reason,
      evidenceRef: change.evidenceRef,
      changedBy: ctx.userId,
    },
    select: { id: true },
  });
}

export interface ContactStatusEventView {
  id: string;
  fromStatus: ContactStatus;
  toStatus: ContactStatus;
  origin: 'MANUAL' | 'CARRY_OVER' | 'MERGE';
  method: string | null;
  reason: string | null;
  evidenceRef: string | null;
  relatedLeadId: string | null;
  changedByName: string | null;
  changedAt: Date;
}

/** The lead's contact status history, newest first (lead.read in scope). */
export async function contactStatusHistory(
  ctx: RequestContext,
  leadId: string,
): Promise<ContactStatusEventView[]> {
  const scope = authorize(ctx, 'lead.read');
  const id = parseId(leadId);
  return tenantRunner().withTenant(ctx.tenant, async (tx) => {
    await findInScope(tx, ctx, scope, id, { id: true });
    const rows = await tx.leadContactStatusEvent.findMany({
      where: { leadId: id },
      orderBy: [{ changedAt: 'desc' }, { id: 'desc' }],
      take: 50,
      select: {
        id: true,
        fromStatus: true,
        toStatus: true,
        origin: true,
        method: true,
        reason: true,
        evidenceRef: true,
        relatedLeadId: true,
        changedAt: true,
        changer: { select: { user: { select: { name: true } } } },
      },
    });
    return rows.map(({ changer, ...r }) => ({
      ...r,
      fromStatus: r.fromStatus as ContactStatus,
      toStatus: r.toStatus as ContactStatus,
      origin: r.origin as ContactStatusEventView['origin'],
      changedByName: changer?.user.name ?? null,
    }));
  });
}

/**
 * The server-side outbound check for future launchers and integration sends (FR-065, T16;
 * integration-strategy §6 step 1). Call it inside the transaction that records the intent or
 * send: it takes FOR SHARE on the lead, so a concurrent change to DO_NOT_CONTACT either commits
 * first (and blocks the send) or waits for it. No launcher calls this yet (FR-080–FR-082 are not
 * built), so end-to-end outbound enforcement is not complete until they exist and are tested.
 */
export async function assertOutboundAllowed(
  tx: Tx,
  leadId: string,
  channel: OutboundChannel,
  opts: { confirmed: boolean },
): Promise<void> {
  const [l] = await tx.$queryRaw<{ contact_status: ContactStatus }[]>`
    SELECT contact_status FROM lead WHERE id = ${leadId}::uuid FOR SHARE`;
  if (!l) throw ruleViolation('Lead not found');
  const e = outboundEligibility(l.contact_status, channel);
  if (!e.allowed) throw ruleViolation(e.reason);
  if (e.requiresConfirmation && !opts.confirmed) throw ruleViolation(e.warning);
}
