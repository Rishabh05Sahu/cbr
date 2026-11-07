// FR-065 on the lead page: the banner and the contact status card, rendered to static HTML (no
// DOM environment in this repo) with the server actions mocked.
import { createElement, type ComponentProps } from 'react';
import { renderToStaticMarkup } from 'react-dom/server';
import { describe, expect, it, vi } from 'vitest';

vi.mock('next/navigation', () => ({ useRouter: () => ({ refresh: vi.fn() }) }));
vi.mock('@/modules/leads/actions', () => ({ changeContactStatusAction: vi.fn() }));
const { ContactStatusBanner, ContactStatusCard } = await import('./contact-status');

type CardProps = ComponentProps<typeof ContactStatusCard>;
const card = (p: Partial<CardProps>) =>
  renderToStaticMarkup(
    createElement(ContactStatusCard, {
      leadId: 'l1',
      version: 4,
      status: 'OK',
      archived: false,
      canChange: true,
      canLift: false,
      history: [],
      ...p,
    }),
  );
const options = (html: string) =>
  [
    ...(html.match(/<select[^>]*name="toStatus"[^>]*>(.*?)<\/select>/)?.[1] ?? '').matchAll(
      /value="([^"]*)"/g,
    ),
  ].map((m) => m[1]);

describe('ContactStatusBanner', () => {
  it('shows nothing for OK, a blocking alert for do-not-contact and a warning for invalid', () => {
    expect(
      renderToStaticMarkup(createElement(ContactStatusBanner, { status: 'OK', since: null })),
    ).toBe('');
    const dnc = renderToStaticMarkup(
      createElement(ContactStatusBanner, { status: 'DO_NOT_CONTACT', since: null }),
    );
    expect(dnc).toContain('role="alert"');
    expect(dnc).toContain('Do not contact.');
    expect(dnc).toContain('Do not call or message them by any channel.');
    const inv = renderToStaticMarkup(
      createElement(ContactStatusBanner, { status: 'INVALID', since: null }),
    );
    expect(inv).toContain('role="status"');
    expect(inv).toContain('needs a confirmation');
  });
});

describe('ContactStatusCard', () => {
  it('offers the permitted changes with reason, method and evidence fields', () => {
    const html = card({});
    expect(options(html)).toEqual(['DO_NOT_CONTACT', 'INVALID']);
    expect(html).toContain('name="version" value="4"');
    expect(html).toMatch(/<textarea[^>]*name="reason"[^>]*required/);
    expect(html).toContain('>Save contact status</button>');
    expect(html).not.toContain('Contact status saved.');
  });
  it('keeps the form mounted, without fields, when a Sales Executive faces do-not-contact', () => {
    const html = card({ status: 'DO_NOT_CONTACT' });
    expect(html).toMatch(/<form[^>]*>.*Only an Owner or Admin can lift do-not-contact/);
    expect(html).not.toContain('name="toStatus"');
    expect(html).not.toContain('>Save contact status</button>');
  });
  it('requires a consent basis and evidence when an Owner/Admin lifts do-not-contact', () => {
    const html = card({ status: 'DO_NOT_CONTACT', canLift: true });
    expect(options(html)).toEqual(['OK']);
    expect(html).toMatch(/<select[^>]*name="method"[^>]*required/);
    expect(html).toMatch(/<input(?=[^>]*name="evidenceRef")(?=[^>]*required)/);
    expect(html).toContain('Form or opt-in record');
    expect(html).not.toContain('>Other</option>');
  });
  it('offers only do-not-contact on an archived lead', () => {
    expect(options(card({ archived: true }))).toEqual(['DO_NOT_CONTACT']);
  });
  it('shows no form to people who cannot change it, but still shows the history', () => {
    const html = card({
      canChange: false,
      status: 'DO_NOT_CONTACT',
      history: [
        {
          id: 'e1',
          fromStatus: 'OK',
          toStatus: 'DO_NOT_CONTACT',
          origin: 'CARRY_OVER',
          method: null,
          reason: null,
          evidenceRef: null,
          relatedLeadId: 'l0',
          changedByName: 'Asha',
          changedAt: new Date('2026-10-28T10:00:00Z'),
        },
      ],
    });
    expect(html).not.toContain('<form');
    expect(html).toContain('carried over from an earlier lead for this number');
    expect(html).toContain('Asha');
  });
});
