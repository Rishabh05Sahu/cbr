// Site visits module (Phase 4, FR-150–152; ADR-0022, migration 0026). A basic site visit is its
// own entity on a lead: date/time, free-text meeting point, assigned salesperson, status and a
// visit-level outcome. Property links and per-property feedback come with FR-157.
//
// Permissions (§4.3): site_visit.manage and site_visit.read follow the lead scope (O / O / T / S);
// read also covers visits assigned to the caller (Workflow D: the assignee may be a field agent).
// Every change happens inside withTenant() with the lead locked, and writes the visit's history
// event, a SITE_VISIT timeline entry and an audit entry. Lead-stage effects are automatic stage
// changes (SYSTEM_RULE) in the same transaction, linked to the visit (lead-lifecycle §2.1):
//   scheduled → Site Visit Scheduled (where the lifecycle allows), attended → Site Visit Completed,
//   the only open visit cancelled → back to Qualified.
import { z } from 'zod';
import { writeAudit } from '@/modules/audit';
import * as leads from '@/modules/leads';
import { ledTeamIds } from '@/modules/teams';
import { authorize, can, type RequestContext, type Scope } from '@/platform/authz';
import { tenantRunner, type Prisma, type Tx } from '@/platform/db';
import { conflict, DomainError, notFound, ruleViolation } from '@/platform/errors';
import {
  INTEREST_LEVELS,
  MAX_OBJECTIONS,
  OPEN_VISIT_STATUSES,
  outcomeTooEarly,
  parseObjections,
  targetOf,
  transitionProblem,
  VISIT_ACTIONS,
  type InterestLevel,
  type VisitStatus,
} from './rules';

export * from './rules';

const invalid = (fieldErrors: Record<string, string[]>) =>
  new DomainError('VALIDATION_FAILED', 'Please check the highlighted fields', fieldErrors);
const line = (max: number) =>
  z
    .string()
    .transform((s) =>
      s
        .replace(/[\u0000-\u001F\u007F]/g, ' ')
        .replace(/\s+/g, ' ')
        .trim(),
    )
    .pipe(z.string().max(max, `At most ${max} characters`));

const scheduleInput = z.object({
  scheduledFor: z.string().max(40),
  location: line(300).refine((t) => t.length > 0, { message: 'Enter the meeting point' }),
  assigneeUserId: z.string().max(40).optional(),
});
const actionInput = z.object({
  action: z.enum(VISIT_ACTIONS, 'Choose what happened'),
  version: z.coerce.number().int().positive(),
  scheduledFor: z.string().max(40).optional(),
  reason: line(500).optional(),
  interestLevel: z.enum(INTEREST_LEVELS).or(z.literal('')).optional(),
  objections: z.string().max(4000).optional(),
  notes: z.string().max(5000).optional(),
  nextAction: line(500).optional(),
});

/** How far ahead a visit may be scheduled; a minute of slack for a slow submit. */
const MAX_AHEAD_MS = 2 * 366 * 86_400_000;
const SLACK_MS = 60_000;
const SALES_ROLES = ['owner', 'admin', 'sales_manager', 'sales_executive'];

async function orgZone(tx: Tx) {
  return (await tx.organization.findFirstOrThrow({ select: { timeZone: true } })).timeZone;
}
async function visitTime(tx: Tx, raw: string | undefined, now: Date, field = 'scheduledFor') {
  const at = raw ? leads.parseOrgLocal(raw, await orgZone(tx)) : null;
  if (!at) throw invalid({ [field]: ['Enter the visit date and time'] });
  if (at.getTime() < now.getTime() - SLACK_MS)
    throw invalid({ [field]: ['Choose a time in the future'] });
  if (at.getTime() > now.getTime() + MAX_AHEAD_MS)
    throw invalid({ [field]: ['Choose a time within the next two years'] });
  return at;
}
const dayIn = (d: Date, timeZone: string) =>
  new Intl.DateTimeFormat('en-CA', { timeZone, year: 'numeric', month: '2-digit', day: '2-digit' })
    .format(d)
    .slice(0, 10);

/**
 * The visit's assignee (FR-150 "assigned salesperson"): the caller by default. Anyone else follows
 * the caller's own site_visit.manage scope, the same rule as tasks for others (FR-103): ORG any
 * active sales member or administrator; TEAM an active member of a team the caller leads; OWN only
 * the caller.
 */
async function assigneeFor(
  tx: Tx,
  ctx: RequestContext & { kind: 'member' },
  scope: Scope,
  raw: string | undefined,
): Promise<string> {
  if (!raw || raw === ctx.userId) return ctx.userId;
  const refuse = (why: string) => invalid({ assigneeUserId: [why] });
  if (scope === 'OWN') throw refuse('You can schedule visits only for yourself');
  const id = z.uuid().safeParse(raw);
  if (!id.success) throw refuse('Choose a person from the list');
  const m = await tx.member.findFirst({
    where: { userId: id.data, status: 'ACTIVE', role: { in: SALES_ROLES } },
    select: { id: true, userId: true },
  });
  if (!m) throw refuse('Choose an active sales member of your organisation');
  if (scope === 'TEAM') {
    const led = await ledTeamIds(tx, ctx.membershipId);
    const inTeam = led.length
      ? await tx.teamMembership.count({
          where: { teamId: { in: led }, membershipId: m.id, endedAt: null },
        })
      : 0;
    if (!inTeam) throw refuse('You can assign visits only to members of the teams you lead');
  }
  return m.userId;
}

async function record(
  tx: Tx,
  ctx: RequestContext & { kind: 'member' },
  v: { id: string; leadId: string },
  event: {
    from: VisitStatus | null;
    to: VisitStatus;
    scheduledFor: Date;
    previous?: Date | null;
    reason?: string | null;
  },
  summary: Record<string, string | number | boolean | null>,
) {
  await tx.siteVisitEvent.create({
    data: {
      orgId: ctx.orgId,
      siteVisitId: v.id,
      fromStatus: event.from,
      toStatus: event.to,
      scheduledFor: event.scheduledFor,
      previousScheduledFor: event.previous ?? null,
      reason: event.reason ?? null,
      actorId: ctx.userId,
    },
  });
  await tx.leadActivity.create({
    data: {
      orgId: ctx.orgId,
      leadId: v.leadId,
      type: 'SITE_VISIT',
      actorId: ctx.userId,
      summary,
      refType: 'site_visit',
      refId: v.id,
    },
  });
  await writeAudit(tx, ctx.orgId, {
    action: `site_visit.${String(summary.action)}`,
    entityType: 'site_visit',
    entityId: v.id,
    actorUserId: ctx.userId,
    metadata: { leadId: v.leadId, from: event.from, to: event.to },
  });
}

/** An automatic stage change linked to the visit (lead-lifecycle §2.1), if the lifecycle allows. */
async function moveStage(
  tx: Tx,
  ctx: RequestContext & { kind: 'member' },
  lead: leads.InteractionLead,
  to: leads.LeadStage,
  req: { visitAt?: Date; reasonText?: string },
  rule: leads.StageRule,
  visitId: string,
  now: Date,
) {
  const plan = leads.planStageChange(lead.stage, { to, ...req }, lead, { canReopen: false, now });
  const { version } = await tx.lead.findUniqueOrThrow({
    where: { id: lead.id },
    select: { version: true },
  });
  await leads.applyStageChange(tx, ctx, lead.id, lead, to, plan, {
    expectedVersion: version,
    now,
    rule,
    related: { type: 'site_visit', id: visitId },
  });
}

/** Stages from which scheduling a visit moves the lead to Site Visit Scheduled (§2 diagram). */
const SCHEDULE_MOVES: readonly leads.LeadStage[] = [
  'NEW',
  'ASSIGNED',
  'CONTACTED',
  'QUALIFIED',
  'SITE_VISIT_COMPLETED',
];

/**
 * FR-150: schedules a visit on a lead (site_visit.manage over the lead; a writable, open lead).
 * The lead moves to Site Visit Scheduled in the same transaction where the lifecycle allows it
 * (from New up to Qualified, with the same qualification check as a manual move, or from Site
 * Visit Completed for another visit); in Negotiation or Nurture the stage is left as it is.
 */
export async function scheduleVisit(
  ctx: RequestContext,
  leadId: string,
  raw: unknown,
): Promise<{ id: string; warning?: string }> {
  const scope = authorize(ctx, 'site_visit.manage');
  if (ctx.kind !== 'member') throw notFound('Lead not found');
  const input = scheduleInput.parse(raw);
  const now = new Date();
  return tenantRunner().withTenant(ctx.tenant, async (tx) => {
    const lead = await leads.lockLeadForInteraction(tx, ctx, scope, leadId);
    if (lead.archivedAt || lead.mergedIntoLeadId)
      throw ruleViolation('This lead is archived or merged and cannot change');
    if (lead.stage === 'WON' || lead.stage === 'LOST')
      throw ruleViolation('This lead is closed (Won or Lost). Reopen it before scheduling a visit');
    if (lead.contactStatus === 'DO_NOT_CONTACT') throw ruleViolation(VISIT_ON_DNC);
    const scheduledFor = await visitTime(tx, input.scheduledFor, now);
    const assignedUserId = await assigneeFor(tx, ctx, scope, input.assigneeUserId);
    const v = await tx.siteVisit.create({
      data: {
        orgId: ctx.orgId,
        leadId: lead.id,
        assignedUserId,
        scheduledBy: ctx.userId,
        scheduledFor,
        locationText: input.location,
      },
      select: { id: true, leadId: true },
    });
    await record(
      tx,
      ctx,
      v,
      { from: null, to: 'SCHEDULED', scheduledFor },
      {
        action: 'scheduled',
        scheduledFor: scheduledFor.toISOString(),
        ...(assignedUserId !== ctx.userId ? { assignedUserId } : {}),
      },
    );
    if (SCHEDULE_MOVES.includes(lead.stage))
      await moveStage(
        tx,
        ctx,
        lead,
        'SITE_VISIT_SCHEDULED',
        {
          visitAt: scheduledFor,
          ...(lead.stage === 'SITE_VISIT_COMPLETED'
            ? { reasonText: 'Another site visit scheduled' }
            : {}),
        },
        'SITE_VISIT_SCHEDULED',
        v.id,
        now,
      );
    const warning = await doubleBooking(tx, assignedUserId, scheduledFor, v.id);
    return warning ? { id: v.id, warning } : { id: v.id };
  });
}

/**
 * Owner decision 2026-10-30 (DNC): until the G5 review decides site visits on Do-Not-Contact
 * leads, a visit is not created or rescheduled on one. History stays visible and an existing
 * visit can still be cancelled. No override.
 */
const VISIT_ON_DNC =
  'This lead is marked Do not contact. A site visit cannot be scheduled or rescheduled.';

/**
 * Owner decision 2026-10-30 (Workflow D "double-booking an assignee → warning"): a provisional
 * 60-minute window, an assumption until a visit duration is specified. The salesperson's other
 * open visits starting within 60 minutes either side are counted; the save is never blocked.
 */
export const DOUBLE_BOOKING_MINUTES = 60;
async function doubleBooking(
  tx: Tx,
  assignedUserId: string,
  at: Date,
  exceptId: string,
): Promise<string | null> {
  const span = DOUBLE_BOOKING_MINUTES * 60_000;
  const n = await tx.siteVisit.count({
    where: {
      id: { not: exceptId },
      assignedUserId,
      status: { in: [...OPEN_VISIT_STATUSES] },
      scheduledFor: { gt: new Date(at.getTime() - span), lt: new Date(at.getTime() + span) },
    },
  });
  if (!n) return null;
  return n === 1
    ? `The salesperson has another site visit within ${DOUBLE_BOOKING_MINUTES} minutes of this one.`
    : `The salesperson has ${n} other site visits within ${DOUBLE_BOOKING_MINUTES} minutes of this one.`;
}

/**
 * FR-151/152: confirm, reschedule (new time + reason; same visit, count + 1), cancel (reason),
 * no-show (reason) or attended (interest level, objections, notes, next action required). Needs
 * site_visit.manage over the visit's lead, a writable lead and the expected version. Attended moves
 * a lead in Site Visit Scheduled to Site Visit Completed. Cancel and no-show move a lead back to
 * Qualified only when it is in Site Visit Scheduled and no other visit is open (owner decisions
 * 2026-10-30: a lead at Site Visit Completed never regresses). Rescheduling is refused on a
 * Do-Not-Contact lead; a reschedule that double-books the salesperson returns a warning.
 */
export async function updateVisit(
  ctx: RequestContext,
  visitId: string,
  raw: unknown,
): Promise<{ warning?: string }> {
  const scope = authorize(ctx, 'site_visit.manage');
  if (ctx.kind !== 'member') throw notFound('Visit not found');
  const input = actionInput.parse(raw);
  const id = z.uuid().safeParse(visitId);
  if (!id.success) throw notFound('Visit not found');
  const now = new Date();
  return tenantRunner().withTenant(ctx.tenant, async (tx): Promise<{ warning?: string }> => {
    const found = await tx.siteVisit.findFirst({
      where: { id: id.data },
      select: { leadId: true },
    });
    if (!found) throw notFound('Visit not found');
    // The lead first (scope + lock), then the visit, in that order for every visit command.
    const lead = await leads.lockLeadForInteraction(tx, ctx, scope, found.leadId).catch(() => {
      throw notFound('Visit not found');
    });
    await tx.$queryRaw`SELECT id FROM site_visit WHERE id = ${id.data}::uuid FOR UPDATE`;
    const v = await tx.siteVisit.findUniqueOrThrow({ where: { id: id.data } });
    if (v.leadId !== lead.id) throw conflict('This visit moved. Reload the page and try again.');
    if (lead.archivedAt || lead.mergedIntoLeadId)
      throw ruleViolation('This lead is archived or merged and cannot change');
    const problem = transitionProblem(v.status as VisitStatus, input.action);
    if (problem) throw ruleViolation(problem);
    if (v.version !== input.version)
      throw conflict('This visit was changed by someone else. Reload the page and try again.');
    const from = v.status as VisitStatus;
    const to = targetOf(input.action);
    const reason = input.reason || null;
    const timeZone = await orgZone(tx);

    if (input.action === 'confirm') {
      await tx.siteVisit.update({
        where: { id: v.id },
        data: { status: to, version: { increment: 1 }, updatedAt: now },
      });
      await record(tx, ctx, v, { from, to, scheduledFor: v.scheduledFor }, { action: 'confirmed' });
      return {};
    }
    if (input.action === 'reschedule') {
      if (lead.contactStatus === 'DO_NOT_CONTACT') throw ruleViolation(VISIT_ON_DNC);
      const at = await visitTime(tx, input.scheduledFor, now);
      const errors: Record<string, string[]> = {};
      if (at.getTime() === v.scheduledFor.getTime())
        errors.scheduledFor = ['Choose a different time'];
      if (!reason) errors.reason = ['Give a reason for rescheduling'];
      if (Object.keys(errors).length) throw invalid(errors);
      await tx.siteVisit.update({
        where: { id: v.id },
        data: {
          status: to,
          scheduledFor: at,
          rescheduleCount: { increment: 1 },
          version: { increment: 1 },
          updatedAt: now,
        },
      });
      await record(
        tx,
        ctx,
        v,
        { from, to, scheduledFor: at, previous: v.scheduledFor, reason },
        {
          action: 'rescheduled',
          scheduledFor: at.toISOString(),
          previousScheduledFor: v.scheduledFor.toISOString(),
          rescheduleCount: v.rescheduleCount + 1,
          reason,
        },
      );
      const warning = await doubleBooking(tx, v.assignedUserId, at, v.id);
      return warning ? { warning } : {};
    }
    if (input.action === 'cancel') {
      if (!reason) throw invalid({ reason: ['Give a reason for cancelling'] });
      await tx.$executeRaw`
        UPDATE site_visit SET status = 'CANCELLED', cancel_reason = ${reason}, closed_at = now(),
               version = version + 1, updated_at = now()
         WHERE id = ${v.id}::uuid`;
      await record(
        tx,
        ctx,
        v,
        { from, to, scheduledFor: v.scheduledFor, reason },
        { action: 'cancelled', scheduledFor: v.scheduledFor.toISOString(), reason },
      );
      const otherOpen = await tx.siteVisit.count({
        where: { leadId: lead.id, status: { in: [...OPEN_VISIT_STATUSES] } },
      });
      if (lead.stage === 'SITE_VISIT_SCHEDULED' && otherOpen === 0)
        await moveStage(
          tx,
          ctx,
          lead,
          'QUALIFIED',
          { reasonText: `Site visit cancelled: ${reason}` },
          'SITE_VISIT_CANCELLED',
          v.id,
          now,
        );
      return {};
    }
    // No-show and attended describe what happened: from the visit's own day onwards.
    if (outcomeTooEarly(dayIn(v.scheduledFor, timeZone), dayIn(now, timeZone)))
      throw ruleViolation('This visit has not taken place yet. Reschedule or cancel it instead.');
    if (input.action === 'no_show') {
      if (!reason) throw invalid({ reason: ['Give a reason for the no-show'] });
      await tx.$executeRaw`
        UPDATE site_visit SET status = 'NO_SHOW', no_show_reason = ${reason}, closed_at = now(),
               version = version + 1, updated_at = now()
         WHERE id = ${v.id}::uuid`;
      await record(
        tx,
        ctx,
        v,
        { from, to, scheduledFor: v.scheduledFor, reason },
        { action: 'no_show', scheduledFor: v.scheduledFor.toISOString(), reason },
      );
      // Owner decision 2026-10-30: as a cancellation, back to Qualified only from Site Visit
      // Scheduled with no other open visit.
      const otherOpen = await tx.siteVisit.count({
        where: { leadId: lead.id, status: { in: [...OPEN_VISIT_STATUSES] } },
      });
      if (lead.stage === 'SITE_VISIT_SCHEDULED' && otherOpen === 0)
        await moveStage(
          tx,
          ctx,
          lead,
          'QUALIFIED',
          { reasonText: `Site visit no-show: ${reason}` },
          'SITE_VISIT_NO_SHOW',
          v.id,
          now,
        );
      return {};
    }
    // Attended (FR-152).
    const errors: Record<string, string[]> = {};
    const interest = input.interestLevel || null;
    if (!interest) errors.interestLevel = ['Choose the interest level'];
    const nextAction = input.nextAction || null;
    if (!nextAction) errors.nextAction = ['Enter the next action'];
    const objections = parseObjections(input.objections);
    if (objections.length > MAX_OBJECTIONS)
      errors.objections = [`At most ${MAX_OBJECTIONS} objections`];
    if (objections.some((o) => o.length > 200))
      errors.objections = ['Each objection at most 200 characters'];
    const notes = input.notes?.replace(/\u0000/g, '').trim() || null;
    if (Object.keys(errors).length) throw invalid(errors);
    await tx.$executeRaw`
      UPDATE site_visit SET status = 'ATTENDED', attended_at = now(), closed_at = now(),
             interest_level = ${interest}, objections = ${objections}::text[],
             outcome_notes = ${notes}, next_action = ${nextAction},
             version = version + 1, updated_at = now()
       WHERE id = ${v.id}::uuid`;
    await record(
      tx,
      ctx,
      v,
      { from, to, scheduledFor: v.scheduledFor },
      {
        action: 'attended',
        scheduledFor: v.scheduledFor.toISOString(),
        interestLevel: interest as InterestLevel,
        objections: objections.length,
      },
    );
    if (lead.stage === 'SITE_VISIT_SCHEDULED')
      await moveStage(
        tx,
        ctx,
        lead,
        'SITE_VISIT_COMPLETED',
        { reasonText: `Site visit attended. Next: ${nextAction}` },
        'SITE_VISIT_ATTENDED',
        v.id,
        now,
      );
    return {};
  });
}

const VISIT_SELECT = {
  id: true,
  leadId: true,
  assignedUserId: true,
  scheduledBy: true,
  scheduledFor: true,
  locationText: true,
  status: true,
  rescheduleCount: true,
  cancelReason: true,
  noShowReason: true,
  attendedAt: true,
  interestLevel: true,
  objections: true,
  outcomeNotes: true,
  nextAction: true,
  version: true,
  assignee: { select: { user: { select: { name: true } } } },
  lead: { select: { id: true, fullName: true } },
} satisfies Prisma.SiteVisitSelect;
type VisitRow = Prisma.SiteVisitGetPayload<{ select: typeof VISIT_SELECT }>;

export interface VisitView {
  id: string;
  scheduledFor: Date;
  location: string;
  status: VisitStatus;
  rescheduleCount: number;
  cancelReason: string | null;
  noShowReason: string | null;
  attendedAt: Date | null;
  interestLevel: InterestLevel | null;
  objections: string[];
  outcomeNotes: string | null;
  nextAction: string | null;
  version: number;
  assignedUserId: string;
  assigneeName: string;
  /** The lead, when the caller may open it (an assigned agent may not). */
  lead: { id: string; fullName: string } | null;
  /** The visit's lead name for its assignee even without lead access (Workflow D). */
  leadName: string;
  /** The caller may change it (site_visit.manage over the lead, lead writable, visit open). */
  canManage: boolean;
  /** Attended / no-show can be recorded now (the visit's day has come). */
  outcomeDue: boolean;
}

function toView(
  v: VisitRow,
  opts: { leadVisible: boolean; canManage: boolean; today: string; timeZone: string },
): VisitView {
  const status = v.status as VisitStatus;
  return {
    id: v.id,
    scheduledFor: v.scheduledFor,
    location: v.locationText,
    status,
    rescheduleCount: v.rescheduleCount,
    cancelReason: v.cancelReason,
    noShowReason: v.noShowReason,
    attendedAt: v.attendedAt,
    interestLevel: v.interestLevel as InterestLevel | null,
    objections: v.objections,
    outcomeNotes: v.outcomeNotes,
    nextAction: v.nextAction,
    version: v.version,
    assignedUserId: v.assignedUserId,
    assigneeName: v.assignee.user.name,
    lead: opts.leadVisible ? v.lead : null,
    leadName: v.lead.fullName,
    canManage: opts.canManage && (OPEN_VISIT_STATUSES as readonly string[]).includes(status),
    outcomeDue: !outcomeTooEarly(dayIn(v.scheduledFor, opts.timeZone), opts.today),
  };
}

/**
 * The visits of one lead (site_visit.read over the lead): open first by time, then closed; and
 * whether the caller may schedule one (site_visit.manage, writable and open lead).
 */
export async function visitsForLead(
  ctx: RequestContext,
  leadId: string,
): Promise<{ visits: VisitView[]; canSchedule: boolean }> {
  const scope = authorize(ctx, 'site_visit.read');
  return tenantRunner().withTenant(ctx.tenant, async (tx) => {
    const lead = await leads.leadForTask(tx, ctx, scope, leadId, { write: false });
    const writable = !lead.archivedAt && !lead.mergedIntoLeadId;
    const manageScope = can(ctx, 'site_visit.manage') ? authorize(ctx, 'site_visit.manage') : null;
    const canManage =
      writable && manageScope !== null && (await leads.leadInScope(tx, ctx, manageScope, lead.id));
    const timeZone = await orgZone(tx);
    const today = dayIn(new Date(), timeZone);
    const rows = await tx.siteVisit.findMany({
      where: { leadId: lead.id },
      orderBy: [{ scheduledFor: 'desc' }, { id: 'desc' }],
      take: 50,
      select: VISIT_SELECT,
    });
    const open = rows
      .filter((r) => (OPEN_VISIT_STATUSES as readonly string[]).includes(r.status))
      .reverse();
    const closed = rows.filter(
      (r) => !(OPEN_VISIT_STATUSES as readonly string[]).includes(r.status),
    );
    return {
      visits: [...open, ...closed].map((r) =>
        toView(r, { leadVisible: true, canManage, today, timeZone }),
      ),
      canSchedule: canManage && lead.stage !== 'WON' && lead.stage !== 'LOST',
    };
  });
}

/**
 * The caller's visits page: visits on leads in their site_visit.read scope and visits assigned to
 * them (§4.3 "S + assigned visits"). Open visits by time, then the 20 most recent closed ones. An
 * assigned agent sees the visit and the lead's name, but the lead itself only within their scope.
 */
export async function myVisits(
  ctx: RequestContext,
): Promise<{ open: VisitView[]; closed: VisitView[] }> {
  const scope = authorize(ctx, 'site_visit.read');
  if (ctx.kind !== 'member') return { open: [], closed: [] };
  return tenantRunner().withTenant(ctx.tenant, async (tx) => {
    const inScope = await leads.leadScopeFilter(tx, ctx, scope);
    const where: Prisma.SiteVisitWhereInput = {
      OR: [{ assignedUserId: ctx.userId }, { lead: inScope }],
    };
    const [openRows, closedRows] = await Promise.all([
      tx.siteVisit.findMany({
        where: { AND: [where, { status: { in: [...OPEN_VISIT_STATUSES] } }] },
        orderBy: [{ scheduledFor: 'asc' }, { id: 'asc' }],
        take: 200,
        select: VISIT_SELECT,
      }),
      tx.siteVisit.findMany({
        where: { AND: [where, { status: { notIn: [...OPEN_VISIT_STATUSES] } }] },
        orderBy: [{ updatedAt: 'desc' }, { id: 'desc' }],
        take: 20,
        select: VISIT_SELECT,
      }),
    ]);
    const leadIds = [...new Set([...openRows, ...closedRows].map((r) => r.leadId))];
    const visible = new Set(
      leadIds.length
        ? (
            await tx.lead.findMany({
              where: { AND: [{ id: { in: leadIds } }, inScope] },
              select: { id: true },
            })
          ).map((l) => l.id)
        : [],
    );
    const timeZone = await orgZone(tx);
    const today = dayIn(new Date(), timeZone);
    const view = (r: VisitRow) =>
      // Changes happen on the lead page, where the lead scope and writability are checked.
      toView(r, { leadVisible: visible.has(r.leadId), canManage: false, today, timeZone });
    return { open: openRows.map(view), closed: closedRows.map(view) };
  });
}

/** People the caller may assign a visit to (the caller first), by their site_visit.manage scope. */
export async function visitAssigneeOptions(
  ctx: RequestContext,
): Promise<{ userId: string; name: string }[]> {
  if (ctx.kind !== 'member' || !can(ctx, 'site_visit.manage')) return [];
  const scope = authorize(ctx, 'site_visit.manage');
  if (scope === 'OWN') return [];
  return tenantRunner().withTenant(ctx.tenant, async (tx) => {
    let ids: string[] | null = null;
    if (scope === 'TEAM') {
      const led = await ledTeamIds(tx, ctx.membershipId);
      ids = led.length
        ? (
            await tx.teamMembership.findMany({
              where: { teamId: { in: led }, endedAt: null },
              select: { membershipId: true },
            })
          ).map((r) => r.membershipId)
        : [];
    }
    return (
      await tx.member.findMany({
        where: {
          status: 'ACTIVE',
          role: { in: SALES_ROLES },
          userId: { not: ctx.userId },
          ...(ids ? { id: { in: ids } } : {}),
        },
        orderBy: [{ user: { name: 'asc' } }, { userId: 'asc' }],
        take: 200,
        select: { userId: true, user: { select: { name: true } } },
      })
    ).map((m) => ({ userId: m.userId, name: m.user.name }));
  });
}

export interface AssignedVisit extends VisitView {
  /** The visit's org-local day (YYYY-MM-DD). */
  day: string;
  /** Its time has passed and it is still open: the outcome is due. */
  pastDue: boolean;
}

/**
 * Owner decision 2026-10-30: the caller's own OPEN visits (assigned to them) for My Day and their
 * personal calendar, from `fromDay` (org-local, inclusive; none = any earlier date, so a visit whose
 * outcome is due still shows) to `toDay` (exclusive), or through `nextDays` days after today. Never other people's visits, whatever the
 * caller's role. The lead is shown only within the caller's lead scope; changes are made on the
 * lead page.
 */
export async function assignedVisits(
  ctx: RequestContext,
  range: { fromDay?: string | undefined; toDay?: string | undefined; nextDays?: number },
): Promise<AssignedVisit[]> {
  const scope = authorize(ctx, 'site_visit.read');
  if (ctx.kind !== 'member') return [];
  return tenantRunner().withTenant(ctx.tenant, async (tx) => {
    const timeZone = await orgZone(tx);
    // With nextDays: up to the end of the day that many days after today (My Day: today + 7).
    const toDay = range.toDay ?? addDayKey(dayIn(new Date(), timeZone), (range.nextDays ?? 0) + 1);
    const to = leads.parseOrgLocal(toDay, timeZone);
    const from = range.fromDay ? leads.parseOrgLocal(range.fromDay, timeZone) : null;
    if (!to) return [];
    const rows = await tx.siteVisit.findMany({
      where: {
        assignedUserId: ctx.userId,
        status: { in: [...OPEN_VISIT_STATUSES] },
        scheduledFor: { lt: to, ...(from ? { gte: from } : {}) },
      },
      orderBy: [{ scheduledFor: 'asc' }, { id: 'asc' }],
      take: 500,
      select: VISIT_SELECT,
    });
    const leadIds = [...new Set(rows.map((r) => r.leadId))];
    const visible = new Set(
      leadIds.length
        ? (
            await tx.lead.findMany({
              where: {
                AND: [{ id: { in: leadIds } }, await leads.leadScopeFilter(tx, ctx, scope)],
              },
              select: { id: true },
            })
          ).map((l) => l.id)
        : [],
    );
    const now = new Date();
    const today = dayIn(now, timeZone);
    return rows.map((r) => ({
      pastDue: r.scheduledFor.getTime() < now.getTime(),
      ...toView(r, { leadVisible: visible.has(r.leadId), canManage: false, today, timeZone }),
      day: dayIn(r.scheduledFor, timeZone),
    }));
  });
}

const addDayKey = (key: string, n: number) => {
  const d = new Date(`${key}T00:00:00Z`);
  d.setUTCDate(d.getUTCDate() + n);
  return d.toISOString().slice(0, 10);
};
