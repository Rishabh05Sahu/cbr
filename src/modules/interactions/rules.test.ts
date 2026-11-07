// Interaction rules (FR-083/084, lead-lifecycle §3, ADR-0014): the channel/outcome matrix (the
// same rule as the interaction_outcome_fits CHECK in migration 0017), contact status effects of
// outcomes (Q3: never weakening), the Assigned -> Contacted rule (Q5), the seven-day window and
// the FR-065 outbound rule for every manual channel.
import { describe, expect, it } from 'vitest';
import { outboundEligibility } from '@/modules/leads/contactability';
import {
  allowedOutcomes,
  CHANNELS,
  contactStatusEffect,
  DIRECTIONS,
  durationAllowed,
  movesToContacted,
  occurredAtProblem,
  orgLocalInputValue,
  outboundChannelFor,
  outcomeFits,
  OUTCOME_GROUPS,
  OUTCOMES,
  requestedContactStatus,
} from './rules';

describe('outcome groups (lead-lifecycle §3)', () => {
  it('uses the lifecycle groups and leaves out the provider-only outcome', () => {
    expect(OUTCOME_GROUPS.NO_ANSWER).toBe('NOT_CONNECTED');
    expect(OUTCOME_GROUPS.WRONG_NUMBER).toBe('INVALID');
    expect(OUTCOME_GROUPS.CONNECTED_DO_NOT_CALL).toBe('CONNECTED');
    expect(OUTCOME_GROUPS.MEETING_HELD).toBe('OTHER');
    expect(OUTCOMES).not.toContain('UNKNOWN_NOT_CONNECTED');
    expect(OUTCOMES).toHaveLength(17);
  });
});

describe('which outcomes fit which channel and direction', () => {
  it('offers call results only for outbound calls', () => {
    expect(allowedOutcomes('PHONE_NATIVE', 'OUTBOUND')).toEqual(
      expect.arrayContaining(['NO_ANSWER', 'BUSY', 'VOICEMAIL', 'CONNECTED_INTERESTED']),
    );
    expect(allowedOutcomes('PHONE_NATIVE', 'INBOUND')).not.toContain('NO_ANSWER');
    expect(allowedOutcomes('EMAIL', 'OUTBOUND')).not.toContain('NO_ANSWER');
    expect(allowedOutcomes('WHATSAPP_APP_CALL', 'OUTBOUND')).not.toContain('VOICEMAIL');
  });
  it('keeps phone-number outcomes off email and meetings', () => {
    for (const d of DIRECTIONS) {
      expect(allowedOutcomes('EMAIL', d)).not.toContain('WRONG_NUMBER');
      expect(allowedOutcomes('IN_PERSON', d)).not.toContain('INVALID_NUMBER');
    }
    expect(allowedOutcomes('PHONE_NATIVE', 'INBOUND')).toContain('WRONG_NUMBER');
    expect(allowedOutcomes('PHONE_NATIVE', 'INBOUND')).not.toContain('INVALID_NUMBER');
  });
  it('sends messages, holds meetings and reaches WhatsApp only where they make sense', () => {
    expect(outcomeFits('MESSAGE_SENT', 'SMS', 'OUTBOUND')).toBe(true);
    expect(outcomeFits('MESSAGE_SENT', 'SMS', 'INBOUND')).toBe(false);
    expect(outcomeFits('MESSAGE_SENT', 'PHONE_NATIVE', 'OUTBOUND')).toBe(false);
    expect(outcomeFits('MEETING_HELD', 'IN_PERSON', 'INBOUND')).toBe(true);
    expect(outcomeFits('MEETING_HELD', 'PHONE_NATIVE', 'OUTBOUND')).toBe(false);
    expect(outcomeFits('WHATSAPP_NOT_AVAILABLE', 'WHATSAPP_APP_MESSAGE', 'OUTBOUND')).toBe(true);
    expect(outcomeFits('WHATSAPP_NOT_AVAILABLE', 'PHONE_NATIVE', 'OUTBOUND')).toBe(false);
  });
  it('allows a connected outcome on every channel and direction', () => {
    for (const c of CHANNELS)
      for (const d of DIRECTIONS) expect(allowedOutcomes(c, d)).toContain('CONNECTED_INTERESTED');
  });
  it('estimates duration for calls and meetings only', () => {
    expect(CHANNELS.filter(durationAllowed)).toEqual([
      'PHONE_NATIVE',
      'WHATSAPP_APP_CALL',
      'IN_PERSON',
    ]);
  });
});

describe('contact status effects (FR-065, Q3)', () => {
  it('asks for do-not-contact or invalid only for those outcomes', () => {
    expect(requestedContactStatus('CONNECTED_DO_NOT_CALL')).toBe('DO_NOT_CONTACT');
    expect(requestedContactStatus('WRONG_NUMBER')).toBe('INVALID');
    expect(requestedContactStatus('INVALID_NUMBER')).toBe('INVALID');
    expect(requestedContactStatus('CONNECTED_INTERESTED')).toBeNull();
    expect(requestedContactStatus('NO_ANSWER')).toBeNull();
  });
  it('changes the status when it strengthens it', () => {
    expect(contactStatusEffect('CONNECTED_DO_NOT_CALL', 'OK')).toEqual({
      kind: 'change',
      to: 'DO_NOT_CONTACT',
    });
    expect(contactStatusEffect('CONNECTED_DO_NOT_CALL', 'INVALID')).toEqual({
      kind: 'change',
      to: 'DO_NOT_CONTACT',
    });
    expect(contactStatusEffect('WRONG_NUMBER', 'OK')).toEqual({ kind: 'change', to: 'INVALID' });
  });
  it('never weakens or repeats it, and never lifts do-not-contact', () => {
    expect(contactStatusEffect('WRONG_NUMBER', 'DO_NOT_CONTACT').kind).toBe('unchanged');
    expect(contactStatusEffect('INVALID_NUMBER', 'INVALID').kind).toBe('unchanged');
    expect(contactStatusEffect('CONNECTED_DO_NOT_CALL', 'DO_NOT_CONTACT').kind).toBe('unchanged');
    for (const o of OUTCOMES) {
      const e = contactStatusEffect(o, 'DO_NOT_CONTACT');
      expect(e.kind === 'change' && e.to !== 'DO_NOT_CONTACT').toBe(false);
    }
    expect(contactStatusEffect('CONNECTED_INTERESTED', 'DO_NOT_CONTACT')).toEqual({
      kind: 'none',
    });
  });
});

describe('outbound rule for manual records (FR-065, Q2)', () => {
  it('refuses outbound contact on do-not-contact for every manual channel, with no override', () => {
    for (const c of CHANNELS) {
      const e = outboundEligibility('DO_NOT_CONTACT', outboundChannelFor(c));
      expect(e.allowed).toBe(false);
    }
  });
  it('needs a confirmation on an invalid number and nothing on OK', () => {
    for (const c of CHANNELS) {
      expect(outboundEligibility('INVALID', outboundChannelFor(c))).toMatchObject({
        allowed: true,
        requiresConfirmation: true,
      });
      expect(outboundEligibility('OK', outboundChannelFor(c))).toEqual({
        allowed: true,
        requiresConfirmation: false,
      });
    }
  });
});

describe('lifecycle (Q5)', () => {
  it('moves only Assigned leads, and only on a connected outcome', () => {
    expect(movesToContacted('CONNECTED_CALL_BACK', 'ASSIGNED')).toBe(true);
    expect(movesToContacted('NO_ANSWER', 'ASSIGNED')).toBe(false); // "No answer" never moves
    expect(movesToContacted('MEETING_HELD', 'ASSIGNED')).toBe(false);
    for (const stage of ['NEW', 'CONTACTED', 'QUALIFIED', 'WON', 'LOST', 'NURTURE'])
      expect(movesToContacted('CONNECTED_INTERESTED', stage)).toBe(false);
  });
});

describe('when it happened', () => {
  const now = new Date('2026-10-29T10:00:00Z');
  it('accepts now and up to seven days ago', () => {
    expect(occurredAtProblem(now, now)).toBeNull();
    expect(occurredAtProblem(new Date(now.getTime() - 7 * 24 * 3600_000), now)).toBeNull();
  });
  it('refuses the future, older than seven days and a missing value', () => {
    expect(occurredAtProblem(new Date(now.getTime() + 60_000), now)).toMatch(/future/);
    expect(occurredAtProblem(new Date(now.getTime() - 7 * 24 * 3600_000 - 1), now)).toMatch(
      /seven days/,
    );
    expect(occurredAtProblem(null, now)).toMatch(/Enter/);
  });
  it('formats an instant for a datetime-local input in the org time zone', () => {
    expect(orgLocalInputValue(now, 'Asia/Kolkata')).toBe('2026-10-29T15:30');
    expect(orgLocalInputValue(new Date('2026-10-29T18:45:00Z'), 'Asia/Kolkata')).toBe(
      '2026-10-30T00:15',
    );
  });
});
