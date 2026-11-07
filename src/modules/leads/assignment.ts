// Leads module (Phase 2 M3): assignment, reassignment, bulk and round-robin assignment,
// deactivation handover and assignment history (FR-063 assign, FR-070–FR-073, FR-075, FR-077;
// Workflow G; domain-model §2.2).
//
// Every ownership change goes through moveLead() inside the caller's withTenant() transaction:
// optimistic lock on lead.version, close the open spell and open the next one (both stamped
// with the database time, enforced by RLS), keep the system-managed NEW/ASSIGNED stage in step,
// and write the timeline entry. The command then writes one audit entry and one outbox event,
// so history, audit and notification intent commit or roll back together.
import { z } from 'zod';
import { writeAudit } from '@/modules/audit';
import { ledTeamIds } from '@/modules/teams';
import { authorize, can, scopeOf, type RequestContext, type Scope } from '@/platform/authz';
import { tenantRunner, type Tx } from '@/platform/db';
import { DomainError, forbidden, notFound, ruleViolation } from '@/platform/errors';
import { emitEvent } from '@/platform/outbox';
import {
  assertWritable,
  cleanText,
  invalid,
  OPEN,
  parseId,
  scopeFilter,
  staleVersion,
} from './access';
import { handOverLeadFollowUps } from './follow-up-lifecycle';
import type { LeadStage } from './stages';

/** Roles that can own leads (HR/Ops has no lead access, roles §4.1). */
const OWNER_ROLES = ['owner', 'admin', 'sales_manager', 'sales_executive'];
const MAX_BATCH = 100;

export type AssignmentSource = 'MANUAL' | 'BULK' | 'ROUND_ROBIN' | 'DEACTIVATION' | 'IMPORT';

interface Target {
  userId: string | null;
  teamId: string | null;
}

interface LockedLead {
  id: string;
  version: number;
  ownerUserId: string | null;
  teamId: string | null;
  stage: LeadStage;
  archivedAt: Date | null;
  mergedIntoLeadId: string | null;
}

const LEAD_FIELDS = {
  id: true,
  version: true,
  ownerUserId: true,
  teamId: true,
  stage: true,
  archivedAt: true,
  mergedIntoLeadId: true,
} as const;

// ---------------------------------------------------------------------------------------------
// Targets

/** "user:<id>", "team:<id>" or "queue" (the org-wide unassigned queue). */
const targetSchema = z.union([
  z.literal('queue'),
  z.string().regex(/^(user|team):[0-9a-f-]{36}$/i),
]);

function parseTarget(raw: unknown): { userId?: string; teamId?: string } {
  const r = targetSchema.safeParse(typeof raw === 'string' ? raw.trim() : raw);
  if (!r.success) throw invalid({ target: ['Choose who should own the lead'] });
  if (r.data === 'queue') return {};
  const [kind, id] = r.data.split(':') as ['user' | 'team', string];
  return kind === 'user' ? { userId: id.toLowerCase() } : { teamId: id.toLowerCase() };
}

/**
 * Validates a target against the caller's scope. A user must be an ACTIVE member with a role
 * that can own leads; with TEAM scope they must be in a team the caller leads (Workflow G: "the
 * manager must lead the target's team, or be admin"). A team must be active and, with TEAM
 * scope, led by the caller. The org-wide queue (no user, no team) needs ORG scope.
 */
async function resolveTarget(
  tx: Tx,
  ctx: RequestContext,
  scope: Scope,
  want: { userId?: string | undefined; teamId?: string | undefined },
  exclude?: string,
): Promise<Target> {
  const led =
    scope === 'TEAM' && ctx.kind === 'member' ? await ledTeamIds(tx, ctx.membershipId) : null;
  let teamId: string | null = null;
  if (want.teamId) {
    const team = await tx.team.findFirst({
      where: { id: want.teamId, archivedAt: null },
      select: { id: true },
    });
    if (!team || (led && !led.includes(team.id)))
      throw invalid({ target: ['Choose an active team you manage'] });
    teamId = team.id;
  }
  if (!want.userId) {
    if (!teamId && scope !== 'ORG')
      throw invalid({ target: ['Choose a person or one of your teams'] });
    return { userId: null, teamId };
  }
  const member = await tx.member.findFirst({
    where: { userId: want.userId, status: 'ACTIVE', role: { in: OWNER_ROLES } },
    select: { id: true, userId: true },
  });
  if (!member || member.userId === exclude)
    throw invalid({ target: ['Choose an active team member who can own leads'] });
  const spells = await tx.teamMembership.findMany({
    where: { membershipId: member.id, endedAt: null, team: { archivedAt: null } },
    orderBy: { startedAt: 'asc' },
    select: { teamId: true },
  });
  const teams = spells.map((s) => s.teamId);
  if (teamId) {
    if (!teams.includes(teamId))
      throw invalid({ target: ['That person is not a member of the chosen team'] });
  } else if (led) {
    // A manager assigns within a team they lead; the owner's team becomes that team.
    teamId = teams.find((t) => led.includes(t)) ?? null;
    if (!teamId) throw invalid({ target: ['Choose someone in a team you manage'] });
  } else teamId = teams[0] ?? null; // the owner's primary team (domain-model §2.2)
  return { userId: member.userId, teamId };
}

export interface AssignmentTargets {
  people: { userId: string; name: string }[];
  teams: { id: string; name: string }[];
  orgQueue: boolean;
}

/** Who the caller may assign to (for forms). The commands re-validate every target. */
export async function assignmentTargets(ctx: RequestContext): Promise<AssignmentTargets> {
  const scope = authorize(ctx, 'lead.assign');
  return tenantRunner().withTenant(ctx.tenant, async (tx) => {
    const led =
      scope === 'TEAM' && ctx.kind === 'member' ? await ledTeamIds(tx, ctx.membershipId) : null;
    const teams = await tx.team.findMany({
      where: { archivedAt: null, ...(led ? { id: { in: led } } : {}) },
      orderBy: { name: 'asc' },
      select: { id: true, name: true },
    });
    const people = await tx.member.findMany({
      where: {
        status: 'ACTIVE',
        role: { in: OWNER_ROLES },
        ...(led ? { teamMemberships: { some: { teamId: { in: led }, endedAt: null } } } : {}),
      },
      select: { userId: true, user: { select: { name: true } } },
    });
    return {
      people: people
        .map((p) => ({ userId: p.userId, name: p.user.name }))
        .sort((a, b) => a.name.localeCompare(b.name)),
      teams,
      orgQueue: scope === 'ORG',
    };
  });
}

// ---------------------------------------------------------------------------------------------
// The single write path for ownership changes

/** Returns false (and writes nothing) when the lead already has exactly this owner and team. */
async function moveLead(
  tx: Tx,
  ctx: RequestContext,
  lead: LockedLead,
  target: Target,
  source: AssignmentSource,
  reason: string | null,
): Promise<boolean> {
  if (lead.ownerUserId === target.userId && lead.teamId === target.teamId) return false;
  // ASSIGNED is system-managed (lead-lifecycle §2): owner set on a New lead → Assigned;
  // owner removed from an Assigned lead → back to New. Other stages are kept.
  const stage: LeadStage =
    target.userId && lead.stage === 'NEW'
      ? 'ASSIGNED'
      : !target.userId && lead.stage === 'ASSIGNED'
        ? 'NEW'
        : lead.stage;
  const res = await tx.lead.updateMany({
    where: { id: lead.id, version: lead.version },
    data: {
      ownerUserId: target.userId,
      teamId: target.teamId,
      stage,
      version: { increment: 1 },
      updatedAt: new Date(),
    },
  });
  if (res.count !== 1) throw staleVersion();
  // Workflow G / FR-077 (ADR-0010): the previous owner's open follow-ups follow the lead.
  if (lead.ownerUserId && lead.ownerUserId !== target.userId)
    await handOverLeadFollowUps(
      tx,
      ctx,
      lead.id,
      lead.ownerUserId,
      target.userId,
      source === 'DEACTIVATION' ? 'DEACTIVATED' : 'REASSIGNED',
    );
  // Close the open spell and open the next one; both timestamps are the transaction time
  // (now()), enforced by the lead_assignment_history RLS policies.
  await tx.$executeRawUnsafe(
    'UPDATE lead_assignment_history SET ended_at = now() WHERE lead_id = $1::uuid AND ended_at IS NULL',
    lead.id,
  );
  if (target.userId || target.teamId)
    await tx.leadAssignmentHistory.create({
      data: {
        orgId: ctx.orgId,
        leadId: lead.id,
        userId: target.userId,
        teamId: target.teamId,
        assignedBy: ctx.userId,
        source,
        reason,
      },
      select: { id: true },
    });
  if (stage !== lead.stage)
    await tx.leadStageHistory.create({
      data: {
        orgId: ctx.orgId,
        leadId: lead.id,
        fromStage: lead.stage,
        toStage: stage,
        changedBy: ctx.userId,
        source: 'USER',
        reasonCode: 'ASSIGNMENT',
      },
    });
  await tx.leadActivity.create({
    data: {
      orgId: ctx.orgId,
      leadId: lead.id,
      type: 'ASSIGNED',
      actorId: ctx.userId,
      summary: {
        fromUserId: lead.ownerUserId,
        toUserId: target.userId,
        teamId: target.teamId,
        source,
        ...(stage !== lead.stage ? { stage } : {}),
      },
    },
  });
  return true;
}

function previousOwners(leads: LockedLead[], to: string | null) {
  const counts = new Map<string, number>();
  for (const l of leads)
    if (l.ownerUserId && l.ownerUserId !== to)
      counts.set(l.ownerUserId, (counts.get(l.ownerUserId) ?? 0) + 1);
  return [...counts].map(([userId, count]) => ({ userId, count }));
}

async function emitAssigned(
  tx: Tx,
  ctx: RequestContext,
  moved: LockedLead[],
  target: Target,
  source: AssignmentSource,
): Promise<void> {
  if (!moved.length) return;
  await emitEvent(tx, ctx.orgId, {
    type: 'lead.assigned',
    payload: {
      leadIds: moved.map((l) => l.id),
      toUserId: target.userId,
      teamId: target.teamId,
      previousOwners: previousOwners(moved, target.userId),
      actorUserId: ctx.userId,
      source,
    },
  });
}

/** Loads leads inside the caller's assign scope; any id outside it fails the whole request. */
async function loadForAssignment(
  tx: Tx,
  ctx: RequestContext,
  scope: Scope,
  ids: string[],
): Promise<LockedLead[]> {
  const rows = await tx.lead.findMany({
    where: { AND: [{ id: { in: ids } }, await scopeFilter(tx, ctx, scope)] },
    select: LEAD_FIELDS,
  });
  if (rows.length !== ids.length) throw notFound('Lead not found');
  const byId = new Map(rows.map((r) => [r.id, r]));
  return ids.map((id) => byId.get(id)!);
}

/** Reassigning an owned lead needs lead.reassign and a reason (FR-070); assigning needs lead.assign. */
function checkReassign(ctx: RequestContext, leads: LockedLead[], reason: string | null): void {
  if (leads.some((l) => l.ownerUserId)) {
    authorize(ctx, 'lead.reassign');
    if (!reason) throw invalid({ reason: ['Give a reason for reassigning'] });
  }
  if (leads.some((l) => l.stage === 'WON' || l.stage === 'LOST'))
    throw ruleViolation('Closed (won or lost) leads cannot be reassigned');
  // M5: merged and archived leads cannot be (re)assigned (deactivation handover excepted).
  for (const l of leads) assertWritable(l);
}

const reasonSchema = z
  .string()
  .max(500)
  .optional()
  .transform((v) => (v ? cleanText(v) || null : null));

// ---------------------------------------------------------------------------------------------
// Commands

const assignInput = z.object({
  target: z.string(),
  version: z.coerce.number().int().min(1),
  reason: reasonSchema,
});

/** Assign an unassigned lead or reassign an owned one (FR-070, Workflow G). */
export async function assignLead(ctx: RequestContext, leadId: string, raw: unknown): Promise<void> {
  const scope = authorize(ctx, 'lead.assign');
  const id = parseId(leadId);
  const input = assignInput.parse(raw);
  const want = parseTarget(input.target);
  await tenantRunner().withTenant(ctx.tenant, async (tx) => {
    const [lead] = await loadForAssignment(tx, ctx, scope, [id]);
    if (lead!.version !== input.version) throw staleVersion();
    checkReassign(ctx, [lead!], input.reason);
    const target = await resolveTarget(tx, ctx, scope, want);
    if (!(await moveLead(tx, ctx, lead!, target, 'MANUAL', input.reason))) return;
    await writeAudit(tx, ctx.orgId, {
      action: lead!.ownerUserId ? 'lead.reassigned' : 'lead.assigned',
      entityType: 'lead',
      entityId: id,
      actorUserId: ctx.userId,
      metadata: {
        fromUserId: lead!.ownerUserId,
        toUserId: target.userId,
        teamId: target.teamId,
        source: 'MANUAL',
      },
    });
    await emitAssigned(tx, ctx, [lead!], target, 'MANUAL');
  });
}

const bulkInput = z.object({
  leadIds: z.array(z.uuid()).min(1, 'Select at least one lead').max(MAX_BATCH),
  target: z.string(),
  reason: reasonSchema,
});

/**
 * FR-063 bulk assign (selection up to 100): all-or-nothing in one transaction, one audit entry
 * with the item list and one outbox event, so the new owner gets one digest (FR-075/FR-120).
 */
export async function bulkAssign(ctx: RequestContext, raw: unknown): Promise<{ moved: number }> {
  const scope = authorize(ctx, 'lead.assign');
  const input = bulkInput.parse(raw);
  const ids = [...new Set(input.leadIds.map((i) => i.toLowerCase()))].sort();
  const want = parseTarget(input.target);
  return tenantRunner().withTenant(ctx.tenant, async (tx) => {
    const leads = await loadForAssignment(tx, ctx, scope, ids);
    checkReassign(ctx, leads, input.reason);
    const target = await resolveTarget(tx, ctx, scope, want);
    const moved: LockedLead[] = [];
    for (const lead of leads)
      if (await moveLead(tx, ctx, lead, target, 'BULK', input.reason)) moved.push(lead);
    if (moved.length) {
      await writeAudit(tx, ctx.orgId, {
        action: 'lead.bulk_assigned',
        entityType: 'lead',
        actorUserId: ctx.userId,
        metadata: {
          count: moved.length,
          leadIds: moved.map((l) => l.id).join(','),
          toUserId: target.userId,
          teamId: target.teamId,
          source: 'BULK',
        },
      });
      await emitAssigned(tx, ctx, moved, target, 'BULK');
    }
    return { moved: moved.length };
  });
}

const changeTeamInput = z.object({
  leadIds: z.array(z.uuid()).min(1, 'Select at least one lead').max(MAX_BATCH),
  teamId: z.uuid({ message: 'Choose a team' }),
});

/**
 * FR-063 bulk "change team" (selection up to 100): every lead keeps its owner and moves to the
 * target team; unassigned leads go to that team's queue. All or nothing, through moveLead (history,
 * stage rules, timeline), one audit entry. Same rules as assignment: lead.assign in scope, an
 * active team (one the caller leads with TEAM scope), no closed, archived or merged leads, and an
 * owner must already be in the target team (changing the owner is "Assign", which needs a reason).
 * Owners do not change, so nobody is notified.
 */
export async function bulkChangeTeam(
  ctx: RequestContext,
  raw: unknown,
): Promise<{ moved: number; unchanged: number }> {
  const scope = authorize(ctx, 'lead.assign');
  const input = changeTeamInput.parse(raw);
  const ids = [...new Set(input.leadIds.map((i) => i.toLowerCase()))].sort();
  return tenantRunner().withTenant(ctx.tenant, async (tx) => {
    // Lock the selection in id order (as bulk archive), then load it within the caller's scope.
    await tx.$queryRaw`SELECT id FROM lead WHERE id = ANY(${ids}::uuid[]) ORDER BY id FOR UPDATE`;
    const leads = await loadForAssignment(tx, ctx, scope, ids);
    if (leads.some((l) => l.stage === 'WON' || l.stage === 'LOST'))
      throw ruleViolation('Closed (won or lost) leads cannot change team; nothing was changed');
    for (const l of leads) assertWritable(l);
    const { teamId } = await resolveTarget(tx, ctx, scope, { teamId: input.teamId.toLowerCase() });
    const owners = [...new Set(leads.flatMap((l) => (l.ownerUserId ? [l.ownerUserId] : [])))];
    const inTeam = new Set(
      (
        await tx.teamMembership.findMany({
          where: { teamId: teamId!, endedAt: null, membership: { userId: { in: owners } } },
          select: { membership: { select: { userId: true } } },
        })
      ).map((m) => m.membership.userId),
    );
    const outside = leads.filter((l) => l.ownerUserId && !inTeam.has(l.ownerUserId));
    if (outside.length)
      throw new DomainError(
        'RULE_VIOLATION',
        `${outside.length} selected ${outside.length === 1 ? 'lead is' : 'leads are'} owned by someone who is not in that team. Reassign ${outside.length === 1 ? 'it' : 'them'} first; nothing was changed`,
        { leadIds: outside.map((l) => l.id) },
      );
    const moved: LockedLead[] = [];
    for (const lead of leads)
      if (await moveLead(tx, ctx, lead, { userId: lead.ownerUserId, teamId }, 'BULK', null))
        moved.push(lead);
    if (moved.length)
      await writeAudit(tx, ctx.orgId, {
        action: 'lead.bulk_team_changed',
        entityType: 'lead',
        actorUserId: ctx.userId,
        metadata: { count: moved.length, leadIds: moved.map((l) => l.id).join(','), teamId },
      });
    return { moved: moved.length, unchanged: leads.length - moved.length };
  });
}

const roundRobinInput = z.object({
  leadIds: z.array(z.uuid()).min(1, 'Select at least one lead').max(MAX_BATCH),
  teamId: z.uuid(),
});

/**
 * FR-073 (basic): unassigned leads are dealt in turn to the team's eligible members — current
 * team members whose membership is ACTIVE and whose role can own leads — ordered by membership
 * id, continuing after the team's pointer. The pointer row is locked (SELECT … FOR UPDATE), so
 * concurrent requests for a team are serialised and each continues where the last stopped.
 * Leave-aware skipping is Phase 4. No eligible member: nothing is assigned (RULE_VIOLATION).
 */
export async function roundRobinAssign(
  ctx: RequestContext,
  raw: unknown,
): Promise<{ assigned: { leadId: string; userId: string }[] }> {
  const scope = authorize(ctx, 'lead.assign');
  const input = roundRobinInput.parse(raw);
  const ids = [...new Set(input.leadIds.map((i) => i.toLowerCase()))].sort();
  return tenantRunner().withTenant(ctx.tenant, async (tx) => {
    await resolveTarget(tx, ctx, scope, { teamId: input.teamId }); // team exists and is in scope
    const leads = await loadForAssignment(tx, ctx, scope, ids);
    if (leads.some((l) => l.ownerUserId))
      throw ruleViolation('Round-robin assigns unassigned leads only');
    checkReassign(ctx, leads, null);

    const dealer = await roundRobinDealer(tx, ctx, input.teamId);
    const assigned: { leadId: string; userId: string }[] = [];
    const byUser = new Map<string, LockedLead[]>();
    for (const lead of leads) {
      const next = dealer.next();
      await moveLead(tx, ctx, lead, next, 'ROUND_ROBIN', null);
      assigned.push({ leadId: lead.id, userId: next.userId });
      byUser.set(next.userId, [...(byUser.get(next.userId) ?? []), lead]);
    }
    await dealer.save();
    await writeAudit(tx, ctx.orgId, {
      action: 'lead.round_robin_assigned',
      entityType: 'team',
      entityId: input.teamId,
      actorUserId: ctx.userId,
      metadata: { count: assigned.length, leadIds: ids.join(','), source: 'ROUND_ROBIN' },
    });
    // One digest per assignee.
    for (const [userId, theirs] of byUser)
      await emitAssigned(tx, ctx, theirs, { userId, teamId: input.teamId }, 'ROUND_ROBIN');
    return { assigned };
  });
}

/**
 * The team's round-robin pointer, locked for the rest of the transaction (SELECT … FOR UPDATE),
 * so concurrent assignments for a team are serialised. `next()` deals in membership-id order
 * after the pointer; `save()` stores where it stopped. Used by roundRobinAssign and imports.
 */
async function roundRobinDealer(tx: Tx, ctx: RequestContext, teamId: string) {
  await tx.$executeRawUnsafe(
    `INSERT INTO team_assignment_state (team_id, org_id) VALUES ($1::uuid, $2::uuid)
     ON CONFLICT (team_id) DO NOTHING`,
    teamId,
    ctx.orgId,
  );
  const [state] = await tx.$queryRawUnsafe<{ last: string | null }[]>(
    `SELECT last_assigned_membership_id::text AS last FROM team_assignment_state
     WHERE team_id = $1::uuid FOR UPDATE`,
    teamId,
  );
  const eligible = await eligibleMembers(tx, teamId);
  if (!eligible.length)
    throw ruleViolation('No active member of this team can take leads. Nothing was assigned.');
  let last = state?.last ?? null;
  return {
    next(): { userId: string; teamId: string } {
      const m = eligible.find((e) => last !== null && e.membershipId > last) ?? eligible[0]!;
      last = m.membershipId;
      return { userId: m.userId, teamId };
    },
    async save() {
      await tx.$executeRawUnsafe(
        `UPDATE team_assignment_state SET last_assigned_membership_id = $2::uuid, updated_at = now()
         WHERE team_id = $1::uuid`,
        teamId,
        last,
      );
    },
  };
}

// ---------------------------------------------------------------------------------------------
// Import-time assignment (FR-051): the same targets, scope checks and round-robin pointer as
// manual assignment; assignment history records source IMPORT.

export const importAssignmentSchema = z.discriminatedUnion('mode', [
  z.object({ mode: z.literal('none') }),
  z.object({ mode: z.literal('target'), target: targetSchema }),
  z.object({ mode: z.literal('round_robin'), teamId: z.uuid() }),
]);
export type ImportAssignment = z.infer<typeof importAssignmentSchema>;

export interface ImportAssigner {
  /** Owner and team for the next new lead. */
  next(): Target;
  /** Persists the round-robin pointer; call once before the transaction commits. */
  finish(): Promise<void>;
}

/**
 * Resolves the import's assignment inside the batch transaction. Re-validated for every batch,
 * so a target who was suspended or removed mid-import stops the import instead of receiving
 * leads. "none" leaves leads unassigned in the org queue, which needs ORG scope like manual
 * assignment to the org queue.
 */
export async function importAssigner(
  tx: Tx,
  ctx: RequestContext,
  raw: unknown,
): Promise<ImportAssigner> {
  const plan = importAssignmentSchema.parse(raw);
  const noop = async () => {};
  if (plan.mode === 'none') {
    if (scopeOf(ctx, 'lead.assign') !== 'ORG')
      throw forbidden('Only Owners and Admins can leave imported leads unassigned');
    return { next: () => ({ userId: null, teamId: null }), finish: noop };
  }
  const scope = authorize(ctx, 'lead.assign');
  if (plan.mode === 'target') {
    const target = await resolveTarget(tx, ctx, scope, parseTarget(plan.target));
    return { next: () => target, finish: noop };
  }
  await resolveTarget(tx, ctx, scope, { teamId: plan.teamId });
  const dealer = await roundRobinDealer(tx, ctx, plan.teamId);
  return { next: () => dealer.next(), finish: () => dealer.save() };
}

/** Assignment notification for imported leads: one digest event per assignee (FR-120). */
export async function emitImportAssigned(
  tx: Tx,
  ctx: RequestContext,
  created: { leadId: string; userId: string | null; teamId: string | null }[],
): Promise<void> {
  const groups = new Map<string, { target: Target; leads: LockedLead[] }>();
  for (const c of created) {
    if (!c.userId) continue;
    const k = `${c.userId}:${c.teamId ?? ''}`;
    const g = groups.get(k) ?? { target: { userId: c.userId, teamId: c.teamId }, leads: [] };
    g.leads.push({
      id: c.leadId,
      version: 1,
      ownerUserId: null,
      teamId: null,
      stage: 'NEW',
      archivedAt: null,
      mergedIntoLeadId: null,
    });
    groups.set(k, g);
  }
  for (const g of groups.values()) await emitAssigned(tx, ctx, g.leads, g.target, 'IMPORT');
}

/** Current, ACTIVE team members who can own leads, in membership-id order (deterministic). */
async function eligibleMembers(tx: Tx, teamId: string) {
  const rows = await tx.teamMembership.findMany({
    where: {
      teamId,
      endedAt: null,
      membership: { status: 'ACTIVE', role: { in: OWNER_ROLES } },
    },
    select: { membershipId: true, membership: { select: { userId: true } } },
  });
  const seen = new Set<string>();
  return rows
    .filter((r) => !seen.has(r.membershipId) && seen.add(r.membershipId))
    .map((r) => ({ membershipId: r.membershipId, userId: r.membership.userId }))
    .sort((a, b) => (a.membershipId < b.membershipId ? -1 : 1));
}

// ---------------------------------------------------------------------------------------------
// Deactivation handover (FR-077)

/** Open leads owned per user (for the people page: who still needs a handover). */
export async function openLeadCounts(ctx: RequestContext): Promise<Map<string, number>> {
  const scope = authorize(ctx, 'lead.read');
  if (scope !== 'ORG') return new Map();
  return tenantRunner().withTenant(ctx.tenant, async (tx) => {
    const rows = await tx.lead.groupBy({
      by: ['ownerUserId'],
      where: { ...OPEN, ownerUserId: { not: null } },
      _count: { _all: true },
    });
    return new Map(rows.map((r) => [r.ownerUserId!, r._count._all]));
  });
}

export async function countOpenLeadsOwnedBy(tx: Tx, userId: string): Promise<number> {
  return tx.lead.count({ where: { ...OPEN, ownerUserId: userId } });
}

/**
 * Moves every open lead owned by a departing user to `rawTarget` ("user:<id>", "team:<id>" or
 * "queue") inside the caller's transaction (the deactivation), so the handover and the
 * deactivation commit together or not at all. Needs ORG-scope lead.reassign.
 */
export async function handOverOpenLeads(
  tx: Tx,
  ctx: RequestContext,
  fromUserId: string,
  rawTarget: unknown,
): Promise<number> {
  if (authorize(ctx, 'lead.reassign') !== 'ORG')
    throw ruleViolation('Only an Owner or Admin can hand over leads');
  const target = await resolveTarget(tx, ctx, 'ORG', parseTarget(rawTarget), fromUserId);
  const leads = await tx.lead.findMany({
    where: { ...OPEN, ownerUserId: fromUserId },
    orderBy: { id: 'asc' },
    select: LEAD_FIELDS,
  });
  for (const lead of leads)
    await moveLead(tx, ctx, lead, target, 'DEACTIVATION', 'Previous owner deactivated');
  if (leads.length) {
    await writeAudit(tx, ctx.orgId, {
      action: 'lead.handover',
      entityType: 'lead',
      actorUserId: ctx.userId,
      metadata: {
        count: leads.length,
        fromUserId,
        toUserId: target.userId,
        teamId: target.teamId,
        source: 'DEACTIVATION',
      },
    });
    await emitAssigned(tx, ctx, leads, target, 'DEACTIVATION');
  }
  return leads.length;
}

// ---------------------------------------------------------------------------------------------
// History (FR-071)

export interface AssignmentSpell {
  id: string;
  ownerName: string | null;
  teamName: string | null;
  assignedByName: string | null;
  source: string;
  reason: string | null;
  startedAt: Date;
  endedAt: Date | null;
}

export async function getAssignmentHistory(
  ctx: RequestContext,
  leadId: string,
): Promise<AssignmentSpell[]> {
  const scope = authorize(ctx, 'lead.view_assignment_history');
  const id = parseId(leadId);
  return tenantRunner().withTenant(ctx.tenant, async (tx) => {
    const lead = await tx.lead.findFirst({
      where: { AND: [{ id }, await scopeFilter(tx, ctx, scope)] },
      select: { id: true },
    });
    if (!lead) throw notFound('Lead not found');
    const rows = await tx.leadAssignmentHistory.findMany({
      where: { leadId: id },
      orderBy: [{ startedAt: 'desc' }, { id: 'desc' }],
      take: 100,
      select: {
        id: true,
        source: true,
        reason: true,
        startedAt: true,
        endedAt: true,
        user: { select: { user: { select: { name: true } } } },
        team: { select: { name: true } },
        assigner: { select: { user: { select: { name: true } } } },
      },
    });
    return rows.map((r) => ({
      id: r.id,
      ownerName: r.user?.user.name ?? null,
      teamName: r.team?.name ?? null,
      assignedByName: r.assigner?.user.name ?? null,
      source: r.source,
      reason: r.reason,
      startedAt: r.startedAt,
      endedAt: r.endedAt,
    }));
  });
}

/** Whether the caller may assign/reassign this particular lead (UI hint; commands re-check). */
export async function canAssignLead(
  tx: Tx,
  ctx: RequestContext,
  lead: { id: string; ownerUserId: string | null },
): Promise<boolean> {
  const perm = lead.ownerUserId ? 'lead.reassign' : 'lead.assign';
  if (!can(ctx, perm)) return false;
  return !!(await tx.lead.findFirst({
    where: { AND: [{ id: lead.id }, await scopeFilter(tx, ctx, authorize(ctx, perm))] },
    select: { id: true },
  }));
}
