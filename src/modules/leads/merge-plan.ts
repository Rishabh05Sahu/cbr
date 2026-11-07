// Lead merge planning (FR-062, lead-lifecycle §5): which fields of the merged lead may fill the
// survivor, which ones conflict, and the exact changes once the user has resolved every conflict.
// Pure: no database access. The merge command itself (tombstone with merged_into_lead_id, MERGED
// activity, audit, closing the merged lead's assignment spell) waits for migration 0006
// (docs/PHASE-2-M5-PROPOSAL.md).
//
// Merge is by reference (owner decision D1, 2026-10-24): the merged lead becomes a frozen
// tombstone pointing at the survivor, and no historical row is rewritten. The survivor's combined
// timeline, enquiries and notes are read across every lead whose pointer chain ends at it
// (timelineLeadIds); a stale link to a tombstone is followed to its survivor (resolveSurvivor).
//
// Rules:
// - Nothing is overwritten silently: when both leads hold different values, the merge is refused
//   until a resolution ("survivor" or "merged") is given for that field.
// - A blank survivor field takes the merged lead's value (a fill, shown in the preview).
// - The survivor keeps its primary phone, owner, team, stage and first-touch attribution. The
//   merged lead's phone can only become the survivor's alternate phone (fill or resolved conflict).
// - Preferred localities are combined (up to the 20-locality limit).

export const MERGE_FIELDS = [
  'fullName',
  'alternatePhoneE164',
  'email',
  'preferredLanguage',
  'preferredContactMethod',
  'transactionType',
  'propertyType',
  'bhkMin',
  'bhkMax',
  'budgetMin',
  'budgetMax',
  'preferredCity',
  'purpose',
  'timeline',
  'intent',
  'campaign',
] as const;
export type MergeField = (typeof MERGE_FIELDS)[number];
type Value = string | number | null;

export interface MergeLead {
  id: string;
  orgId: string;
  primaryPhoneE164: string;
  preferredLocalities: readonly string[];
  mergedIntoLeadId: string | null;
  deletedAt: Date | null;
  archivedAt: Date | null;
  fields: Record<MergeField, Value>;
}

export type MergeRefusal =
  | 'SAME_LEAD'
  | 'DIFFERENT_ORG'
  | 'ALREADY_MERGED'
  | 'DELETED'
  | 'SURVIVOR_ARCHIVED'
  | 'CONFLICTS_UNRESOLVED'
  | 'UNKNOWN_RESOLUTION';

export class MergeRefused extends Error {
  override readonly name = 'MergeRefused';
  constructor(
    readonly code: MergeRefusal,
    readonly fields: readonly string[] = [],
  ) {
    super(code);
  }
}

export interface MergePlan {
  survivorId: string;
  mergedId: string;
  fills: { field: MergeField; value: Value }[];
  conflicts: { field: MergeField; survivor: Value; merged: Value }[];
  /** Localities after combining (deduplicated, case-insensitive, capped at 20). */
  localities: string[];
  /** Localities the duplicate adds to the survivor's (within the limit); empty = nothing to show. */
  localitiesAdded: string[];
  localitiesDropped: number;
}

const LOCALITY_LIMIT = 20;
const same = (a: Value, b: Value) =>
  typeof a === 'string' && typeof b === 'string'
    ? a.trim().toLowerCase() === b.trim().toLowerCase()
    : a === b;

export function planMerge(survivor: MergeLead, merged: MergeLead): MergePlan {
  if (survivor.id === merged.id) throw new MergeRefused('SAME_LEAD');
  if (survivor.orgId !== merged.orgId) throw new MergeRefused('DIFFERENT_ORG');
  if (survivor.mergedIntoLeadId || merged.mergedIntoLeadId)
    throw new MergeRefused('ALREADY_MERGED');
  if (survivor.deletedAt || merged.deletedAt) throw new MergeRefused('DELETED');
  // The survivor must be live (the database refuses an archived target too); restoring it is a
  // separate, explicit decision. The merged lead may be archived.
  if (survivor.archivedAt) throw new MergeRefused('SURVIVOR_ARCHIVED');

  // The merged lead's best phone for the survivor's alternate slot: its alternate, else its
  // primary, never a number the survivor already has.
  const survivorPhones = new Set([survivor.primaryPhoneE164, survivor.fields.alternatePhoneE164]);
  const mergedPhone =
    [merged.fields.alternatePhoneE164, merged.primaryPhoneE164].find(
      (p) => p && !survivorPhones.has(p),
    ) ?? null;

  const fills: MergePlan['fills'] = [];
  const conflicts: MergePlan['conflicts'] = [];
  for (const field of MERGE_FIELDS) {
    const s = survivor.fields[field];
    const m = field === 'alternatePhoneE164' ? mergedPhone : merged.fields[field];
    if (m === null || m === '' || same(s, m)) continue;
    if (s === null || s === '') fills.push({ field, value: m });
    else conflicts.push({ field, survivor: s, merged: m });
  }

  const seen = new Set<string>();
  const all: string[] = [];
  for (const l of [...survivor.preferredLocalities, ...merged.preferredLocalities]) {
    const k = l.trim().toLowerCase();
    if (k && !seen.has(k)) {
      seen.add(k);
      all.push(l.trim());
    }
  }
  const kept = all.slice(0, LOCALITY_LIMIT);
  const survivorKeys = new Set(survivor.preferredLocalities.map((l) => l.trim().toLowerCase()));
  return {
    survivorId: survivor.id,
    mergedId: merged.id,
    fills,
    conflicts,
    localities: kept,
    localitiesAdded: kept.filter((l) => !survivorKeys.has(l.toLowerCase())),
    localitiesDropped: Math.max(0, all.length - LOCALITY_LIMIT),
  };
}

/**
 * The survivor's field changes for a plan and the user's resolutions. Every conflict needs a
 * resolution; resolutions for fields that are not conflicts are refused (no hidden writes).
 */
export function resolveMerge(
  plan: MergePlan,
  resolutions: Record<string, 'survivor' | 'merged'>,
): Partial<Record<MergeField, Value>> & { preferredLocalities?: string[] } {
  const conflictFields = new Set<string>(plan.conflicts.map((c) => c.field));
  const unknown = Object.keys(resolutions).filter((f) => !conflictFields.has(f));
  if (unknown.length) throw new MergeRefused('UNKNOWN_RESOLUTION', unknown);
  const missing = plan.conflicts.map((c) => c.field).filter((f) => !resolutions[f]);
  if (missing.length) throw new MergeRefused('CONFLICTS_UNRESOLVED', missing);

  const changes: Partial<Record<MergeField, Value>> & { preferredLocalities?: string[] } = {};
  for (const f of plan.fills) changes[f.field] = f.value;
  for (const c of plan.conflicts)
    if (resolutions[c.field] === 'merged') changes[c.field] = c.merged;
  changes.preferredLocalities = plan.localities;
  return changes;
}

/** Longest merge chain followed (A into B, B into C, ...). The database cannot form cycles. */
export const MERGE_CHAIN_MAX = 10;

export class MergeChainBroken extends Error {
  override readonly name = 'MergeChainBroken';
}

/** The live lead a (possibly merged) lead id now stands for, following merge pointers. */
export function resolveSurvivor(id: string, mergedInto: (id: string) => string | null): string {
  const seen = new Set<string>([id]);
  let at = id;
  for (let i = 0; i < MERGE_CHAIN_MAX; i++) {
    const next = mergedInto(at);
    if (next === null) return at;
    if (seen.has(next)) throw new MergeChainBroken(`merge chain cycle at ${next}`);
    seen.add(next);
    at = next;
  }
  throw new MergeChainBroken(`merge chain longer than ${MERGE_CHAIN_MAX}`);
}

/**
 * The leads whose history makes up the survivor's combined timeline: the survivor and every
 * tombstone whose pointer chain ends at it (up to MERGE_CHAIN_MAX levels). `tombstones` are
 * (id, mergedIntoLeadId) pairs from the same org.
 */
export function timelineLeadIds(
  survivorId: string,
  tombstones: readonly { id: string; mergedIntoLeadId: string }[],
): string[] {
  const byTarget = new Map<string, string[]>();
  for (const t of tombstones) {
    const list = byTarget.get(t.mergedIntoLeadId) ?? [];
    list.push(t.id);
    byTarget.set(t.mergedIntoLeadId, list);
  }
  const out = [survivorId];
  const seen = new Set(out);
  let level = [survivorId];
  for (let depth = 0; depth < MERGE_CHAIN_MAX && level.length; depth++) {
    const next: string[] = [];
    for (const id of level)
      for (const child of byTarget.get(id) ?? [])
        if (!seen.has(child)) {
          seen.add(child);
          out.push(child);
          next.push(child);
        }
    level = next;
  }
  return out;
}
