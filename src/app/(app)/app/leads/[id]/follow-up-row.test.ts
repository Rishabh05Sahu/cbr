// FR-100/FR-102: one task row, rendered to static HTML (no DOM environment in this repo) with the
// server actions and router mocked. A follow-up and the other task types on the lead page, and a
// task with no lead on My Day (one action that takes the kind; no lead id is sent).
import { createElement } from 'react';
import { renderToStaticMarkup } from 'react-dom/server';
import { describe, expect, it, vi } from 'vitest';
import type { FollowUpView } from '@/modules/tasks';
import { TASK_TYPE_LABELS, TASK_TYPES } from '@/modules/tasks/follow-up-rules';

vi.mock('@/modules/tasks/actions', () => ({
  completeFollowUpAction: vi.fn(),
  rescheduleFollowUpAction: vi.fn(),
  cancelFollowUpAction: vi.fn(),
  myDayTaskAction: vi.fn(),
  updateMeetingAction: vi.fn(),
}));
vi.mock('next/navigation', () => ({ useRouter: () => ({ refresh: vi.fn() }) }));
const { FollowUpRow } = await import('./follow-up-row');

const view = (over: Partial<FollowUpView> = {}): FollowUpView => ({
  id: 't1',
  type: 'FOLLOW_UP',
  title: 'Synthetic title',
  dueAt: new Date('2026-10-30T05:00:00Z'),
  priority: 'NORMAL',
  status: 'OPEN',
  assigneeUserId: 'u1',
  assigneeName: 'Synthetic Exec',
  assignedByName: null,
  rescheduleCount: 0,
  completedAt: null,
  cancelledAt: null,
  cancelReason: null,
  version: 2,
  overdue: false,
  canUpdate: true,
  rescheduleNeedsReason: false,
  endAt: null,
  location: null,
  attendees: [],
  endAtLocal: null,
  seriesId: null,
  ...over,
});
const render = (task: FollowUpView, leadId: string | null, children?: string) =>
  renderToStaticMarkup(
    createElement(
      FollowUpRow,
      { task, leadId } as Parameters<typeof FollowUpRow>[0],
      children ? createElement('p', null, children) : undefined,
    ),
  );

describe('FollowUpRow', () => {
  it('names every task type', () => {
    for (const t of TASK_TYPES) expect(TASK_TYPE_LABELS[t]).toBeTruthy();
  });

  it('shows a follow-up as before: no type badge, the assignee, "Cancel follow-up"', () => {
    const html = render(view(), 'l1');
    expect(html).not.toContain('>Follow-up<');
    expect(html).toContain('Synthetic Exec');
    expect(html).toContain('Cancel follow-up…');
    expect(html).toContain('name="leadId" value="l1"');
    expect(html).not.toContain('name="kind"');
  });

  it('labels the other types and calls them tasks', () => {
    const html = render(view({ type: 'CALL', priority: 'URGENT' }), 'l1');
    expect(html).toContain('>Call<');
    expect(html).toContain('Urgent priority');
    expect(html).toContain('Cancel task…');
  });

  it('on My Day sends the kind instead of a lead and shows what the page passes', () => {
    const html = render(view({ type: 'DOCUMENT' }), null, 'No lead');
    expect(html).toContain('name="kind" value="complete"');
    expect(html).not.toContain('name="leadId"');
    expect(html).toContain('No lead');
    expect(html).not.toContain('Synthetic Exec');
  });

  it('names who assigned a task created by someone else (FR-103)', () => {
    expect(render(view({ type: 'CALL', assignedByName: 'Synthetic Manager' }), 'l1')).toContain(
      'Assigned by Synthetic Manager',
    );
    expect(render(view(), 'l1')).not.toContain('Assigned by');
  });

  it('shows the end, location and attendees, and offers to edit them (FR-104)', () => {
    const html = render(
      view({
        type: 'MEETING',
        endAt: new Date('2026-10-30T06:00:00Z'),
        endAtLocal: '2026-10-30T11:30',
        location: 'Synthetic office, room 2',
        attendees: [{ userId: 'u2', name: 'Synthetic Colleague' }],
      }),
      'l1',
    );
    expect(html).toContain('Until ');
    expect(html).toContain('Where: Synthetic office, room 2');
    expect(html).toContain('With: Synthetic Colleague');
    expect(html).toContain('Edit meeting…');
    // Other types have no meeting details or edit button.
    const call = render(view({ type: 'CALL' }), 'l1');
    expect(call).not.toContain('Edit meeting');
    expect(call).not.toContain('Until ');
  });

  it('offers no actions on a task the caller cannot change, and no contact links', () => {
    const html = render(view({ type: 'CALL', canUpdate: false }), 'l1');
    expect(html).not.toContain('<form');
    expect(html).not.toMatch(/tel:|sms:|wa\.me|whatsapp:/i);
  });
});
