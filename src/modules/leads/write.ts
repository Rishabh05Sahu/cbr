// Leads module: the single write path for a new lead and for notes. Manual create (FR-055) and
// import (FR-040–FR-052) both call insertNewLead, so an imported lead gets exactly the rows a
// manual one does: lead, first enquiry, stage history, assignment spell, timeline, first note.
// Callers authorise, lock the phones (lockPhones) and check for an open duplicate first.
import type { RequestContext } from '@/platform/authz';
import type { Tx } from '@/platform/db';
import { cleanText, invalid } from './access';
import type { PreparedLead } from './input';
import { detectEmailDuplicates } from './hygiene';

export const NOTE_EDIT_WINDOW_MS = 15 * 60 * 1000;

type Member = Extract<RequestContext, { kind: 'member' }>;

export async function insertNote(tx: Tx, ctx: RequestContext, leadId: string, body: string) {
  const clean = cleanText(body);
  if (!clean) throw invalid({ body: ['Write a note'] });
  const note = await tx.leadNote.create({
    data: {
      orgId: ctx.orgId,
      leadId,
      authorId: ctx.userId,
      body: clean,
      editedUntil: new Date(Date.now() + NOTE_EDIT_WINDOW_MS),
    },
    select: { id: true },
  });
  await tx.leadActivity.create({
    data: {
      orgId: ctx.orgId,
      leadId,
      type: 'NOTE',
      actorId: ctx.userId,
      refType: 'lead_note',
      refId: note.id,
    },
  });
  return note;
}

export interface NewLeadOptions {
  sourceId: string;
  ownerUserId: string | null;
  teamId: string | null;
  origin: 'UI' | 'IMPORT';
  /** Import idempotency key for the first enquiry (`lead_enquiry_external_uq`). */
  externalId?: string;
  channelRef?: string;
  /** Validated custom values (manual create only; imports do not map custom fields). */
  customFields?: Record<string, unknown>;
}

/** Inserts a new lead. Stage is ASSIGNED with an owner, NEW without (lead-lifecycle §2). */
export async function insertNewLead(
  tx: Tx,
  ctx: Member,
  prepared: PreparedLead,
  o: NewLeadOptions,
): Promise<{ leadId: string; enquiryId: string; returning: boolean }> {
  const { input, primary, alternate, requirements } = prepared;
  const stage = o.ownerUserId ? 'ASSIGNED' : 'NEW';
  // A closed (won/lost) lead for the same phone: the new lead links to it (lead-lifecycle §5.3).
  // Matched on the primary phone only, as before. phone_last10 is always the last 10 digits of
  // primary_phone_e164 (both are written only here), so the org_id and phone_last10 conditions
  // exclude nothing; they let the (org_id, phone_last10) index serve the lookup under RLS, where
  // it would otherwise read every closed lead of the table (M6 P-A).
  const phoneLast10 = primary.e164.slice(-10);
  const previous = await tx.lead.findFirst({
    where: {
      orgId: ctx.orgId,
      phoneLast10,
      primaryPhoneE164: primary.e164,
      stage: { in: ['WON', 'LOST'] },
      deletedAt: null,
    },
    orderBy: { createdAt: 'desc' },
    select: { id: true },
  });
  const lead = await tx.lead.create({
    data: {
      orgId: ctx.orgId,
      fullName: cleanText(input.fullName),
      primaryPhoneE164: primary.e164,
      primaryPhoneRaw: primary.raw,
      alternatePhoneE164: alternate?.e164 ?? null,
      phoneLast10,
      email: input.email ?? null,
      preferredLanguage: input.preferredLanguage ?? null,
      preferredContactMethod: input.preferredContactMethod ?? null,
      ...requirements,
      sourceId: o.sourceId,
      campaign: input.campaign ?? null,
      ownerUserId: o.ownerUserId,
      teamId: o.teamId,
      stage,
      previousLeadId: previous?.id ?? null,
      createdBy: ctx.userId,
      ...(o.customFields ? { customFields: o.customFields as object } : {}),
    },
    select: { id: true },
  });
  // M5: an exact email match with another live lead opens a review case (never a merge).
  await detectEmailDuplicates(tx, ctx, lead.id, input.email ?? null);
  const enquiry = await tx.leadEnquiry.create({
    data: {
      orgId: ctx.orgId,
      leadId: lead.id,
      sourceId: o.sourceId,
      campaign: input.campaign ?? null,
      externalId: o.externalId ?? null,
      channelRef: o.channelRef ?? null,
      createdBy: ctx.userId,
    },
    select: { id: true },
  });
  await tx.leadStageHistory.create({
    data: {
      orgId: ctx.orgId,
      leadId: lead.id,
      toStage: stage,
      changedBy: ctx.userId,
      ...(o.origin === 'IMPORT' ? { source: 'IMPORT' } : {}),
    },
  });
  if (o.ownerUserId || o.teamId)
    await tx.leadAssignmentHistory.create({
      data: {
        orgId: ctx.orgId,
        leadId: lead.id,
        userId: o.ownerUserId,
        teamId: o.teamId,
        assignedBy: ctx.userId,
        source: o.origin === 'IMPORT' ? 'IMPORT' : 'MANUAL',
      },
      select: { id: true },
    });
  await tx.leadActivity.create({
    data: {
      orgId: ctx.orgId,
      leadId: lead.id,
      type: 'CREATED',
      actorId: ctx.userId,
      summary: {
        stage,
        returning: !!previous,
        ...(o.origin === 'IMPORT' ? { channel: 'IMPORT' } : {}),
      },
    },
  });
  if (input.note) await insertNote(tx, ctx, lead.id, input.note);
  return { leadId: lead.id, enquiryId: enquiry.id, returning: !!previous };
}
