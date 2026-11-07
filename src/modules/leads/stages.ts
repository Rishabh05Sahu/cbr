// Leads module: sales-stage rules (lead-lifecycle §2, §2.1, §2.2). Pure functions, no database
// access: the command in ./index.ts loads the lead, asks planStageChange() what to write, and
// writes it in one transaction.
import { DomainError, ruleViolation } from '@/platform/errors';

export const LEAD_STAGES = [
  'NEW',
  'ASSIGNED',
  'CONTACTED',
  'QUALIFIED',
  'SITE_VISIT_SCHEDULED',
  'SITE_VISIT_COMPLETED',
  'NEGOTIATION',
  'WON',
  'LOST',
  'NURTURE',
] as const;
export type LeadStage = (typeof LEAD_STAGES)[number];

export const STAGE_LABELS: Record<LeadStage, string> = {
  NEW: 'New',
  ASSIGNED: 'Assigned',
  CONTACTED: 'Contacted',
  QUALIFIED: 'Qualified',
  SITE_VISIT_SCHEDULED: 'Site visit scheduled',
  SITE_VISIT_COMPLETED: 'Site visit completed',
  NEGOTIATION: 'Negotiation',
  WON: 'Won',
  LOST: 'Lost',
  NURTURE: 'Nurture',
};

/**
 * Lost reasons. lead-lifecycle §2 makes the list org-configurable (OrgSettings, not built yet);
 * until then every org uses this default list.
 */
export const LOST_REASONS = {
  NOT_INTERESTED: 'Not interested',
  BOUGHT_ELSEWHERE: 'Bought or rented elsewhere',
  BUDGET_MISMATCH: 'Budget mismatch',
  LOCATION_MISMATCH: 'Location mismatch',
  NOT_REACHABLE: 'Not reachable',
  INVALID_ENQUIRY: 'Invalid or fake enquiry',
  OTHER: 'Other',
} as const;
export type LostReason = keyof typeof LOST_REASONS;

/**
 * Transitions a user may make (the §2 diagram). ASSIGNED is system-managed and never a target;
 * WON is terminal (a cancelled booking is handled on the Deal, Phase 5). From NEW/ASSIGNED/
 * CONTACTED a lead may move forward past Contacted/Qualified (§2.1); the skipped milestones are
 * recorded as implied.
 */
const TRANSITIONS: Record<LeadStage, readonly LeadStage[]> = {
  NEW: ['CONTACTED', 'QUALIFIED', 'SITE_VISIT_SCHEDULED'],
  ASSIGNED: ['CONTACTED', 'QUALIFIED', 'SITE_VISIT_SCHEDULED', 'LOST'],
  CONTACTED: ['QUALIFIED', 'SITE_VISIT_SCHEDULED', 'NURTURE', 'LOST'],
  QUALIFIED: ['SITE_VISIT_SCHEDULED', 'NURTURE', 'LOST'],
  SITE_VISIT_SCHEDULED: ['SITE_VISIT_COMPLETED', 'QUALIFIED'],
  SITE_VISIT_COMPLETED: ['SITE_VISIT_SCHEDULED', 'NEGOTIATION', 'NURTURE', 'LOST'],
  NEGOTIATION: ['WON', 'LOST', 'NURTURE'],
  NURTURE: ['CONTACTED'],
  LOST: ['CONTACTED'],
  WON: [],
};

/** Backward moves along the diagram; each needs a reason (§2.1). */
const BACKWARD = new Set([
  'SITE_VISIT_SCHEDULED>QUALIFIED',
  'SITE_VISIT_COMPLETED>SITE_VISIT_SCHEDULED',
  'LOST>CONTACTED',
]);

/** Main chain, in funnel order, for implied milestones. */
const CHAIN: readonly LeadStage[] = [
  'NEW',
  'ASSIGNED',
  'CONTACTED',
  'QUALIFIED',
  'SITE_VISIT_SCHEDULED',
];

export const MILESTONE_FIELD = {
  CONTACTED: 'firstContactedAt',
  QUALIFIED: 'qualifiedAt',
  SITE_VISIT_SCHEDULED: 'firstVisitScheduledAt',
  SITE_VISIT_COMPLETED: 'firstVisitCompletedAt',
  WON: 'wonAt',
  LOST: 'lostAt',
} as const satisfies Partial<Record<LeadStage, string>>;
export type MilestoneField = (typeof MILESTONE_FIELD)[keyof typeof MILESTONE_FIELD];

export function allowedTargets(from: LeadStage): readonly LeadStage[] {
  return TRANSITIONS[from];
}

/** The lead's qualification fields (§2: "minimum requirement set", default). */
export interface QualificationFields {
  transactionType: string | null;
  propertyType: string | null;
  preferredCity: string | null;
  budgetMin: unknown;
  budgetMax: unknown;
}

export interface StageChangeRequest {
  to: LeadStage;
  reasonCode?: string | undefined;
  reasonText?: string | undefined;
  visitAt?: Date | undefined;
  nurtureUntil?: Date | undefined;
}

export interface StageStep {
  from: LeadStage;
  to: LeadStage;
  implied: boolean;
}

export interface StagePlan {
  steps: StageStep[];
  reasonCode: string | null;
  reasonText: string | null;
  /** Display-ready extras for the timeline (visit time, nurture date). */
  details: Record<string, string>;
}

const MAX_AHEAD_MS = 2 * 366 * 24 * 3600 * 1000;

/**
 * Validates a user's stage change and returns the history steps to write. Throws
 * RULE_VIOLATION for a transition the rules forbid, VALIDATION_FAILED for missing entry data.
 * `canReopen` is true for TEAM/ORG scope (§2.1: reopening Lost needs manager scope).
 */
export function planStageChange(
  from: LeadStage,
  req: StageChangeRequest,
  lead: QualificationFields,
  opts: { canReopen: boolean; now: Date },
): StagePlan {
  const { to } = req;
  if (from === to) throw ruleViolation(`The lead is already ${STAGE_LABELS[to]}`);
  if (from === 'WON') throw ruleViolation('A won lead cannot change stage');
  if (to === 'ASSIGNED' || to === 'NEW')
    throw ruleViolation('This stage is set automatically by assignment');
  if (!TRANSITIONS[from].includes(to))
    throw ruleViolation(`A lead cannot move from ${STAGE_LABELS[from]} to ${STAGE_LABELS[to]}`);
  if (from === 'LOST' && !opts.canReopen)
    throw ruleViolation('Only a manager can reopen a lost lead');

  const errors: Record<string, string[]> = {};
  const reasonText = req.reasonText?.trim() || null;
  let reasonCode: string | null = null;
  const details: Record<string, string> = {};

  const fi = CHAIN.indexOf(from);
  const ti = CHAIN.indexOf(to);
  const implied =
    fi >= 0 && ti > fi + 1 ? CHAIN.slice(Math.max(fi + 1, CHAIN.indexOf('CONTACTED')), ti) : [];

  if (BACKWARD.has(`${from}>${to}`) && !reasonText)
    errors.reasonText = ['Give a reason for moving the lead back'];

  // Entering (or passing through) Qualified needs the minimum requirement set. A lead coming
  // back from a cancelled visit already met it when it was first qualified.
  if ((to === 'QUALIFIED' && from !== 'SITE_VISIT_SCHEDULED') || implied.includes('QUALIFIED')) {
    const missing = missingQualification(lead);
    if (missing.length) errors.stage = [`Fill in ${missing.join(', ')} before qualifying the lead`];
  }
  if (to === 'SITE_VISIT_SCHEDULED') {
    if (!req.visitAt) errors.visitAt = ['Enter the visit date and time'];
    else if (!isFutureWithin(req.visitAt, opts.now))
      errors.visitAt = ['The visit must be in the future (within two years)'];
    else details.visitAt = req.visitAt.toISOString();
  }
  if (to === 'SITE_VISIT_COMPLETED' && !reasonText)
    errors.reasonText = ['Enter the visit feedback'];
  if (to === 'LOST') {
    if (!req.reasonCode || !Object.hasOwn(LOST_REASONS, req.reasonCode))
      errors.reasonCode = ['Choose a lost reason'];
    else reasonCode = req.reasonCode;
  }
  if (to === 'NURTURE') {
    if (!req.nurtureUntil) errors.nurtureUntil = ['Enter the date to follow up again'];
    else if (!isFutureWithin(req.nurtureUntil, opts.now))
      errors.nurtureUntil = ['The follow-up date must be in the future (within two years)'];
    else details.nurtureUntil = req.nurtureUntil.toISOString();
  }
  if (Object.keys(errors).length)
    throw new DomainError('VALIDATION_FAILED', 'Please check the highlighted fields', errors);

  const path = [from, ...implied, to];
  const steps = path.slice(1).map((s, i) => ({ from: path[i]!, to: s, implied: s !== to }));
  return { steps, reasonCode, reasonText, details };
}

export function missingQualification(lead: QualificationFields): string[] {
  const missing: string[] = [];
  if (!lead.transactionType) missing.push('transaction type');
  if (!lead.propertyType) missing.push('property type');
  if (!lead.preferredCity) missing.push('city');
  if (lead.budgetMin == null && lead.budgetMax == null) missing.push('budget');
  return missing;
}

/** Milestone timestamps first reached by these steps (§2.2: set once, never cleared). */
export function milestonesReached(
  steps: StageStep[],
  current: Partial<Record<MilestoneField, Date | null>>,
  now: Date,
): Partial<Record<MilestoneField, Date>> {
  const out: Partial<Record<MilestoneField, Date>> = {};
  for (const { to } of steps) {
    const field = (MILESTONE_FIELD as Partial<Record<LeadStage, MilestoneField>>)[to];
    if (field && !current[field]) out[field] = now;
  }
  return out;
}

function isFutureWithin(d: Date, now: Date): boolean {
  const t = d.getTime();
  return Number.isFinite(t) && t > now.getTime() && t - now.getTime() <= MAX_AHEAD_MS;
}

/**
 * Converts a form value without a time zone (`<input type="datetime-local">`: "2026-10-25T10:30",
 * or `<input type="date">`: "2026-10-25", read as 00:00) to an instant, reading it in the org's
 * time zone rather than the server's. Returns null for anything else or an impossible date.
 */
export function parseOrgLocal(value: string | undefined, timeZone: string): Date | null {
  const m = /^(\d{4})-(\d{2})-(\d{2})(?:T(\d{2}):(\d{2}))?$/.exec(value?.trim() ?? '');
  if (!m) return null;
  const [y, mo, d, h, mi] = [m[1], m[2], m[3], m[4] ?? '0', m[5] ?? '0'].map(Number) as [
    number,
    number,
    number,
    number,
    number,
  ];
  const wall = Date.UTC(y, mo - 1, d, h, mi);
  const check = new Date(wall);
  if (check.getUTCMonth() !== mo - 1 || check.getUTCDate() !== d || h > 23 || mi > 59) return null;
  // Two passes settle the offset around DST changes (India has none; other zones may).
  let t = wall - offsetMs(wall, timeZone);
  t = wall - offsetMs(t, timeZone);
  return new Date(t);
}

function offsetMs(t: number, timeZone: string): number {
  const parts = Object.fromEntries(
    new Intl.DateTimeFormat('en-US', {
      timeZone,
      hourCycle: 'h23',
      year: 'numeric',
      month: '2-digit',
      day: '2-digit',
      hour: '2-digit',
      minute: '2-digit',
      second: '2-digit',
    })
      .formatToParts(new Date(t))
      .map((p) => [p.type, p.value]),
  );
  const asUtc = Date.UTC(
    Number(parts.year),
    Number(parts.month) - 1,
    Number(parts.day),
    Number(parts.hour),
    Number(parts.minute),
    Number(parts.second),
  );
  return asUtc - Math.floor(t / 1000) * 1000;
}
