// FR-060 phone masking and reveal (ADR-0013). When the org setting is on, the queries that feed
// pages (searchLeads, getLead, previewMerge) and the Owner's export file (loadExportRows) return
// masked numbers, so a full number never leaves the server except through revealLeadPhone.
// Internal paths (duplicate detection, phone search, imports, merge) keep working on the stored
// numbers, unchanged.
//
// Revealing: lead.reveal_phone in the lead's scope (roles §4.1 O / O / T / S), only while masking
// is on. Each reveal inserts a lead_phone_reveal row first; the database refuses it over the
// daily cap and writes the lead.phone_revealed audit row (migration 0016). The number is read
// only after that, in the same transaction. Revealing never changes the lead or its contact
// status, and never makes a lead eligible for contact (outboundEligibility is unchanged).
import { authorize, type RequestContext } from '@/platform/authz';
import { tenantRunner, type Tx } from '@/platform/db';
import { ruleViolation } from '@/platform/errors';
import { findInScope, parseId } from './access';
import type { ContactStatus } from './contactability';

/** "+919803704066" → "+91 ••••••4066"; other numbers keep only their last four digits. */
export function maskPhone(e164: string): string {
  const last4 = e164.slice(-4);
  if (/^\+91\d{10}$/.test(e164)) return `+91 ••••••${last4}`;
  return `${'•'.repeat(Math.max(e164.replace(/\D/g, '').length - 4, 2))}${last4}`;
}

export interface PhoneMaskingPolicy {
  enabled: boolean;
  dailyCap: number;
}

export async function phoneMaskingPolicy(tx: Tx, orgId: string): Promise<PhoneMaskingPolicy> {
  const o = await tx.organization.findUnique({
    where: { id: orgId },
    select: { phoneMasking: true, phoneRevealDailyCap: true },
  });
  return { enabled: o?.phoneMasking ?? false, dailyCap: o?.phoneRevealDailyCap ?? 50 };
}

/** How the queries show a stored number to this org's users. */
export function phoneDisplay(p: PhoneMaskingPolicy) {
  return <T extends string | null>(e164: T): T =>
    (p.enabled && e164 !== null ? maskPhone(e164) : e164) as T;
}

/** The session member's reveals so far in the org's current day (under the same lock as the DB). */
async function revealsToday(tx: Tx, orgId: string, userId: string): Promise<number> {
  await tx.$queryRaw`
    SELECT 1 AS locked
      FROM pg_advisory_xact_lock(hashtextextended('phone_reveal:' || ${orgId} || ':' || ${userId}, 0))`;
  const [r] = await tx.$queryRaw<{ n: number }[]>`
    SELECT count(*)::int AS n FROM lead_phone_reveal r, organization o
     WHERE o.id = ${orgId}::uuid AND r.org_id = o.id AND r.revealed_by = ${userId}::uuid
       AND r.revealed_at >= (date_trunc('day', now() AT TIME ZONE o.time_zone) AT TIME ZONE o.time_zone)`;
  return r?.n ?? 0;
}

export interface RevealedPhone {
  primaryPhoneE164: string;
  alternatePhoneE164: string | null;
  /** Reveals left today for this person. */
  remainingToday: number;
  /** Shown with the number: revealing does not permit contact. */
  contactStatus: ContactStatus;
}

/** Reveals a lead's numbers to the caller: one audited, capped reveal per call. */
export async function revealLeadPhone(ctx: RequestContext, leadId: string): Promise<RevealedPhone> {
  const scope = authorize(ctx, 'lead.reveal_phone');
  if (ctx.kind !== 'member') throw ruleViolation('Only organisation members can reveal numbers');
  const id = parseId(leadId);
  return tenantRunner().withTenant(ctx.tenant, async (tx) => {
    await findInScope(tx, ctx, scope, id, { id: true });
    const policy = await phoneMaskingPolicy(tx, ctx.orgId);
    if (!policy.enabled) throw ruleViolation('Phone masking is off: numbers are already shown');
    const { used } = await recordReveal(tx, ctx, policy, id);
    const l = await tx.lead.findUniqueOrThrow({
      where: { id },
      select: { primaryPhoneE164: true, alternatePhoneE164: true, contactStatus: true },
    });
    return {
      primaryPhoneE164: l.primaryPhoneE164,
      alternatePhoneE164: l.alternatePhoneE164,
      remainingToday: policy.dailyCap - used - 1,
      contactStatus: l.contactStatus as ContactStatus,
    };
  });
}

/** One capped reveal row (its trigger writes the lead.phone_revealed audit row). */
async function recordReveal(
  tx: Tx,
  ctx: RequestContext & { kind: 'member' },
  policy: PhoneMaskingPolicy,
  leadId: string,
): Promise<{ revealId: string; used: number }> {
  const used = await revealsToday(tx, ctx.orgId, ctx.userId);
  if (used >= policy.dailyCap)
    throw ruleViolation(
      `You have reached today's limit of ${policy.dailyCap} number reveals. Ask your Owner if you need more.`,
    );
  const r = await tx.leadPhoneReveal.create({
    data: { orgId: ctx.orgId, leadId, revealedBy: ctx.userId },
    select: { id: true },
  });
  return { revealId: r.id, used };
}

export type DialNumberKind = 'PRIMARY' | 'ALTERNATE';

/**
 * FR-080/081 (ADR-0025): the number a Call or WhatsApp tap opens, for a lead the caller already
 * locked in scope. With masking on, dialling is a reveal (ADR-0013): it needs lead.reveal_phone in
 * the lead's scope, counts towards the daily cap and is audited; the reveal id goes on the call
 * intent. With masking off the number is already shown, so nothing extra is recorded.
 */
export async function dialNumberIn(
  tx: Tx,
  ctx: RequestContext & { kind: 'member' },
  leadId: string,
  kind: DialNumberKind,
): Promise<{ e164: string; revealId: string | null }> {
  const l = await tx.lead.findUniqueOrThrow({
    where: { id: leadId },
    select: { primaryPhoneE164: true, alternatePhoneE164: true },
  });
  const e164 = kind === 'PRIMARY' ? l.primaryPhoneE164 : l.alternatePhoneE164;
  if (!e164) throw ruleViolation('This lead has no alternate number');
  const policy = await phoneMaskingPolicy(tx, ctx.orgId);
  if (!policy.enabled) return { e164, revealId: null };
  const scope = authorize(ctx, 'lead.reveal_phone');
  await findInScope(tx, ctx, scope, leadId, { id: true });
  const { revealId } = await recordReveal(tx, ctx, policy, leadId);
  return { e164, revealId };
}
