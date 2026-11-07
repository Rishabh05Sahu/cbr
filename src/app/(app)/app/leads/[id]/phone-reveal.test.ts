// FR-060 on the lead page: the reveal control, rendered to static HTML (no DOM environment in
// this repo) with the server action mocked. It only ever receives masked numbers from the server.
import { createElement } from 'react';
import { renderToStaticMarkup } from 'react-dom/server';
import { describe, expect, it, vi } from 'vitest';

vi.mock('@/modules/leads/actions', () => ({ revealLeadPhoneAction: vi.fn() }));
const { PhoneReveal } = await import('./phone-reveal');

const render = (canReveal: boolean) =>
  renderToStaticMarkup(
    createElement(PhoneReveal, {
      leadId: 'l1',
      masked: { primary: '+91 ••••••4066', alternate: null },
      canReveal,
    }),
  );

describe('PhoneReveal', () => {
  it('shows the masked number and a reveal button to people who may reveal', () => {
    const html = render(true);
    expect(html).toContain('+91 ••••••4066');
    expect(html).toContain('>Reveal number</button>');
    expect(html).toContain('recorded in the audit log');
    expect(html).toContain('name="leadId" value="l1"');
  });
  it('shows only the masked number to people who may not', () => {
    const html = render(false);
    expect(html).toContain('+91 ••••••4066');
    expect(html).not.toContain('Reveal number');
    expect(html).not.toContain('<form');
  });
});
