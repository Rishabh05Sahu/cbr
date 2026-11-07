// FR-065 contact status rules (lead-lifecycle §1/§4, threat model T16, legal checklist C3;
// ADR-0012). Pure: no database access. The database enforces the same transitions
// (migration 0015, lead_contact_status_event_guard); these give the UI its choices and the
// commands their field errors.
//
// Statuses: OK, DO_NOT_CONTACT ("stop contacting me": consent withdrawn), INVALID (wrong or
// invalid number). Transitions:
//   OK / INVALID -> DO_NOT_CONTACT   anyone who may update the lead; how it was asked + reason
//   OK <-> INVALID                    anyone who may update the lead; reason
//   DO_NOT_CONTACT -> OK              Owner/Admin only (lead.lift_do_not_contact); consent basis,
//                                     evidence reference and reason
//   DO_NOT_CONTACT -> INVALID         never (it would weaken the restriction)
// An archived lead only accepts -> DO_NOT_CONTACT (a stop request never waits for a restore).
//
// Outbound eligibility (the one rule every future launcher and integration send must call):
//   DO_NOT_CONTACT  blocked on every channel. Not a warning: there is no override.
//   INVALID         manual call / WhatsApp: allowed after a warning and confirmation (workflow B);
//                   integration sends: blocked (owner decision 2026-10-28).
//   OK              allowed (other checks, such as channel opt-in, still apply later).

export const CONTACT_STATUSES = ['OK', 'DO_NOT_CONTACT', 'INVALID'] as const;
export type ContactStatus = (typeof CONTACT_STATUSES)[number];

/** How a Do-Not-Contact request was made. */
export const DNC_METHODS = ['VERBAL', 'WRITTEN', 'OTHER'] as const;
/** The consent basis recorded when an Owner/Admin lifts Do-Not-Contact. */
export const LIFT_BASES = ['VERBAL', 'WRITTEN', 'FORM_OPT_IN', 'INBOUND_ENQUIRY'] as const;

export const CONTACT_STATUS_LABELS: Record<ContactStatus, string> = {
  OK: 'OK to contact',
  DO_NOT_CONTACT: 'Do not contact',
  INVALID: 'Invalid number',
};
export const CONTACT_METHOD_LABELS: Record<string, string> = {
  VERBAL: 'Said so on a call or in person',
  WRITTEN: 'In writing (message, email, letter)',
  OTHER: 'Other',
  FORM_OPT_IN: 'Form or opt-in record',
  INBOUND_ENQUIRY: 'They contacted us again',
};

export interface ChangeContext {
  /** lead.lift_do_not_contact (Owner/Admin). */
  canLift: boolean;
  archived: boolean;
}

/** The statuses this lead may be changed to by this person, in display order. */
export function allowedContactStatusTargets(
  current: ContactStatus,
  c: ChangeContext,
): ContactStatus[] {
  if (c.archived) return current === 'DO_NOT_CONTACT' ? [] : ['DO_NOT_CONTACT'];
  switch (current) {
    case 'OK':
      return ['DO_NOT_CONTACT', 'INVALID'];
    case 'INVALID':
      return ['DO_NOT_CONTACT', 'OK'];
    case 'DO_NOT_CONTACT':
      return c.canLift ? ['OK'] : [];
  }
}

export interface ContactStatusChange {
  from: ContactStatus;
  to: ContactStatus;
  reason: string | null;
  method: string | null;
  evidenceRef: string | null;
}

/** Field errors for a requested change (empty when it is allowed and complete). */
export function contactStatusChangeErrors(
  ch: ContactStatusChange,
  c: ChangeContext,
): Record<string, string[]> {
  const e: Record<string, string[]> = {};
  if (ch.from === ch.to) e.toStatus = ['The lead already has this contact status'];
  else if (ch.from === 'DO_NOT_CONTACT' && ch.to !== 'OK')
    e.toStatus = ['Do-not-contact can only be lifted to OK'];
  else if (ch.from === 'DO_NOT_CONTACT' && !c.canLift)
    e.toStatus = ['Only an Owner or Admin can lift do-not-contact'];
  else if (!allowedContactStatusTargets(ch.from, c).includes(ch.to))
    e.toStatus = ['This lead is archived: only do-not-contact can be recorded'];
  if (!ch.reason) e.reason = ['Say why the contact status changes'];
  if (ch.to === 'DO_NOT_CONTACT' && !(DNC_METHODS as readonly string[]).includes(ch.method ?? ''))
    e.method = ['Choose how they asked not to be contacted'];
  if (ch.from === 'DO_NOT_CONTACT' && ch.to === 'OK') {
    if (!(LIFT_BASES as readonly string[]).includes(ch.method ?? ''))
      e.method = ['Choose the consent basis for contacting them again'];
    if (!ch.evidenceRef) e.evidenceRef = ['Add a reference to the evidence of renewed consent'];
  }
  return e;
}

// MANUAL_MESSAGE (SMS, email) and MANUAL_IN_PERSON were added for manual interaction records
// (FR-083, ADR-0014). Every MANUAL_* channel follows the same rule.
export const OUTBOUND_CHANNELS = [
  'MANUAL_CALL',
  'MANUAL_WHATSAPP',
  'MANUAL_MESSAGE',
  'MANUAL_IN_PERSON',
  'INTEGRATION_CALL',
  'INTEGRATION_MESSAGE',
] as const;
export type OutboundChannel = (typeof OUTBOUND_CHANNELS)[number];

export type OutboundEligibility =
  | { allowed: false; reason: string }
  | { allowed: true; requiresConfirmation: false }
  | { allowed: true; requiresConfirmation: true; warning: string };

export function outboundEligibility(
  status: ContactStatus,
  channel: OutboundChannel,
): OutboundEligibility {
  if (status === 'DO_NOT_CONTACT')
    return { allowed: false, reason: 'This lead asked not to be contacted' };
  if (status === 'INVALID') {
    if (channel === 'INTEGRATION_CALL' || channel === 'INTEGRATION_MESSAGE')
      return { allowed: false, reason: "This lead's number is marked invalid" };
    return {
      allowed: true,
      requiresConfirmation: true,
      warning: "This lead's number is marked invalid. Contact them anyway?",
    };
  }
  return { allowed: true, requiresConfirmation: false };
}
