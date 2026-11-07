// FR-041 mapping templates, pure part: a template stores headings (never positions or values) and
// applying it maps only headings that match exactly once; everything else is reported.
import { describe, expect, it } from 'vitest';
import { validateMapping } from './mapping';
import { applyTemplate, templateFromMapping } from './templates';

const SAVED_HEADERS = ['Customer Name', 'Mobile No.', 'E-mail', 'Lead Source', 'Remarks'];

describe('templateFromMapping', () => {
  it('stores field -> heading text, never the column positions', () => {
    expect(
      templateFromMapping(SAVED_HEADERS, { fullName: 0, primaryPhone: 1, email: 2, source: 3 }),
    ).toEqual({
      fullName: 'Customer Name',
      primaryPhone: 'Mobile No.',
      email: 'E-mail',
      source: 'Lead Source',
    });
  });

  it('skips blank headings and anything that is not a column index', () => {
    expect(
      templateFromMapping(['Name', '  ', 'Phone'], {
        fullName: 0,
        email: 1,
        primaryPhone: 2,
        notes: '3',
        city: 99,
      }),
    ).toEqual({ fullName: 'Name', primaryPhone: 'Phone' });
  });
});

describe('applyTemplate', () => {
  const template = templateFromMapping(SAVED_HEADERS, {
    fullName: 0,
    primaryPhone: 1,
    email: 2,
    source: 3,
  });

  it('maps a compatible file by heading even when columns are reordered or restyled', () => {
    const headers = ['LEAD SOURCE', 'mobile no', 'Remarks', 'customer name', 'E mail', 'Extra'];
    const r = applyTemplate(template, headers);
    expect(r.warnings).toEqual([]);
    expect(r.mapping).toEqual({ source: 0, primaryPhone: 1, fullName: 3, email: 4 });
    expect(validateMapping(r.mapping, headers.length)).toMatchObject({ ok: true });
  });

  it('leaves a missing heading unmapped and says which required field still needs a column', () => {
    const r = applyTemplate(template, ['Customer Name', 'Phone Number', 'E-mail']);
    expect(r.mapping).toEqual({ fullName: 0, email: 2 });
    expect(r.warnings).toEqual(
      expect.arrayContaining([
        { code: 'HEADER_MISSING', field: 'primaryPhone', header: 'Mobile No.' },
        { code: 'HEADER_MISSING', field: 'source', header: 'Lead Source' },
        { code: 'REQUIRED_UNMAPPED', field: 'primaryPhone' },
      ]),
    );
    // Submitting this as it is fails validation: nothing was guessed.
    expect(validateMapping(r.mapping, 3)).toMatchObject({ ok: false });
  });

  it('never picks one of several columns with the same heading', () => {
    const r = applyTemplate(template, ['Customer Name', 'Mobile No', 'Mobile No.', 'E-mail']);
    expect(r.mapping.primaryPhone).toBeUndefined();
    expect(r.warnings).toEqual(
      expect.arrayContaining([
        { code: 'HEADER_AMBIGUOUS', field: 'primaryPhone', header: 'Mobile No.' },
        { code: 'REQUIRED_UNMAPPED', field: 'primaryPhone' },
      ]),
    );
  });

  it('drops fields that no longer exist (unknown or archived custom fields) with a warning', () => {
    const stale = { ...template, 'custom:visit_slot': 'Visit Slot', bogus: 'Remarks' };
    const headers = [...SAVED_HEADERS, 'Visit Slot'];
    const r = applyTemplate(stale, headers, []);
    expect(r.mapping['custom:visit_slot']).toBeUndefined();
    expect(r.warnings).toEqual(
      expect.arrayContaining([
        { code: 'FIELD_UNKNOWN', field: 'custom:visit_slot', header: 'Visit Slot' },
        { code: 'FIELD_UNKNOWN', field: 'bogus', header: 'Remarks' },
      ]),
    );
    // With the custom field active it maps; a required custom field without a column is reported.
    const active = applyTemplate(stale, headers, [
      { key: 'visit_slot', label: 'Visit slot', required: false },
      { key: 'budget_band', label: 'Budget band', required: true },
    ]);
    expect(active.mapping['custom:visit_slot']).toBe(5);
    expect(active.warnings).toContainEqual({
      code: 'REQUIRED_UNMAPPED',
      field: 'custom:budget_band',
    });
  });

  it('does not map one column to two fields', () => {
    const r = applyTemplate({ fullName: 'Name', email: 'name' }, ['Name', 'Phone']);
    expect(r.mapping).toEqual({ fullName: 0 });
    expect(r.warnings).toContainEqual({
      code: 'HEADER_ALREADY_USED',
      field: 'email',
      header: 'name',
    });
  });
});
