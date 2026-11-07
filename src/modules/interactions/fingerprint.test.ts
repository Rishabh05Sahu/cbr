// Request fingerprint (review M1, ADR-0014): canonical form, stability under key order, and
// sensitivity to every input that can change a side effect.
import { describe, expect, it } from 'vitest';
import { canonicalJson, requestFingerprint, type FingerprintInput } from './fingerprint';

const base: FingerprintInput = {
  idempotencyKey: '0199a000-0000-7000-8000-000000000001',
  leadId: '0199a000-0000-7000-8000-000000000002',
  version: 3,
  channel: 'PHONE_NATIVE',
  direction: 'OUTBOUND',
  outcome: 'CONNECTED_INTERESTED',
  occurredAt: '2026-10-29T05:00:00.000Z',
  durationMinutes: null,
  notes: null,
  confirmInvalidNumber: false,
  status: { confirm: false, reason: null, method: null, evidenceRef: null },
  requirements: null,
  followUp: {
    taskId: null,
    taskVersion: null,
    complete: false,
    nextDueAt: null,
    nextTitle: null,
    rescheduleReason: null,
  },
};

describe('canonicalJson', () => {
  it('sorts keys at every level and writes absent values as null', () => {
    expect(canonicalJson({ b: 1, a: { d: undefined, c: [2, null] } })).toBe(
      '{"a":{"c":[2,null],"d":null},"b":1}',
    );
  });
});

describe('requestFingerprint', () => {
  it('is a 64-character hex digest, the same for the same submission in any key order', () => {
    const fp = requestFingerprint(base);
    expect(fp).toMatch(/^[0-9a-f]{64}$/);
    const reordered = Object.fromEntries(Object.entries(base).reverse()) as FingerprintInput;
    expect(requestFingerprint(reordered)).toBe(fp);
  });

  it('changes with every input that can change a side effect', () => {
    const fp = requestFingerprint(base);
    const variants: Partial<FingerprintInput>[] = [
      { idempotencyKey: '0199a000-0000-7000-8000-000000000009' },
      { leadId: '0199a000-0000-7000-8000-000000000003' },
      { version: 4 },
      { channel: 'WHATSAPP_APP_CALL' },
      { direction: 'INBOUND' },
      { outcome: 'CONNECTED_DO_NOT_CALL' },
      { occurredAt: '2026-10-29T05:01:00.000Z' },
      { durationMinutes: 5 },
      { notes: 'x' },
      { confirmInvalidNumber: true },
      { status: { ...base.status, confirm: true } },
      { status: { ...base.status, reason: 'r' } },
      { status: { ...base.status, method: 'VERBAL' } },
      { status: { ...base.status, evidenceRef: 'e' } },
      { requirements: { preferredCity: 'Pune' } },
      { requirements: { preferredCity: '' } },
      { followUp: { ...base.followUp, taskId: 't' } },
      { followUp: { ...base.followUp, taskVersion: 2 } },
      { followUp: { ...base.followUp, complete: true } },
      { followUp: { ...base.followUp, nextDueAt: '2026-10-30T05:00:00.000Z' } },
      { followUp: { ...base.followUp, nextTitle: 't' } },
      { followUp: { ...base.followUp, rescheduleReason: 'r' } },
    ];
    const seen = new Set([fp]);
    for (const v of variants) {
      const other = requestFingerprint({ ...base, ...v });
      expect(other).not.toBe(fp);
      seen.add(other);
    }
    expect(seen.size).toBe(variants.length + 1);
  });

  it('FR-098: adds the script version only when one was shown', () => {
    const fp = requestFingerprint(base);
    // Without a script the digest is the one from before migration 0019 (no new key hashed).
    expect(requestFingerprint({ ...base, scriptVersionId: null })).toBe(fp);
    const v1 = requestFingerprint({
      ...base,
      scriptVersionId: '0199a000-0000-7000-8000-0000000000a1',
    });
    const v2 = requestFingerprint({
      ...base,
      scriptVersionId: '0199a000-0000-7000-8000-0000000000a2',
    });
    expect(v1).not.toBe(fp);
    expect(v2).not.toBe(v1);
  });

  it('distinguishes an empty requirement patch from none', () => {
    expect(requestFingerprint({ ...base, requirements: {} })).not.toBe(requestFingerprint(base));
  });
});
