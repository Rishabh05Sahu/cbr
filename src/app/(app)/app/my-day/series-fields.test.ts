// FR-107 series fields, rendered to static HTML: labelled controls with unique ids, meeting fields
// only when they may apply, and the edit form pre-filled with the series.
import { createElement } from 'react';
import { renderToStaticMarkup } from 'react-dom/server';
import { describe, expect, it } from 'vitest';
import { SeriesFields } from './series-fields';

const people = [{ userId: 'u1', name: 'Synthetic One' }];
const render = (p: Partial<Parameters<typeof SeriesFields>[0]>) =>
  renderToStaticMarkup(
    createElement(SeriesFields, { idPrefix: 'rs', people, meeting: 'maybe', ...p }),
  );

describe('SeriesFields', () => {
  it('labels every control; the create form says meeting fields are for meetings only', () => {
    const html = render({});
    for (const id of ['rs-title', 'rs-priority', 'rs-frequency', 'rs-weekday', 'rs-time', 'rs-end'])
      expect(html).toMatch(new RegExp(`<label[^>]*for="${id}"`));
    expect(html).toContain('Meeting details (meetings only)');
    expect(html).toMatch(/name="localTime"[^>]*type="time"|type="time"[^>]*name="localTime"/);
    expect(html).not.toMatch(/id="rs-duration"[^>]*required/);
  });

  it('has no meeting fields for another type, and pre-fills an edit', () => {
    expect(render({ meeting: false })).not.toContain('durationMinutes');
    const html = render({
      idPrefix: 'se',
      meeting: true,
      defaults: {
        title: 'Synthetic weekly',
        priority: 'HIGH',
        rule: { frequency: 'WEEKLY', weekday: 4, localTime: '17:30', endDate: '2026-12-31' },
        durationMinutes: 45,
        location: 'Room 7',
        attendeeUserIds: ['u1'],
      },
    });
    expect(html).toContain('value="Synthetic weekly"');
    expect(html).toContain('value="17:30"');
    expect(html).toContain('value="2026-12-31"');
    expect(html).toContain('value="45"');
    expect(html).toMatch(/id="se-duration"[^>]*required/);
    expect(new RegExp('<input[^>]*value="u1"[^>]*>').exec(html)![0]).toContain('checked');
  });
});
