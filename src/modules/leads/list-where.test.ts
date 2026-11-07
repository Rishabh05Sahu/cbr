// M6 P-C: search text that is a complete phone number takes the exact path; anything else keeps
// the substring search over name, e-mail and both phones.
import { describe, expect, it } from 'vitest';
import { parseLeadQuery } from './list-query';
import { filterWhere } from './list-where';

/** The search condition only (the default archive view adds `archivedAt: null` first). */
const where = (q: string) =>
  filterWhere(parseLeadQuery({ q, archived: 'all' }).query, 'Asia/Kolkata');
const exact = (e164: string) => [
  {
    OR: [{ phoneLast10: e164.slice(-10), primaryPhoneE164: e164 }, { alternatePhoneE164: e164 }],
  },
];

describe('filterWhere search (FR-056, M6 P-C)', () => {
  it.each(['9812345678', '+91 98123 45678', '098123 45678', '91-98123-45678', '0091 9812345678'])(
    'complete number %s: exact match on either phone, nothing else',
    (q) => {
      expect(where(q)).toEqual(exact('+919812345678'));
    },
  );

  it('partial numbers keep the substring search on name, e-mail and both phones', () => {
    expect(where('123456')).toEqual([
      {
        OR: [
          { fullName: { contains: '123456', mode: 'insensitive' } },
          { email: { contains: '123456', mode: 'insensitive' } },
          { primaryPhoneE164: { contains: '123456' } },
          { alternatePhoneE164: { contains: '123456' } },
        ],
      },
    ]);
  });

  it('ten digits that are not a valid mobile (starts 1–5) stay a substring search', () => {
    const [w] = where('1234567890') as [{ OR: unknown[] }];
    expect(w.OR).toHaveLength(4);
    expect(w.OR).toContainEqual({ primaryPhoneE164: { contains: '1234567890' } });
  });

  it('text that is not a phone searches name and e-mail only, with LIKE characters escaped', () => {
    expect(where('50%_off')).toEqual([
      {
        OR: [
          { fullName: { contains: '50\\%\\_off', mode: 'insensitive' } },
          { email: { contains: '50\\%\\_off', mode: 'insensitive' } },
        ],
      },
    ]);
  });
});
