// Script editor page parts (slice 5 browser findings). 1: the draft fields and the live preview
// are shown together, so their ids must not repeat (they did: "sec-closing" was both a textarea
// and a preview heading). 2: publishing removed the publish form, and its "Published." result
// with it, while the draft form kept showing "Draft saved.". Rendered to static HTML (no DOM
// environment in this repo), with the server actions mocked. Both forms now stay mounted (so a
// refused form keeps its message and input); which success message may show follows the draft.
import { createElement, Fragment } from 'react';
import { renderToStaticMarkup } from 'react-dom/server';
import { describe, expect, it, vi } from 'vitest';
import type { ScriptContent } from '@/modules/scripts';

vi.mock('next/navigation', () => ({ useRouter: () => ({ refresh: vi.fn() }) }));
vi.mock('@/modules/scripts/actions', () => ({ publishScriptAction: vi.fn() }));
const { DraftFields, PublishForm, showFeedback } = await import('./editor-parts');
const { ScriptContentView } = await import('../../../scripts/script-content');

const sec = (text: string) => ({ text, html: `<p>${text}</p>` });
const content: ScriptContent = {
  opening: sec('Namaste'),
  questions: sec('Budget?'),
  pitch: sec('Ready to move'),
  closing: sec('Site visit?'),
  objections: [{ objection: 'Too expensive', response: sec('Options from 50 L') }],
};

const editorPage = (draftVersionNo: number | null) =>
  renderToStaticMarkup(
    createElement(
      Fragment,
      null,
      createElement(DraftFields, { editing: content }),
      createElement(ScriptContentView, { content }),
      createElement(PublishForm, { scriptId: 's1', draftVersionNo, draftVersion: 3 }),
    ),
  );
const all = (html: string, re: RegExp) => [...html.matchAll(re)].map((m) => m[1]!);

describe('script editor ids', () => {
  const html = editorPage(2);
  const ids = all(html, /\sid="([^"]+)"/g);

  it('never repeats an id when the draft fields and the live preview are shown together', () => {
    expect(ids.length).toBeGreaterThan(10);
    expect(new Set(ids).size).toBe(ids.length);
  });

  it('points every label at its own form control', () => {
    const fors = all(html, /<label[^>]*\sfor="([^"]+)"/g);
    expect(fors).toHaveLength(4 + 3 * 2); // four sections, three objection rows (1 + 2 blank)
    for (const f of fors) expect(html).toMatch(new RegExp(`<(textarea|input)[^>]*\\sid="${f}"`));
  });

  it('shows the five preview sections, each labelled by its heading', () => {
    const headings = [
      ['opening', 'Opening'],
      ['questions', 'Qualification questions'],
      ['pitch', 'Pitch points'],
      ['objections', 'Objection handling'],
      ['closing', 'Closing / next step'],
    ];
    for (const [key, text] of headings) {
      expect(html).toContain(`aria-labelledby="view-${key}"`);
      expect(html).toMatch(new RegExp(`<h3 id="view-${key}"[^>]*>${text}</h3>`));
    }
  });
});

describe('publish feedback', () => {
  it('offers the publish button only while a draft exists, and no result before an action', () => {
    const withDraft = editorPage(2);
    expect(withDraft).toContain('>Publish version 2</button>');
    expect(withDraft).toContain('name="draftVersion" value="3"');
    expect(withDraft).not.toContain('No unpublished changes');
    const noDraft = editorPage(null);
    expect(noDraft).not.toContain('Publish version');
    expect(noDraft).toContain('No unpublished changes');
    for (const html of [withDraft, noDraft]) expect(html).not.toContain('Published.');
  });

  it('keeps the publish form (a form) mounted once the draft is gone', () => {
    const publish = (n: number | null) =>
      renderToStaticMarkup(
        createElement(PublishForm, { scriptId: 's1', draftVersionNo: n, draftVersion: 1 }),
      );
    expect(publish(1)).toMatch(/^<form/);
    expect(publish(null)).toMatch(/^<form[^>]*><p[^>]*>No unpublished changes[^<]*<\/p><\/form>/);
  });

  it('shows "Draft saved." only with a draft and "Published." only without one', () => {
    // After each action the page shows: save → a draft; publish → no draft; save again → draft.
    const afterAction = [
      ['save', 1],
      ['publish', null],
      ['save', 2],
      ['publish', null],
    ] as const;
    for (const [action, draftVersionNo] of afterAction) {
      expect(showFeedback.draftSaved(draftVersionNo)).toBe(action === 'save');
      expect(showFeedback.published(draftVersionNo)).toBe(action === 'publish');
    }
  });
});
