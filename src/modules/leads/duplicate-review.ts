// Duplicate review queue rules (lead-lifecycle §5, owner decision D2 of 2026-10-24). Pure: the
// lead_duplicate_match table, its guard trigger and the commands wait for migration 0006
// (docs/PHASE-2-M5-PROPOSAL.md).
//
// - Possible duplicates (same alternate phone, email, similar name) are never merged
//   automatically: they become a PAIR case that an authorised user merges or dismisses.
// - An enquiry matching an ARCHIVED lead is attached to it, but the lead stays archived; the
//   case waits for an explicit restore or keep-archived decision. Nothing restores a lead silently.
// - A case is resolved once, by the session user (the database refuses a second resolution).
import type { Permission } from '@/platform/authz';

export const PAIR_MATCH_TYPES = ['PHONE_ALT', 'EMAIL', 'NAME_SIMILAR'] as const;
export type MatchType = (typeof PAIR_MATCH_TYPES)[number] | 'ARCHIVED_ENQUIRY';
export type CaseStatus = 'OPEN' | 'MERGED' | 'DISMISSED' | 'RESTORED' | 'KEPT_ARCHIVED';
export type ReviewDecision = 'merge' | 'dismiss' | 'restore' | 'keep_archived';

export class ReviewRefused extends Error {
  override readonly name = 'ReviewRefused';
  constructor(readonly code: 'DECISION_NOT_ALLOWED' | 'ALREADY_RESOLVED') {
    super(code);
  }
}

const OUTCOMES: Record<
  'PAIR' | 'ARCHIVED',
  Partial<Record<ReviewDecision, { status: CaseStatus; permission: Permission }>>
> = {
  PAIR: {
    merge: { status: 'MERGED', permission: 'lead.merge' },
    dismiss: { status: 'DISMISSED', permission: 'lead.merge' },
  },
  ARCHIVED: {
    restore: { status: 'RESTORED', permission: 'lead.archive' },
    keep_archived: { status: 'KEPT_ARCHIVED', permission: 'lead.archive' },
  },
};

/** The status a decision records and the permission it needs; refuses decisions that do not fit. */
export function decisionOutcome(
  matchType: MatchType,
  status: CaseStatus,
  decision: ReviewDecision,
): { status: CaseStatus; permission: Permission } {
  if (status !== 'OPEN') throw new ReviewRefused('ALREADY_RESOLVED');
  const outcome = OUTCOMES[matchType === 'ARCHIVED_ENQUIRY' ? 'ARCHIVED' : 'PAIR'][decision];
  if (!outcome) throw new ReviewRefused('DECISION_NOT_ALLOWED');
  return outcome;
}

/**
 * What happens to an enquiry whose phone matches an existing open lead (D2): it is always attached
 * to that lead and the lead is never restored by it; an archived lead also gets a review case
 * (unless one is already open for it, in which case the enquiry just waits with it).
 */
export function routeMatchedEnquiry(
  lead: { archivedAt: Date | null },
  hasOpenArchivedCase: boolean,
): { attach: true; restore: false; openCase: boolean } {
  return {
    attach: true,
    restore: false,
    openCase: lead.archivedAt !== null && !hasOpenArchivedCase,
  };
}

/** A pair is one case whichever lead was seen first (mirrors lead_duplicate_match_pair_uq). */
export function pairKey(a: string, b: string): readonly [string, string] {
  return a < b ? [a, b] : [b, a];
}
