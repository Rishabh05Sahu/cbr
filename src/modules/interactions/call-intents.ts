// FR-080/081 Call and WhatsApp launchers and the FR-082 outcome prompt (migration 0028,
// ADR-0025). A tap records a call intent (metrics L0) and returns the tel: or wa.me link the
// browser then opens. It never records a call: the outcome is logged by the person afterwards
// (FR-083), and the prompt only reminds them.
//
// One tap, one transaction: the lead is locked in the caller's interaction.create scope, it must be
// live and writable, the FR-065 outbound rule is applied (Do-Not-Contact refused, Invalid only when
// confirmed; the database re-checks both), and with phone masking on the dial is a capped, audited
// reveal (ADR-0013). The number leaves the server only in the link returned to this person.
import { z } from 'zod';
import * as leads from '@/modules/leads';
import { scopeFilter } from '@/modules/leads/access';
import { authorize, type RequestContext } from '@/platform/authz';
import { tenantRunner } from '@/platform/db';
import { forbidden, ruleViolation } from '@/platform/errors';
import {
  INTENT_CHANNELS,
  intentOutboundChannel,
  launcherHref,
  NUMBER_KINDS,
  PROMPT_WINDOW_MS,
  type IntentChannel,
} from './call-intent-rules';
import { orgLocalInputValue } from './rules';

export * from './call-intent-rules';

const checkbox = z.preprocess((v) => v === 'on' || v === 'true' || v === true, z.boolean());
const tapInput = z.object({
  leadId: z.string().max(64),
  channel: z.enum(INTENT_CHANNELS, 'Choose Call or WhatsApp'),
  numberKind: z.enum(NUMBER_KINDS).default('PRIMARY'),
  confirmInvalidNumber: checkbox,
});

export interface CallIntentResult {
  intentId: string;
  /** tel:+91… or https://wa.me/91… for this person's browser to open. */
  href: string;
}

/** Records one Call or WhatsApp tap and returns the link to open (FR-080/081). */
export async function recordCallIntent(
  ctx: RequestContext,
  raw: unknown,
): Promise<CallIntentResult> {
  const scope = authorize(ctx, 'interaction.create');
  if (ctx.kind !== 'member') throw forbidden();
  const input = tapInput.parse(raw);
  return tenantRunner().withTenant(ctx.tenant, async (tx) => {
    const lead = await leads.lockLeadForInteraction(tx, ctx, scope, input.leadId);
    if (lead.mergedIntoLeadId) throw ruleViolation('This lead was merged into another lead');
    if (lead.archivedAt) throw ruleViolation('This lead is archived. Restore it before contacting');
    await leads.assertOutboundAllowed(tx, lead.id, intentOutboundChannel(input.channel), {
      confirmed: input.confirmInvalidNumber,
    });
    const { e164, revealId } = await leads.dialNumberIn(tx, ctx, lead.id, input.numberKind);
    const href = launcherHref(input.channel, e164);
    const row = await tx.callIntent.create({
      data: {
        orgId: ctx.orgId,
        leadId: lead.id,
        userId: ctx.userId,
        channel: input.channel,
        numberKind: input.numberKind,
        contactStatusAtTap: lead.contactStatus,
        invalidNumberConfirmed: lead.contactStatus === 'INVALID' && input.confirmInvalidNumber,
        phoneRevealId: revealId,
      },
      select: { id: true },
    });
    return { intentId: row.id, href };
  });
}

export interface PendingCallIntent {
  id: string;
  channel: IntentChannel;
  createdAt: Date;
  /** The tap time in the org's time zone, for the outcome sheet's "when" input. */
  occurredAt: string;
}

/**
 * FR-082: the caller's latest tap on this lead in the last two hours that has no outcome logged
 * by them on this lead since. Null otherwise (including for people who cannot log interactions).
 */
export async function pendingCallIntent(
  ctx: RequestContext,
  leadId: string,
  now = new Date(),
): Promise<PendingCallIntent | null> {
  authorize(ctx, 'interaction.create');
  if (ctx.kind !== 'member') return null;
  if (!z.uuid().safeParse(leadId).success) return null;
  return tenantRunner().withTenant(ctx.tenant, async (tx) => {
    const tap = await tx.callIntent.findFirst({
      where: {
        leadId,
        userId: ctx.userId,
        createdAt: { gt: new Date(now.getTime() - PROMPT_WINDOW_MS) },
      },
      orderBy: { createdAt: 'desc' },
      select: { id: true, channel: true, createdAt: true },
    });
    if (!tap) return null;
    const logged = await tx.interaction.findFirst({
      where: { leadId, userId: ctx.userId, loggedAt: { gte: tap.createdAt } },
      select: { id: true },
    });
    if (logged) return null;
    const { timeZone } = await tx.organization.findFirstOrThrow({ select: { timeZone: true } });
    return {
      id: tap.id,
      channel: tap.channel as IntentChannel,
      createdAt: tap.createdAt,
      occurredAt: orgLocalInputValue(tap.createdAt, timeZone),
    };
  });
}

/** How far back My Day looks for calls with no outcome logged (one working day). */
export const UNLOGGED_WINDOW_MS = 24 * 3600 * 1000;

export interface UnloggedCall {
  intentId: string;
  leadId: string;
  leadName: string;
  channel: IntentChannel;
  createdAt: Date;
  /** Org-local "YYYY-MM-DDTHH:mm" of the tap, for the outcome sheet's "when". */
  occurredAt: string;
}

/**
 * My Day "unlogged calls" (FR-082, app): for each lead the caller tapped Call or WhatsApp on in
 * the last day, the latest tap with no outcome logged by them on that lead since. Newest first,
 * at most 20. Only leads still visible to the caller are listed.
 */
export async function unloggedCalls(
  ctx: RequestContext,
  now = new Date(),
): Promise<UnloggedCall[]> {
  authorize(ctx, 'interaction.create');
  if (ctx.kind !== 'member') return [];
  return tenantRunner().withTenant(ctx.tenant, async (tx) => {
    const taps = await tx.callIntent.findMany({
      where: {
        userId: ctx.userId,
        createdAt: { gt: new Date(now.getTime() - UNLOGGED_WINDOW_MS) },
      },
      orderBy: { createdAt: 'desc' },
      take: 200,
      select: { id: true, leadId: true, channel: true, createdAt: true },
    });
    const latest = new Map<string, (typeof taps)[number]>();
    for (const t of taps) if (!latest.has(t.leadId)) latest.set(t.leadId, t);
    if (!latest.size) return [];
    const logged = await tx.interaction.findMany({
      where: {
        userId: ctx.userId,
        leadId: { in: [...latest.keys()] },
        loggedAt: { gte: new Date(now.getTime() - UNLOGGED_WINDOW_MS) },
      },
      select: { leadId: true, loggedAt: true },
    });
    const open = [...latest.values()].filter(
      (t) => !logged.some((i) => i.leadId === t.leadId && i.loggedAt >= t.createdAt),
    );
    if (!open.length) return [];
    const scope = authorize(ctx, 'lead.read');
    const visible = await tx.lead.findMany({
      where: {
        AND: [{ id: { in: open.map((t) => t.leadId) } }, await scopeFilter(tx, ctx, scope)],
      },
      select: { id: true, fullName: true },
    });
    const names = new Map(visible.map((l) => [l.id, l.fullName]));
    const { timeZone } = await tx.organization.findFirstOrThrow({ select: { timeZone: true } });
    return open
      .filter((t) => names.has(t.leadId))
      .slice(0, 20)
      .map((t) => ({
        intentId: t.id,
        leadId: t.leadId,
        leadName: names.get(t.leadId)!,
        channel: t.channel as IntentChannel,
        createdAt: t.createdAt,
        occurredAt: orgLocalInputValue(t.createdAt, timeZone),
      }));
  });
}
