// FR-083/084 on the lead page: the outcome sheet, rendered to static HTML (no DOM environment in
// this repo) with the server action mocked. It never contains a launcher or a tel:/wa.me link;
// its ids are unique and every control has a label; Do-Not-Contact and Invalid numbers show the
// approved rules (Q1, Q2) before anything is submitted.
import { createElement } from 'react';
import { renderToStaticMarkup } from 'react-dom/server';
import { describe, expect, it, vi } from 'vitest';
import type { ContactStatus } from '@/modules/leads/contactability';

vi.mock('@/modules/interactions/actions', () => ({ logInteractionAction: vi.fn() }));
const { InteractionSheet } = await import('./interaction-sheet');

const render = (
  contactStatus: ContactStatus,
  extra: Partial<Parameters<typeof InteractionSheet>[0]> = {},
) =>
  renderToStaticMarkup(
    createElement(InteractionSheet, {
      leadId: 'l1',
      version: 3,
      stage: 'ASSIGNED',
      contactStatus,
      occurredAt: '2026-10-29T10:30',
      occurredMin: '2026-10-22T10:31',
      followUp: {
        own: {
          id: 't1',
          version: 2,
          dueAt: new Date('2026-10-30T05:00:00Z'),
          rescheduleNeedsReason: false,
        },
        canSchedule: false,
        blockedReason: null,
      },
      dncMethods: [{ code: 'VERBAL', label: 'Said so' }],
      requirementFields: createElement('input', { id: 'ix-req-city', name: 'preferredCity' }),
      ...extra,
    }),
  );

const ids = (html: string) => [...html.matchAll(/ id="([^"]+)"/g)].map((m) => m[1]!);

describe('InteractionSheet', () => {
  it('has no launcher, link or provider call, only a form', () => {
    for (const s of ['OK', 'INVALID', 'DO_NOT_CONTACT'] as const) {
      const html = render(s);
      expect(html).not.toMatch(/tel:|wa\.me|whatsapp:\/\/|sms:|mailto:/i);
      expect(html).not.toContain('<a ');
      expect(html).toContain('>Save interaction</button>');
    }
  });

  it('gives every control a unique id and a label', () => {
    const html = render('OK');
    const all = ids(html);
    expect(new Set(all).size).toBe(all.length);
    for (const id of all.filter((i) => i.startsWith('ix-') && i !== 'ix-req-city'))
      expect(html).toContain(`for="${id}"`);
  });

  it('carries the lead, its version and a fresh idempotency key; defaults to now', () => {
    const html = render('OK');
    expect(html).toContain('name="leadId" value="l1"');
    expect(html).toContain('name="version" value="3"');
    expect(html).toMatch(/name="idempotencyKey" value="[0-9a-f-]{36}"/);
    expect(html).toContain('value="2026-10-29T10:30"');
    expect(html).toContain('min="2026-10-22T10:31"');
  });

  it('on a do-not-contact lead logs only contact the customer started (Q1, Q2)', () => {
    const html = render('DO_NOT_CONTACT');
    expect(html).toContain('You can log only contact they started');
    expect(html).toMatch(/id="ix-dir-OUTBOUND"[^>]*disabled/);
    expect(html).toMatch(/id="ix-dir-INBOUND"[^>]*checked/);
  });

  it('on an invalid number asks for a confirmation before outbound contact', () => {
    expect(render('INVALID')).toContain('number is marked invalid. I contacted them anyway.');
    expect(render('OK')).not.toContain('marked invalid. I contacted');
  });

  it("offers the caller's own follow-up and the optional requirements section", () => {
    const html = render('OK');
    expect(html).toContain('name="followUpTaskId" value="t1"');
    expect(html).toContain('Mark my follow-up');
    expect(html).toContain('Update requirements (optional)');
    expect(html).toContain('<details');
    // Review L1: no blanket requirements flag; only changed fields are sent, on submit.
    expect(html).not.toContain('name="requirements"');
    expect(html).toContain('data-requirements');
  });

  it('explains why a closed lead takes no follow-up', () => {
    const html = render('OK', {
      followUp: {
        own: null,
        canSchedule: false,
        blockedReason: 'Won and lost leads take no follow-ups.',
      },
    });
    expect(html).toContain('Won and lost leads take no follow-ups.');
    expect(html).not.toContain('name="nextDueAt"');
  });
});

describe('InteractionSheet: script version shown (FR-098)', () => {
  const sheetIn = async (
    initial: { versionId: string; name: string; versionNo: number } | null,
  ) => {
    const { ShownScriptProvider } = await import('./shown-script');
    const sheet = createElement(InteractionSheet, {
      leadId: 'l1',
      version: 3,
      stage: 'CONTACTED',
      contactStatus: 'OK',
      occurredAt: '2026-10-29T10:30',
      occurredMin: '2026-10-22T10:31',
      followUp: null,
      dncMethods: [],
      requirementFields: null,
    });
    return renderToStaticMarkup(
      createElement(
        ShownScriptProvider,
        { initial } as Parameters<typeof ShownScriptProvider>[0],
        sheet,
      ),
    );
  };

  it('sends no script version and says nothing when the drawer was not opened', async () => {
    const html = await sheetIn(null);
    expect(html).toContain('<input type="hidden" name="scriptVersionId" value=""/>');
    expect(html).not.toContain('Script shown');
  });

  it('sends the version last shown and names it before saving', async () => {
    const html = await sheetIn({ versionId: 'ver-7', name: 'Buyers first call', versionNo: 3 });
    expect(html).toContain('<input type="hidden" name="scriptVersionId" value="ver-7"/>');
    expect(html).toContain(
      'Script shown: Buyers first call (version 3). It is saved with this interaction.',
    );
  });
});
