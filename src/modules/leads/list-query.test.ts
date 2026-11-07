import { describe, expect, it } from 'vitest';
import {
  decodeLeadCursor,
  encodeLeadCursor,
  hasFilters,
  leadQueryString,
  parseLeadQuery,
  phoneDigits,
} from './list-query';

const ID = '01a16721-156b-7747-aabf-88453a187a49';
const ID2 = '01a16721-156b-7747-aabf-88453a187a4a';

describe('parseLeadQuery (FR-056)', () => {
  it('archive view (M5): active by default; archived or all on request; unknown refused', () => {
    expect(parseLeadQuery({}).query.archived).toBe('active');
    expect(parseLeadQuery({ archived: 'archived' }).query.archived).toBe('archived');
    expect(parseLeadQuery({ archived: 'all' }).query.archived).toBe('all');
    expect(parseLeadQuery({ archived: 'deleted' }).errors.archived).toBe('Unknown archive view');
    const q = parseLeadQuery({ archived: 'archived' }).query;
    expect(leadQueryString(q)).toBe('?archived=archived');
    expect(hasFilters(q)).toBe(true);
  });

  it('no parameters: newest first, no filters, no errors', () => {
    const { query, errors } = parseLeadQuery({});
    expect(errors).toEqual({});
    expect(query).toMatchObject({ q: null, stages: [], sort: 'newest', cursor: null });
    expect(hasFilters(query)).toBe(false);
  });

  it('normalises every documented filter', () => {
    const { query, errors } = parseLeadQuery({
      q: '  Asha   Rao ',
      stage: ['QUALIFIED', 'CONTACTED', 'QUALIFIED'],
      intent: 'HOT',
      propertyType: ['VILLA'],
      owner: ID.toUpperCase(),
      team: ID2,
      source: ID,
      city: ' Pune ',
      createdFrom: '2026-10-01',
      createdTo: '2026-10-31',
      assignedFrom: '2026-10-05',
      assignedTo: '2026-10-06',
      budgetFrom: '50 L',
      budgetTo: '1.2 Cr',
      due: 'next7',
      sort: 'name',
      unknownParam: 'ignored',
    });
    expect(errors).toEqual({});
    expect(query).toEqual({
      q: 'Asha Rao',
      stages: ['QUALIFIED', 'CONTACTED'],
      intents: ['HOT'],
      propertyTypes: ['VILLA'],
      owner: ID,
      teamId: ID2,
      sourceId: ID,
      city: 'Pune',
      createdFrom: '2026-10-01',
      createdTo: '2026-10-31',
      assignedFrom: '2026-10-05',
      assignedTo: '2026-10-06',
      budgetFrom: '5000000.00',
      budgetTo: '12000000.00',
      followUpDue: 'next7',
      archived: 'active',
      sort: 'name',
      cursor: null,
    });
    expect(parseLeadQuery({ owner: 'none' }).query.owner).toBe('none');
  });

  it.each([
    [{ q: 'a' }, 'q'],
    [{ q: 'x'.repeat(101) }, 'q'],
    [{ stage: 'DELETED' }, 'stage'],
    [{ stage: ['NEW', "NEW' OR 1=1"] }, 'stage'],
    [{ intent: 'hot' }, 'intent'],
    [{ propertyType: 'CASTLE' }, 'propertyType'],
    [{ owner: 'me' }, 'owner'],
    [{ team: '1; DROP TABLE lead' }, 'team'],
    [{ source: '../../etc' }, 'source'],
    [{ city: 'x'.repeat(101) }, 'city'],
    [{ createdFrom: '2026-02-30' }, 'createdFrom'],
    [{ createdTo: '31/10/2026' }, 'createdTo'],
    [{ createdFrom: '2026-10-31', createdTo: '2026-10-01' }, 'createdTo'],
    [{ assignedFrom: '2026-02-29' }, 'assignedFrom'],
    [{ assignedFrom: '2026-10-09', assignedTo: '2026-10-08' }, 'assignedTo'],
    [{ budgetFrom: 'lots' }, 'budgetFrom'],
    [{ budgetTo: '50-75 L' }, 'budgetTo'],
    [{ budgetFrom: '2 Cr', budgetTo: '1 Cr' }, 'budgetTo'],
    [{ sort: 'created_at; DROP' }, 'sort'],
    [{ sort: 'toString' }, 'sort'],
    [{ cursor: 'garbage!' }, 'cursor'],
  ])('%j -> error on %s', (sp, key) => {
    const { errors } = parseLeadQuery(sp);
    expect(Object.keys(errors)).toContain(key);
  });

  it('a cursor for another sort order is rejected and dropped', () => {
    const c = encodeLeadCursor('newest', { id: ID, fullName: 'A' });
    const { query, errors } = parseLeadQuery({ sort: 'name', cursor: c });
    expect(errors.cursor).toMatch(/no longer valid/);
    expect(query.cursor).toBeNull();
  });
});

describe('lead cursors', () => {
  it('round-trips per sort, carrying the name only for name order', () => {
    expect(
      decodeLeadCursor(encodeLeadCursor('newest', { id: ID, fullName: 'Asha' }), 'newest'),
    ).toEqual({ s: 'newest', id: ID });
    expect(
      decodeLeadCursor(encodeLeadCursor('name', { id: ID, fullName: 'Asha' }), 'name'),
    ).toEqual({
      s: 'name',
      id: ID,
      k: 'Asha',
    });
  });

  it.each([
    '',
    'not base64 !',
    Buffer.from('not json').toString('base64url'),
    Buffer.from('null').toString('base64url'),
    Buffer.from(JSON.stringify({ s: 'newest', id: 'not-a-uuid' })).toString('base64url'),
    Buffer.from(JSON.stringify({ s: 'name', id: ID })).toString('base64url'),
    Buffer.from(JSON.stringify({ s: 'name', id: ID, k: 'x'.repeat(201) })).toString('base64url'),
    Buffer.from(JSON.stringify({ s: 'newest', id: ID, pad: 'x'.repeat(600) })).toString(
      'base64url',
    ),
  ])('rejects %j', (raw) => {
    expect(decodeLeadCursor(raw, 'newest')).toBeNull();
    expect(decodeLeadCursor(raw, 'name')).toBeNull();
  });
});

describe('phoneDigits and query strings', () => {
  it.each([
    ['98765', '98765'],
    ['+91 98765-43210', '919876543210'],
    ['987', null],
    ['Asha 98765', null],
    ['1'.repeat(16), null],
  ])('%j -> %j', (q, d) => {
    expect(phoneDigits(q)).toBe(d);
  });

  it('serialises a query back to the URL, omitting defaults, with the cursor last', () => {
    const { query } = parseLeadQuery({ q: 'Asha', stage: ['NEW', 'LOST'], sort: 'oldest' });
    expect(leadQueryString(query)).toBe('?q=Asha&stage=NEW&stage=LOST&sort=oldest');
    expect(leadQueryString(query, 'abc')).toBe(
      '?q=Asha&stage=NEW&stage=LOST&sort=oldest&cursor=abc',
    );
    expect(leadQueryString(parseLeadQuery({}).query)).toBe('');
    // What it writes, it reads back unchanged.
    expect(
      parseLeadQuery(Object.fromEntries(new URLSearchParams('q=Asha&sort=oldest'))).query,
    ).toEqual({ ...parseLeadQuery({}).query, q: 'Asha', sort: 'oldest' });
  });
});
