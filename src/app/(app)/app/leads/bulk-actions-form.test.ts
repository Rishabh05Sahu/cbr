// Lead list bulk actions with an empty result list: archiving the last visible leads must not
// unmount the form, or its result ("Archived 2 leads.") is lost with it. The page now keeps the
// form mounted around the empty state; with `empty` it shows the empty state and the feedback
// slot only, never controls for rows that are not there. Rendered to static HTML (no DOM
// environment in this repo), with the server actions mocked.
import { createElement, type ComponentProps } from 'react';
import { renderToStaticMarkup } from 'react-dom/server';
import { describe, expect, it, vi } from 'vitest';

vi.mock('@/modules/leads/actions', () => ({
  bulkAddTagAction: vi.fn(),
  bulkArchiveAction: vi.fn(),
  bulkChangeTeamAction: vi.fn(),
}));
const { BulkActionsForm } = await import('./bulk-actions-form');

const render = (empty: boolean) =>
  renderToStaticMarkup(
    createElement(
      BulkActionsForm,
      {
        max: 100,
        empty,
        archive: true,
        teams: [{ id: 't1', name: 'North Sales' }],
        tags: [{ id: 'g1', name: 'NRI' }],
      } as ComponentProps<typeof BulkActionsForm>,
      createElement('p', null, 'No leads match these filters.'),
    ),
  );

const CONTROLS = [
  '>Archive selected</button>',
  '>Change team</button>',
  '>Add tag</button>',
  'selected · up to',
];

describe('BulkActionsForm', () => {
  it('stays a form around the empty state, without controls, when no rows are left', () => {
    const html = render(true);
    expect(html).toMatch(/^<form/);
    expect(html).toContain('No leads match these filters.');
    for (const control of CONTROLS) expect(html).not.toContain(control);
  });

  it('shows the controls once, after the rows, when there are rows', () => {
    const html = render(false);
    expect(html.indexOf('No leads match these filters.')).toBeLessThan(
      html.indexOf('>Archive selected</button>'),
    );
    for (const control of CONTROLS) expect(html.split(control)).toHaveLength(2);
  });

  it('shows no result before any action has run', () => {
    for (const html of [render(true), render(false)])
      expect(html).not.toMatch(/role="(alert|status)"[^>]*>(Archived|Moved|Tagged|No leads)/);
  });
});
