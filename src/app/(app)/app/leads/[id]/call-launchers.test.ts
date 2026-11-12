// FR-080/081 on the lead page: the Call and WhatsApp buttons, rendered to static HTML with the
// server action and router mocked. The number never appears in the page before a tap (the server
// returns the link only after recording the tap); Do-Not-Contact shows no buttons; an Invalid
// number needs the confirmation first. FR-082: the outcome prompt.
import { createElement } from 'react';
import { renderToStaticMarkup } from 'react-dom/server';
import { describe, expect, it, vi } from 'vitest';
import type { ContactStatus } from '@/modules/leads/contactability';

vi.mock('@/modules/interactions/actions', () => ({ recordCallIntentAction: vi.fn() }));
vi.mock('next/navigation', () => ({ useRouter: () => ({ refresh: vi.fn() }) }));
const { CallLaunchers } = await import('./call-launchers');
const { CallPrompt } = await import('./call-prompt');

const render = (contactStatus: ContactStatus, hasAlternate = false, masked = false) =>
  renderToStaticMarkup(
    createElement(CallLaunchers, { leadId: 'l1', contactStatus, hasAlternate, masked }),
  );

describe('CallLaunchers', () => {
  it('shows Call and WhatsApp with no number or link before a tap', () => {
    const html = render('OK');
    expect(html).toContain('>Call<');
    expect(html).toContain('>WhatsApp<');
    expect(html).not.toMatch(/tel:|wa\.me|\+91|\d{10}/);
    expect(html).not.toMatch(/<button[^>]* disabled=""/);
  });

  it('shows no buttons on a Do-Not-Contact lead', () => {
    const html = render('DO_NOT_CONTACT');
    expect(html).toContain('asked not to be contacted');
    expect(html).not.toMatch(/<button/);
  });

  it('needs the invalid-number confirmation before either button works', () => {
    const html = render('INVALID');
    expect(html).toContain('marked invalid');
    expect(html.match(/<button[^>]* disabled=""/g)).toHaveLength(2);
  });

  it('offers the alternate number only when there is one, and says masked taps are reveals', () => {
    expect(render('OK')).not.toContain('Alternate');
    expect(render('OK', true)).toContain('Alternate');
    expect(render('OK', false, true)).toContain('counts as a reveal');
    expect(render('OK', false, false)).not.toContain('counts as a reveal');
  });
});

describe('CallPrompt (FR-082)', () => {
  it('links to the outcome sheet and can be dismissed', () => {
    const html = renderToStaticMarkup(
      createElement(CallPrompt, {
        intentId: 'i1',
        text: 'You tapped Call at 10:30. How did it go?',
      }),
    );
    expect(html).toContain('href="#log-interaction"');
    expect(html).toContain('How did it go?');
    expect(html).toContain('Not now');
  });
});
