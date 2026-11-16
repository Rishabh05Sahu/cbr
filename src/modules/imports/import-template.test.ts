// The import template (owner request 2026-11-16): a file made from it maps itself, so the person
// only confirms. Every standard field and every active custom field is suggested from its heading.
import { describe, expect, it } from 'vitest';
import { IMPORT_FIELDS, suggestMapping, TEMPLATE_HEADINGS, templateHeaders } from './mapping';

describe('import template', () => {
  it('has one heading per standard field, in catalogue order, all different', () => {
    const h = templateHeaders();
    expect(h).toHaveLength(IMPORT_FIELDS.length);
    expect(h).toEqual(IMPORT_FIELDS.map((f) => TEMPLATE_HEADINGS[f.field]));
    expect(new Set(h).size).toBe(h.length);
  });

  it('maps every standard field to its own column, with nothing left to choose', () => {
    const mapping = suggestMapping(templateHeaders());
    IMPORT_FIELDS.forEach((f, column) => expect(mapping[f.field], f.field).toBe(column));
  });

  it('adds active custom fields after the standard ones, and maps them too', () => {
    const custom = [
      { key: 'unit_no', label: 'Unit number', required: false },
      { key: 'nationality', label: 'Nationality', required: true },
    ];
    const h = templateHeaders(custom);
    expect(h.slice(-2)).toEqual(['Unit number', 'Nationality']);
    const mapping = suggestMapping(h, custom);
    expect(mapping['custom:unit_no']).toBe(IMPORT_FIELDS.length);
    expect(mapping['custom:nationality']).toBe(IMPORT_FIELDS.length + 1);
  });
});
