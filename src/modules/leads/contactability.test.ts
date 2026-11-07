// FR-065 contact status rules (ADR-0012): transitions and the outbound eligibility rule.
import { describe, expect, it } from 'vitest';
import {
  allowedContactStatusTargets,
  CONTACT_STATUSES,
  contactStatusChangeErrors,
  OUTBOUND_CHANNELS,
  outboundEligibility,
  type ContactStatus,
  type ContactStatusChange,
} from './contactability';

const live = { canLift: false, archived: false };
const admin = { canLift: true, archived: false };
const change = (
  from: ContactStatus,
  to: ContactStatus,
  extra: Partial<ContactStatusChange> = {},
): ContactStatusChange => ({
  from,
  to,
  reason: 'Customer asked',
  method: null,
  evidenceRef: null,
  ...extra,
});

describe('allowedContactStatusTargets', () => {
  it('lets anyone who may update the lead record do-not-contact or an invalid number', () => {
    expect(allowedContactStatusTargets('OK', live)).toEqual(['DO_NOT_CONTACT', 'INVALID']);
    expect(allowedContactStatusTargets('INVALID', live)).toEqual(['DO_NOT_CONTACT', 'OK']);
  });
  it('lets only Owner/Admin lift do-not-contact, and only to OK', () => {
    expect(allowedContactStatusTargets('DO_NOT_CONTACT', live)).toEqual([]);
    expect(allowedContactStatusTargets('DO_NOT_CONTACT', admin)).toEqual(['OK']);
  });
  it('accepts only do-not-contact on an archived lead', () => {
    for (const canLift of [false, true]) {
      expect(allowedContactStatusTargets('OK', { canLift, archived: true })).toEqual([
        'DO_NOT_CONTACT',
      ]);
      expect(allowedContactStatusTargets('INVALID', { canLift, archived: true })).toEqual([
        'DO_NOT_CONTACT',
      ]);
      expect(allowedContactStatusTargets('DO_NOT_CONTACT', { canLift, archived: true })).toEqual(
        [],
      );
    }
  });
});

describe('contactStatusChangeErrors', () => {
  it('accepts complete, permitted changes', () => {
    expect(
      contactStatusChangeErrors(change('OK', 'DO_NOT_CONTACT', { method: 'VERBAL' }), live),
    ).toEqual({});
    expect(contactStatusChangeErrors(change('OK', 'INVALID'), live)).toEqual({});
    expect(contactStatusChangeErrors(change('INVALID', 'OK'), live)).toEqual({});
    expect(
      contactStatusChangeErrors(
        change('DO_NOT_CONTACT', 'OK', { method: 'FORM_OPT_IN', evidenceRef: 'Form 42' }),
        admin,
      ),
    ).toEqual({});
  });
  it('always needs a reason', () => {
    expect(
      contactStatusChangeErrors(change('OK', 'INVALID', { reason: null }), live),
    ).toHaveProperty('reason');
  });
  it('needs how do-not-contact was asked for', () => {
    expect(contactStatusChangeErrors(change('OK', 'DO_NOT_CONTACT'), live)).toHaveProperty(
      'method',
    );
    expect(
      contactStatusChangeErrors(change('OK', 'DO_NOT_CONTACT', { method: 'FORM_OPT_IN' }), live),
    ).toHaveProperty('method');
  });
  it('refuses lifting do-not-contact without the permission, a basis and evidence', () => {
    const lift = change('DO_NOT_CONTACT', 'OK', { method: 'VERBAL', evidenceRef: 'Call 28 Oct' });
    expect(contactStatusChangeErrors(lift, live)).toEqual({
      toStatus: ['Only an Owner or Admin can lift do-not-contact'],
    });
    expect(contactStatusChangeErrors({ ...lift, method: 'OTHER' }, admin)).toHaveProperty('method');
    expect(contactStatusChangeErrors({ ...lift, evidenceRef: null }, admin)).toHaveProperty(
      'evidenceRef',
    );
  });
  it('never weakens do-not-contact to invalid, and refuses no-op changes', () => {
    expect(contactStatusChangeErrors(change('DO_NOT_CONTACT', 'INVALID'), admin)).toHaveProperty(
      'toStatus',
    );
    for (const s of CONTACT_STATUSES)
      expect(contactStatusChangeErrors(change(s, s), admin)).toHaveProperty('toStatus');
  });
  it('refuses anything but do-not-contact on an archived lead', () => {
    expect(
      contactStatusChangeErrors(change('OK', 'INVALID'), { canLift: true, archived: true }),
    ).toHaveProperty('toStatus');
    expect(
      contactStatusChangeErrors(change('OK', 'DO_NOT_CONTACT', { method: 'WRITTEN' }), {
        canLift: false,
        archived: true,
      }),
    ).toEqual({});
  });
});

describe('outboundEligibility', () => {
  it('blocks do-not-contact on every channel, with no confirmation route', () => {
    for (const ch of OUTBOUND_CHANNELS)
      expect(outboundEligibility('DO_NOT_CONTACT', ch)).toEqual({
        allowed: false,
        reason: 'This lead asked not to be contacted',
      });
  });
  it('asks for confirmation before a manual contact to an invalid number', () => {
    for (const ch of ['MANUAL_CALL', 'MANUAL_WHATSAPP'] as const)
      expect(outboundEligibility('INVALID', ch)).toMatchObject({
        allowed: true,
        requiresConfirmation: true,
      });
  });
  it('blocks integration sends to an invalid number', () => {
    for (const ch of ['INTEGRATION_CALL', 'INTEGRATION_MESSAGE'] as const)
      expect(outboundEligibility('INVALID', ch).allowed).toBe(false);
  });
  it('allows OK leads without confirmation', () => {
    for (const ch of OUTBOUND_CHANNELS)
      expect(outboundEligibility('OK', ch)).toEqual({ allowed: true, requiresConfirmation: false });
  });
});
