import { describe, expect, it } from 'vitest';
import { outboundEligibility } from '@/modules/leads/contactability';
import {
  intentOutboundChannel,
  launcherHref,
  sheetChannelFor,
  PROMPT_WINDOW_MS,
} from './call-intent-rules';
import { CHANNELS } from './rules';

describe('launcherHref (FR-080/081)', () => {
  it('opens the dialer with the full E.164 number', () => {
    expect(launcherHref('PHONE_NATIVE', '+919803704066')).toBe('tel:+919803704066');
  });
  it('opens the WhatsApp chat with the number without "+"', () => {
    expect(launcherHref('WHATSAPP_APP', '+919803704066')).toBe('https://wa.me/919803704066');
  });
  it.each(['', '9803704066', '+91 98037 04066', '+0123456789', '+91abc', 'tel:+919803704066'])(
    'refuses %j (never builds a link from anything but a stored E.164 number)',
    (bad) => {
      expect(() => launcherHref('PHONE_NATIVE', bad)).toThrow();
      expect(() => launcherHref('WHATSAPP_APP', bad)).toThrow();
    },
  );
});

describe('contact status for taps (FR-065)', () => {
  it('checks Call as a manual call and WhatsApp as manual WhatsApp', () => {
    expect(intentOutboundChannel('PHONE_NATIVE')).toBe('MANUAL_CALL');
    expect(intentOutboundChannel('WHATSAPP_APP')).toBe('MANUAL_WHATSAPP');
  });
  it('so Do-Not-Contact is refused and Invalid needs a confirmation, on both buttons', () => {
    for (const c of ['PHONE_NATIVE', 'WHATSAPP_APP'] as const) {
      expect(outboundEligibility('DO_NOT_CONTACT', intentOutboundChannel(c)).allowed).toBe(false);
      expect(outboundEligibility('INVALID', intentOutboundChannel(c))).toMatchObject({
        allowed: true,
        requiresConfirmation: true,
      });
      expect(outboundEligibility('OK', intentOutboundChannel(c))).toMatchObject({
        allowed: true,
        requiresConfirmation: false,
      });
    }
  });
});

describe('the outcome prompt (FR-082)', () => {
  it('starts the sheet on a valid interaction channel for each button', () => {
    expect(sheetChannelFor('PHONE_NATIVE')).toBe('PHONE_NATIVE');
    expect(sheetChannelFor('WHATSAPP_APP')).toBe('WHATSAPP_APP_MESSAGE');
    for (const c of ['PHONE_NATIVE', 'WHATSAPP_APP'] as const)
      expect(CHANNELS).toContain(sheetChannelFor(c));
  });
  it('is shown for two hours after a tap', () => {
    expect(PROMPT_WINDOW_MS).toBe(2 * 60 * 60 * 1000);
  });
});
