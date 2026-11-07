// The request fingerprint of an outcome-sheet submission (migration 0018, ADR-0014; review
// finding M1). A repeated submission with the same idempotency key counts as "already saved" only
// when its fingerprint equals the stored one, so a retry that changed any detail is refused
// instead of being reported as saved while its changes are dropped.
//
// The fingerprint covers every input that can change a side effect, after the same
// normalisation the command applies (trimmed text, parsed times as UTC instants, booleans, the
// requirement patch as sorted field/value pairs). It is a SHA-256 digest of a canonical JSON
// form: keys sorted, absent values as null. The idempotency key is part of the input, so the
// digest does not let anyone compare submissions across keys. No request data is stored.
import { createHash } from 'node:crypto';

export interface FingerprintInput {
  idempotencyKey: string;
  leadId: string;
  version: number;
  channel: string;
  direction: string;
  outcome: string;
  /** The parsed instant (ISO), or the trimmed text when it does not parse. */
  occurredAt: string;
  durationMinutes: number | null;
  notes: string | null;
  confirmInvalidNumber: boolean;
  status: {
    confirm: boolean;
    reason: string | null;
    method: string | null;
    evidenceRef: string | null;
  };
  /** Only the requirement fields the person changed, or null when none. */
  requirements: Record<string, string> | null;
  followUp: {
    taskId: string | null;
    taskVersion: number | null;
    complete: boolean;
    nextDueAt: string | null;
    nextTitle: string | null;
    rescheduleReason: string | null;
  };
  /**
   * FR-098 (migration 0019): the script version shown, when there was one. Hashed only when
   * present, so submissions without a script keep the fingerprint they had before 0019.
   */
  scriptVersionId?: string | null;
}

/** JSON with object keys sorted at every level; undefined becomes null. */
export function canonicalJson(v: unknown): string {
  if (v === undefined || v === null) return 'null';
  if (Array.isArray(v)) return `[${v.map(canonicalJson).join(',')}]`;
  if (typeof v === 'object') {
    const o = v as Record<string, unknown>;
    return `{${Object.keys(o)
      .sort()
      .map((k) => `${JSON.stringify(k)}:${canonicalJson(o[k])}`)
      .join(',')}}`;
  }
  return JSON.stringify(v);
}

/** Version 1 of the fingerprint: SHA-256 (hex) of the canonical submission. */
export function requestFingerprint(input: FingerprintInput): string {
  const { scriptVersionId, ...rest } = input;
  return createHash('sha256')
    .update(
      canonicalJson({
        fingerprintVersion: 1,
        ...rest,
        ...(scriptVersionId ? { scriptVersionId } : {}),
      }),
    )
    .digest('hex');
}
