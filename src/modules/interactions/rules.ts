// Interaction rules (FR-083/084, lead-lifecycle §3; ADR-0014). Pure: no database access, so the
// outcome sheet can use them in the browser to offer only valid choices. Migration 0017 enforces
// the same vocabularies and channel/outcome fit in the database (interaction CHECKs).
//
// Contact status (FR-065, ADR-0012; owner decisions 2026-10-29):
//   - Outbound contact follows outboundEligibility: refused on Do-Not-Contact (no override, and no
//     record of a contact that already happened: Q2), confirmed on Invalid.
//   - Inbound contact may be recorded on a Do-Not-Contact lead (Q1). It changes nothing.
//   - Two outcome kinds ask to change the status (Q3), through the contact status event and only
//     with an explicit confirmation: CONNECTED_DO_NOT_CALL -> DO_NOT_CONTACT, and WRONG_NUMBER /
//     INVALID_NUMBER -> INVALID. A change that would weaken the status (DO_NOT_CONTACT -> INVALID)
//     or repeat it is not made; the interaction is still recorded.
import type { ContactStatus, OutboundChannel } from '@/modules/leads/contactability';

export const CHANNELS = [
  'PHONE_NATIVE',
  'WHATSAPP_APP_CALL',
  'WHATSAPP_APP_MESSAGE',
  'SMS',
  'EMAIL',
  'IN_PERSON',
] as const;
export type Channel = (typeof CHANNELS)[number];

export const DIRECTIONS = ['OUTBOUND', 'INBOUND'] as const;
export type Direction = (typeof DIRECTIONS)[number];

export const OUTCOME_GROUPS = {
  NO_ANSWER: 'NOT_CONNECTED',
  BUSY: 'NOT_CONNECTED',
  SWITCHED_OFF: 'NOT_CONNECTED',
  NOT_REACHABLE: 'NOT_CONNECTED',
  CALL_REJECTED: 'NOT_CONNECTED',
  WHATSAPP_NOT_AVAILABLE: 'NOT_CONNECTED',
  WRONG_NUMBER: 'INVALID',
  INVALID_NUMBER: 'INVALID',
  CONNECTED_INTERESTED: 'CONNECTED',
  CONNECTED_CALL_BACK: 'CONNECTED',
  CONNECTED_NOT_INTERESTED: 'CONNECTED',
  CONNECTED_ALREADY_BOUGHT: 'CONNECTED',
  CONNECTED_BROKER: 'CONNECTED',
  CONNECTED_DO_NOT_CALL: 'CONNECTED',
  MESSAGE_SENT: 'OTHER',
  VOICEMAIL: 'OTHER',
  MEETING_HELD: 'OTHER',
} as const;
export type Outcome = keyof typeof OUTCOME_GROUPS;
export type OutcomeGroup = (typeof OUTCOME_GROUPS)[Outcome];
export const OUTCOMES = Object.keys(OUTCOME_GROUPS) as Outcome[];

export const CHANNEL_LABELS: Record<Channel, string> = {
  PHONE_NATIVE: 'Phone call',
  WHATSAPP_APP_CALL: 'WhatsApp call',
  WHATSAPP_APP_MESSAGE: 'WhatsApp message',
  SMS: 'SMS',
  EMAIL: 'Email',
  IN_PERSON: 'In person',
};
export const DIRECTION_LABELS: Record<Direction, string> = {
  OUTBOUND: 'We contacted them',
  INBOUND: 'They contacted us',
};
export const OUTCOME_LABELS: Record<Outcome, string> = {
  NO_ANSWER: 'No answer',
  BUSY: 'Busy',
  SWITCHED_OFF: 'Switched off',
  NOT_REACHABLE: 'Not reachable',
  CALL_REJECTED: 'Call rejected',
  WHATSAPP_NOT_AVAILABLE: 'Not on WhatsApp',
  WRONG_NUMBER: 'Wrong number',
  INVALID_NUMBER: 'Invalid number',
  CONNECTED_INTERESTED: 'Spoke: interested',
  CONNECTED_CALL_BACK: 'Spoke: call back later',
  CONNECTED_NOT_INTERESTED: 'Spoke: not interested',
  CONNECTED_ALREADY_BOUGHT: 'Spoke: already bought or rented',
  CONNECTED_BROKER: 'Spoke: another broker',
  CONNECTED_DO_NOT_CALL: 'Spoke: asked not to be contacted',
  MESSAGE_SENT: 'Message sent',
  VOICEMAIL: 'Left a voicemail',
  MEETING_HELD: 'Meeting held',
};

const CALLS: readonly Channel[] = ['PHONE_NATIVE', 'WHATSAPP_APP_CALL'];
const PHONE_BASED: readonly Channel[] = [
  'PHONE_NATIVE',
  'WHATSAPP_APP_CALL',
  'WHATSAPP_APP_MESSAGE',
  'SMS',
];

/** Same rule as the interaction_outcome_fits CHECK (migration 0017). */
export function outcomeFits(outcome: Outcome, channel: Channel, direction: Direction): boolean {
  const out = direction === 'OUTBOUND';
  if (OUTCOME_GROUPS[outcome] === 'CONNECTED') return true;
  switch (outcome) {
    case 'NO_ANSWER':
    case 'BUSY':
    case 'SWITCHED_OFF':
    case 'NOT_REACHABLE':
    case 'CALL_REJECTED':
      return out && CALLS.includes(channel);
    case 'VOICEMAIL':
      return out && channel === 'PHONE_NATIVE';
    case 'WHATSAPP_NOT_AVAILABLE':
      return out && (channel === 'WHATSAPP_APP_CALL' || channel === 'WHATSAPP_APP_MESSAGE');
    case 'MESSAGE_SENT':
      return out && ['WHATSAPP_APP_MESSAGE', 'SMS', 'EMAIL'].includes(channel);
    case 'MEETING_HELD':
      return channel === 'IN_PERSON';
    case 'WRONG_NUMBER':
      return PHONE_BASED.includes(channel);
    case 'INVALID_NUMBER':
      return out && PHONE_BASED.includes(channel);
    default:
      return false;
  }
}

/** The outcomes offered for a channel and direction, in display order. */
export function allowedOutcomes(channel: Channel, direction: Direction): Outcome[] {
  return OUTCOMES.filter((o) => outcomeFits(o, channel, direction));
}

/** A person's duration estimate makes sense for calls and meetings only. */
export const durationAllowed = (channel: Channel) =>
  channel === 'PHONE_NATIVE' || channel === 'WHATSAPP_APP_CALL' || channel === 'IN_PERSON';

/** The FR-065 outbound rule's channel for a manual record of outbound contact. */
export function outboundChannelFor(channel: Channel): OutboundChannel {
  switch (channel) {
    case 'PHONE_NATIVE':
      return 'MANUAL_CALL';
    case 'WHATSAPP_APP_CALL':
    case 'WHATSAPP_APP_MESSAGE':
      return 'MANUAL_WHATSAPP';
    case 'SMS':
    case 'EMAIL':
      return 'MANUAL_MESSAGE';
    case 'IN_PERSON':
      return 'MANUAL_IN_PERSON';
  }
}

/** The contact status an outcome asks for (Q3), or null. */
export function requestedContactStatus(outcome: Outcome): ContactStatus | null {
  if (outcome === 'CONNECTED_DO_NOT_CALL') return 'DO_NOT_CONTACT';
  if (outcome === 'WRONG_NUMBER' || outcome === 'INVALID_NUMBER') return 'INVALID';
  return null;
}

export type StatusEffect =
  | { kind: 'none' }
  /** The outcome asks for a change and it will be made (after confirmation). */
  | { kind: 'change'; to: ContactStatus }
  /** The outcome asks for a change that is not made; the reason is shown. */
  | { kind: 'unchanged'; message: string };

/**
 * What logging this outcome does to the lead's contact status. Never weakens it: a Do-Not-Contact
 * lead is never marked Invalid, and an outcome never lifts Do-Not-Contact.
 */
export function contactStatusEffect(outcome: Outcome, current: ContactStatus): StatusEffect {
  const to = requestedContactStatus(outcome);
  if (!to) return { kind: 'none' };
  if (current === to)
    return {
      kind: 'unchanged',
      message:
        to === 'DO_NOT_CONTACT'
          ? 'This lead is already marked do not contact.'
          : "This lead's number is already marked invalid.",
    };
  if (current === 'DO_NOT_CONTACT')
    return {
      kind: 'unchanged',
      message: 'This lead stays do not contact. Its number is not marked invalid.',
    };
  return { kind: 'change', to };
}

/** lead-lifecycle §2: the first connected outcome moves an Assigned lead to Contacted (Q5). */
export const movesToContacted = (outcome: Outcome, stage: string) =>
  OUTCOME_GROUPS[outcome] === 'CONNECTED' && stage === 'ASSIGNED';

/** Reported time: not in the future, at most seven days ago (owner default 2026-10-29). */
export const OCCURRED_MAX_AGE_MS = 7 * 24 * 3600_000;
export function occurredAtProblem(at: Date | null, now: Date): string | null {
  if (!at || Number.isNaN(at.getTime())) return 'Enter when it happened';
  if (at.getTime() > now.getTime()) return 'It cannot be in the future';
  if (now.getTime() - at.getTime() > OCCURRED_MAX_AGE_MS)
    return 'Log interactions within seven days of when they happened';
  return null;
}

/** "2026-10-29T10:30" in the org's time zone, for a datetime-local input. */
export function orgLocalInputValue(d: Date, timeZone: string): string {
  const parts = Object.fromEntries(
    new Intl.DateTimeFormat('en-GB', {
      timeZone,
      year: 'numeric',
      month: '2-digit',
      day: '2-digit',
      hour: '2-digit',
      minute: '2-digit',
      hourCycle: 'h23',
    })
      .formatToParts(d)
      .map((p) => [p.type, p.value]),
  );
  return `${parts.year}-${parts.month}-${parts.day}T${parts.hour}:${parts.minute}`;
}
