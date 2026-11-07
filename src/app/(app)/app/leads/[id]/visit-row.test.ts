// FR-151/152 visit row, rendered to static HTML with the server action and router mocked: status,
// meeting point and outcome; actions only for a manageable open visit; Attended / No-show only from
// the visit's day; never a call or message link.
import { createElement } from 'react';
import { renderToStaticMarkup } from 'react-dom/server';
import { describe, expect, it, vi } from 'vitest';
import type { VisitView } from '@/modules/visits';

vi.mock('@/modules/visits/actions', () => ({ updateVisitAction: vi.fn() }));
vi.mock('next/navigation', () => ({ useRouter: () => ({ refresh: vi.fn() }) }));
const { VisitRow } = await import('./visit-row');

const visit = (over: Partial<VisitView> = {}): VisitView => ({
  id: 'v1',
  scheduledFor: new Date('2026-11-02T05:00:00Z'),
  location: 'Synthetic site office',
  status: 'SCHEDULED',
  rescheduleCount: 0,
  cancelReason: null,
  noShowReason: null,
  attendedAt: null,
  interestLevel: null,
  objections: [],
  outcomeNotes: null,
  nextAction: null,
  version: 1,
  assignedUserId: 'u1',
  assigneeName: 'Synthetic Exec',
  lead: { id: 'l1', fullName: 'Synthetic Lead' },
  leadName: 'Synthetic Lead',
  canManage: true,
  outcomeDue: false,
  ...over,
});
const render = (v: VisitView) =>
  renderToStaticMarkup(createElement(VisitRow, { visit: v, leadId: 'l1' }));

describe('VisitRow', () => {
  it('shows the visit and the actions before its day (no outcome yet)', () => {
    const html = render(visit());
    expect(html).toContain('Meeting point: Synthetic site office');
    expect(html).toContain('With Synthetic Exec');
    expect(html).toContain('>Confirm<');
    expect(html).toContain('Reschedule…');
    expect(html).toContain('Cancel visit…');
    expect(html).not.toContain('Attended…');
    expect(html).not.toContain('No-show…');
  });
  it('offers the outcome from the visit day; no Confirm when already confirmed', () => {
    const html = render(visit({ status: 'CONFIRMED', outcomeDue: true }));
    expect(html).toContain('Attended…');
    expect(html).toContain('No-show…');
    expect(html).not.toContain('>Confirm<');
  });
  it('shows a recorded outcome without actions, and never contact links', () => {
    const html = render(
      visit({
        status: 'ATTENDED',
        canManage: false,
        interestLevel: 'HIGH',
        objections: ['Price'],
        nextAction: 'Call back',
        outcomeNotes: 'Liked it',
      }),
    );
    expect(html).toContain('Interest: High');
    expect(html).toContain('Objections: Price');
    expect(html).toContain('Next action: Call back');
    expect(html).not.toContain('<form');
    expect(html).not.toMatch(/tel:|sms:|wa\.me|whatsapp:/i);
  });
});
