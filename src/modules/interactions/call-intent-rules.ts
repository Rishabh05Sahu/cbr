// FR-080/081/082 rules (ADR-0025). Pure: no database access; shared by the server command, the
// lead page and the unit tests. Mirrors the call_intent CHECKs (migration 0028).
import type { OutboundChannel } from '@/modules/leads/contactability';
import type { Channel } from './rules';

/** PHONE_NATIVE opens the dialer (tel:); WHATSAPP_APP opens the lead's chat (wa.me). */
export const INTENT_CHANNELS = ['PHONE_NATIVE', 'WHATSAPP_APP'] as const;
export type IntentChannel = (typeof INTENT_CHANNELS)[number];
export const NUMBER_KINDS = ['PRIMARY', 'ALTERNATE'] as const;

export const INTENT_CHANNEL_LABELS: Record<IntentChannel, string> = {
  PHONE_NATIVE: 'Call',
  WHATSAPP_APP: 'WhatsApp',
};

/** FR-082: the outcome prompt is shown for this long after a tap, unless an outcome is logged. */
export const PROMPT_WINDOW_MS = 2 * 60 * 60 * 1000;

/** The FR-065 channel a tap is checked against. */
export function intentOutboundChannel(c: IntentChannel): OutboundChannel {
  return c === 'PHONE_NATIVE' ? 'MANUAL_CALL' : 'MANUAL_WHATSAPP';
}

/**
 * The interaction channel the outcome sheet starts on after a tap. WhatsApp opens a chat, so a
 * message is the likelier record; the person can switch it to a WhatsApp call.
 */
export function sheetChannelFor(c: IntentChannel): Channel {
  return c === 'PHONE_NATIVE' ? 'PHONE_NATIVE' : 'WHATSAPP_APP_MESSAGE';
}

/** The link a tap opens. Numbers are stored as E.164 ("+919803704066"). */
export function launcherHref(channel: IntentChannel, e164: string): string {
  if (!/^\+[1-9]\d{6,14}$/.test(e164)) throw new Error('not an E.164 number');
  return channel === 'PHONE_NATIVE' ? `tel:${e164}` : `https://wa.me/${e164.slice(1)}`;
}
