import { describe, expect, it } from 'vitest';
import { DomainError } from '@/platform/errors';
import {
  allowedTargets,
  LEAD_STAGES,
  milestonesReached,
  parseOrgLocal,
  planStageChange,
  type LeadStage,
  type QualificationFields,
} from './stages';

const now = new Date('2026-10-23T06:00:00Z');
const later = new Date('2026-10-30T05:00:00Z');
const qualified: QualificationFields = {
  transactionType: 'BUY',
  propertyType: 'APARTMENT',
  preferredCity: 'Pune',
  budgetMin: null,
  budgetMax: '12000000.00',
};
const empty: QualificationFields = {
  transactionType: null,
  propertyType: null,
  preferredCity: null,
  budgetMin: null,
  budgetMax: null,
};
const plan = (
  from: LeadStage,
  req: Parameters<typeof planStageChange>[1],
  lead = qualified,
  canReopen = false,
) => planStageChange(from, req, lead, { canReopen, now });

const errorOf = (fn: () => unknown): DomainError => {
  try {
    fn();
  } catch (e) {
    if (e instanceof DomainError) return e;
    throw e;
  }
  throw new Error('expected a DomainError');
};

describe('planStageChange (lead-lifecycle §2.1)', () => {
  it('simple forward move: one step, no implied milestones', () => {
    expect(plan('ASSIGNED', { to: 'CONTACTED' }).steps).toEqual([
      { from: 'ASSIGNED', to: 'CONTACTED', implied: false },
    ]);
  });

  it('skipping forward records Contacted and Qualified as implied steps', () => {
    const p = plan('ASSIGNED', { to: 'SITE_VISIT_SCHEDULED', visitAt: later });
    expect(p.steps).toEqual([
      { from: 'ASSIGNED', to: 'CONTACTED', implied: true },
      { from: 'CONTACTED', to: 'QUALIFIED', implied: true },
      { from: 'QUALIFIED', to: 'SITE_VISIT_SCHEDULED', implied: false },
    ]);
    expect(p.details).toEqual({ visitAt: later.toISOString() });
  });

  it('qualifying needs the minimum requirement set, also when implied', () => {
    for (const to of ['QUALIFIED', 'SITE_VISIT_SCHEDULED'] as const) {
      const e = errorOf(() => plan('CONTACTED', { to, visitAt: later }, empty));
      expect(e.code).toBe('VALIDATION_FAILED');
      expect(e.fieldErrors?.stage?.[0]).toMatch(/transaction type, property type, city, budget/);
    }
  });

  it('a cancelled visit returns to Qualified with a reason, without re-checking fields', () => {
    expect(
      plan('SITE_VISIT_SCHEDULED', { to: 'QUALIFIED', reasonText: 'Visit cancelled' }, empty).steps,
    ).toHaveLength(1);
    expect(
      errorOf(() => plan('SITE_VISIT_SCHEDULED', { to: 'QUALIFIED' })).fieldErrors,
    ).toHaveProperty('reasonText');
  });

  it.each([
    ['ASSIGNED', 'NEGOTIATION'],
    ['CONTACTED', 'WON'],
    ['QUALIFIED', 'SITE_VISIT_COMPLETED'],
    ['SITE_VISIT_SCHEDULED', 'LOST'],
    ['NURTURE', 'QUALIFIED'],
    ['NEW', 'LOST'],
  ] as const)('rejects %s -> %s', (from, to) => {
    expect(errorOf(() => plan(from, { to, reasonCode: 'OTHER' })).code).toBe('RULE_VIOLATION');
  });

  it('Won is terminal; Assigned/New are system-managed; no-op changes are refused', () => {
    for (const to of LEAD_STAGES)
      expect(errorOf(() => plan('WON', { to })).code).toBe('RULE_VIOLATION');
    expect(errorOf(() => plan('CONTACTED', { to: 'ASSIGNED' })).message).toMatch(/automatically/);
    expect(errorOf(() => plan('CONTACTED', { to: 'NEW' })).message).toMatch(/automatically/);
    expect(errorOf(() => plan('CONTACTED', { to: 'CONTACTED' })).message).toMatch(/already/);
    expect(allowedTargets('WON')).toEqual([]);
    for (const s of LEAD_STAGES) expect(allowedTargets(s)).not.toContain('ASSIGNED');
  });

  it('Lost needs a reason from the list', () => {
    expect(errorOf(() => plan('CONTACTED', { to: 'LOST' })).fieldErrors).toHaveProperty(
      'reasonCode',
    );
    expect(
      errorOf(() => plan('CONTACTED', { to: 'LOST', reasonCode: 'toString' })).fieldErrors,
    ).toHaveProperty('reasonCode');
    expect(plan('CONTACTED', { to: 'LOST', reasonCode: 'BUDGET_MISMATCH' }).reasonCode).toBe(
      'BUDGET_MISMATCH',
    );
  });

  it('reopening Lost needs manager scope and a reason', () => {
    expect(errorOf(() => plan('LOST', { to: 'CONTACTED', reasonText: 'Called back' })).code).toBe(
      'RULE_VIOLATION',
    );
    expect(
      errorOf(() => plan('LOST', { to: 'CONTACTED' }, qualified, true)).fieldErrors,
    ).toHaveProperty('reasonText');
    expect(
      plan('LOST', { to: 'CONTACTED', reasonText: 'Called back' }, qualified, true).steps,
    ).toHaveLength(1);
  });

  it('visit and nurture dates must be in the future, within two years', () => {
    const past = new Date('2026-10-22T00:00:00Z');
    const far = new Date('2029-01-01T00:00:00Z');
    for (const visitAt of [undefined, past, far, new Date('x')])
      expect(
        errorOf(() => plan('QUALIFIED', { to: 'SITE_VISIT_SCHEDULED', visitAt })).fieldErrors,
      ).toHaveProperty('visitAt');
    for (const nurtureUntil of [undefined, past, far])
      expect(
        errorOf(() => plan('CONTACTED', { to: 'NURTURE', nurtureUntil })).fieldErrors,
      ).toHaveProperty('nurtureUntil');
    expect(plan('CONTACTED', { to: 'NURTURE', nurtureUntil: later }).details).toEqual({
      nurtureUntil: later.toISOString(),
    });
  });

  it('a completed visit needs feedback', () => {
    expect(
      errorOf(() => plan('SITE_VISIT_SCHEDULED', { to: 'SITE_VISIT_COMPLETED' })).fieldErrors,
    ).toHaveProperty('reasonText');
  });
});

describe('milestonesReached (§2.2)', () => {
  it('sets each milestone once and never overwrites an earlier one', () => {
    const steps = plan('ASSIGNED', { to: 'SITE_VISIT_SCHEDULED', visitAt: later }).steps;
    const earlier = new Date('2026-01-01T00:00:00Z');
    expect(milestonesReached(steps, { firstContactedAt: earlier }, now)).toEqual({
      qualifiedAt: now,
      firstVisitScheduledAt: now,
    });
    expect(milestonesReached([{ from: 'ASSIGNED', to: 'LOST', implied: false }], {}, now)).toEqual({
      lostAt: now,
    });
  });
});

describe('parseOrgLocal', () => {
  it('reads form values in the org time zone', () => {
    expect(parseOrgLocal('2026-10-25T10:30', 'Asia/Kolkata')?.toISOString()).toBe(
      '2026-10-25T05:00:00.000Z',
    );
    expect(parseOrgLocal('2026-10-25', 'Asia/Kolkata')?.toISOString()).toBe(
      '2026-10-24T18:30:00.000Z',
    );
    expect(parseOrgLocal('2026-07-01T09:00', 'Europe/London')?.toISOString()).toBe(
      '2026-07-01T08:00:00.000Z',
    );
  });

  it.each([undefined, '', '2026-02-30', '2026-13-01', '2026-10-25T24:00', 'tomorrow', '1e9'])(
    'rejects %j',
    (v) => {
      expect(parseOrgLocal(v, 'Asia/Kolkata')).toBeNull();
    },
  );
});
