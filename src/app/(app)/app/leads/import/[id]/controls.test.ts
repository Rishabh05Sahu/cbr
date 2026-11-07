// Import mapping on a phone: the column dropdowns sit in an auto-sized table next to long field
// hints, and a w-full select adds no minimum width to its column, so at 390 px they were squeezed
// to ~50 px ("Nar", "No"). Each keeps a readable minimum width, and the table scrolls inside its
// own box rather than the page. Rendered to static HTML (no DOM environment in this repo).
import { createElement } from 'react';
import { renderToStaticMarkup } from 'react-dom/server';
import { describe, expect, it, vi } from 'vitest';
import { IMPORT_FIELDS } from '@/modules/imports/mapping';

vi.mock('next/navigation', () => ({ useRouter: () => ({ refresh: vi.fn() }) }));
vi.mock('@/modules/imports/actions', () => ({
  cancelImportAction: vi.fn(),
  chooseSheetAction: vi.fn(),
  confirmImportAction: vi.fn(),
  resumeImportAction: vi.fn(),
  submitMappingAction: vi.fn(),
}));
const { MappingForm } = await import('./controls');

const html = renderToStaticMarkup(
  createElement(MappingForm, {
    importId: 'imp-1',
    version: 1,
    headers: ['Name', 'Phone', 'Email'],
    fields: IMPORT_FIELDS.map((f) => ({ ...f, field: f.field as string })),
    mapping: { fullName: 0, primaryPhone: 1 },
    sources: [],
    defaultSourceId: null,
    duplicatePolicy: 'ATTACH',
    assignment: { mode: 'none' },
    dryRun: false,
    people: [],
    teams: [],
    orgQueue: false,
  }),
);

describe('MappingForm column dropdowns', () => {
  it('give every mapping select a readable minimum width', () => {
    const selects = html.match(/<select[^>]*id="map-[^"]+"[^>]*>/g) ?? [];
    expect(selects).toHaveLength(IMPORT_FIELDS.length);
    for (const s of selects) expect(s).toMatch(/class="[^"]*\bmin-w-40\b/);
  });

  it('keep the mapping table inside its own horizontal scroll area', () => {
    expect(html).toMatch(/<div class="overflow-x-auto"><table/);
  });
});
