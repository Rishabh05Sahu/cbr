import { describe, expect, it } from 'vitest';
import { decisionOutcome, pairKey, ReviewRefused, routeMatchedEnquiry } from './duplicate-review';

const code = (fn: () => unknown) => {
  try {
    fn();
  } catch (e) {
    if (e instanceof ReviewRefused) return e.code;
    throw e;
  }
  return null;
};

describe('duplicate review', () => {
  it('pair cases are merged or dismissed by someone who may merge', () => {
    expect(decisionOutcome('PHONE_ALT', 'OPEN', 'merge')).toEqual({
      status: 'MERGED',
      permission: 'lead.merge',
    });
    expect(decisionOutcome('EMAIL', 'OPEN', 'dismiss')).toEqual({
      status: 'DISMISSED',
      permission: 'lead.merge',
    });
    expect(code(() => decisionOutcome('NAME_SIMILAR', 'OPEN', 'restore'))).toBe(
      'DECISION_NOT_ALLOWED',
    );
  });

  it('archived cases are restored or kept archived by someone who may archive', () => {
    expect(decisionOutcome('ARCHIVED_ENQUIRY', 'OPEN', 'restore')).toEqual({
      status: 'RESTORED',
      permission: 'lead.archive',
    });
    expect(decisionOutcome('ARCHIVED_ENQUIRY', 'OPEN', 'keep_archived').status).toBe(
      'KEPT_ARCHIVED',
    );
    expect(code(() => decisionOutcome('ARCHIVED_ENQUIRY', 'OPEN', 'merge'))).toBe(
      'DECISION_NOT_ALLOWED',
    );
  });

  it('a case is resolved once', () => {
    expect(code(() => decisionOutcome('PHONE_ALT', 'DISMISSED', 'merge'))).toBe('ALREADY_RESOLVED');
    expect(code(() => decisionOutcome('ARCHIVED_ENQUIRY', 'RESTORED', 'restore'))).toBe(
      'ALREADY_RESOLVED',
    );
  });

  it('an enquiry never restores an archived lead; it opens one review case', () => {
    const archived = { archivedAt: new Date('2026-10-01T00:00:00Z') };
    expect(routeMatchedEnquiry(archived, false)).toEqual({
      attach: true,
      restore: false,
      openCase: true,
    });
    expect(routeMatchedEnquiry(archived, true).openCase).toBe(false);
    expect(routeMatchedEnquiry({ archivedAt: null }, false)).toEqual({
      attach: true,
      restore: false,
      openCase: false,
    });
  });

  it('a pair has one key whichever lead comes first', () => {
    expect(pairKey('b', 'a')).toEqual(pairKey('a', 'b'));
  });
});
