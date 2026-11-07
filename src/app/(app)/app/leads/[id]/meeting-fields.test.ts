// FR-104 meeting fields, rendered to static HTML: end time, location or link, one checkbox per
// invitable person (pre-checked when editing), labelled controls with unique ids.
import { createElement } from 'react';
import { renderToStaticMarkup } from 'react-dom/server';
import { describe, expect, it } from 'vitest';
import { MeetingFields, meetingSummary } from './meeting-fields';

const people = [
  { userId: 'u1', name: 'Synthetic One' },
  { userId: 'u2', name: 'Synthetic Two' },
];

describe('MeetingFields', () => {
  it('in an add form: optional for other types, every control labelled', () => {
    const html = renderToStaticMarkup(createElement(MeetingFields, { idPrefix: 'nt', people }));
    expect(html).toContain('Meeting details (meetings only)');
    expect(html).toMatch(/<label[^>]*for="nt-end"/);
    expect(html).toMatch(/<input[^>]*id="nt-end"[^>]*name="endAt"/);
    expect(html).not.toMatch(/id="nt-end"[^>]*required/);
    expect(html).toMatch(/<label[^>]*for="nt-location"/);
    expect(html.match(/name="attendeeUserIds"/g)).toHaveLength(2);
    expect(html).not.toContain('checked');
  });

  it('when editing: end required, values and attendees pre-filled', () => {
    const html = renderToStaticMarkup(
      createElement(MeetingFields, {
        idPrefix: 'mt',
        people,
        endAtLocal: '2026-10-30T11:30',
        location: 'Room 2',
        attendeeIds: ['u2'],
        meetingOnly: false,
      }),
    );
    expect(html).toMatch(/id="mt-end"[^>]*required/);
    expect(html).toContain('value="2026-10-30T11:30"');
    expect(html).toContain('value="Room 2"');
    const box = (id: string) => new RegExp(`<input[^>]*value="${id}"[^>]*>`).exec(html)![0];
    expect(box('u2')).toContain('checked');
    expect(box('u1')).not.toContain('checked');
  });

  it('lists no attendees section when nobody can be invited', () => {
    const html = renderToStaticMarkup(createElement(MeetingFields, { idPrefix: 'x', people: [] }));
    expect(html).not.toContain('attendeeUserIds');
  });
});

describe('meetingSummary', () => {
  it('names end, place and people only when set', () => {
    const fmt = () => '11:30';
    expect(meetingSummary({ endAt: null, location: null, attendees: [] }, fmt)).toEqual([]);
    expect(
      meetingSummary({ endAt: new Date(), location: 'Room 2', attendees: people }, fmt),
    ).toEqual(['Until 11:30', 'Where: Room 2', 'With: Synthetic One, Synthetic Two']);
  });
});
