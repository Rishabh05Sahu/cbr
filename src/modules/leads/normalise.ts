// Leads module: normalisation of lead fields typed by users or read from import files
// (FR-042, FR-043). Pure functions with no database access, shared by manual create, duplicate
// matching and import validation. Every rejection carries a machine code and a human message so
// an import can report it per row (FR-042).

/** Outcome of normalising one field. A blank input is not an error here: `value` is null and the
 * caller decides whether the field is required. */
export type Normalised<T, C extends string> =
  { ok: true; value: T | null } | { ok: false; code: C; message: string };

const fail = <C extends string>(code: C, message: string) =>
  ({ ok: false, code, message }) as const;

const isBlank = (raw: string | null | undefined): raw is null | undefined | '' =>
  raw == null || raw.trim() === '';

// ---------------------------------------------------------------------------------------------
// Phone (FR-043; UAE + India, owner decision 2026-11-16): E.164; the raw value is kept alongside.

export type PhoneErrorCode =
  | 'PHONE_TOO_LONG'
  | 'PHONE_INVALID_CHARACTERS'
  | 'PHONE_COUNTRY_NOT_SUPPORTED'
  | 'PHONE_INVALID_LENGTH'
  | 'PHONE_NOT_MOBILE';

export interface NormalisedPhone {
  e164: string;
  raw: string;
}

const PHONE_MAX_RAW = 32;
/** UAE national numbers: mobiles 5X XXX XXXX; fixed lines 2/3/4/6/7/9 + 7 digits. */
const UAE_NATIONAL = /^(?:5\d{8}|[2-46-79]\d{7})$/;
const UAE_LENGTH = 'A UAE number has 9 digits after +971 (8 for a landline)';

function uae(national: string, raw: string): Normalised<NormalisedPhone, PhoneErrorCode> {
  // Mobiles (5…) have 9 digits, fixed lines (area code 2/3/4/6/7/9) have 8.
  const expected = national.startsWith('5') ? 9 : /^[2-46-79]/.test(national) ? 8 : null;
  if (expected === null)
    return fail('PHONE_NOT_MOBILE', 'A UAE number starts with 5 (mobile) or an area code');
  if (national.length !== expected || !UAE_NATIONAL.test(national))
    return fail('PHONE_INVALID_LENGTH', UAE_LENGTH);
  return { ok: true, value: { e164: `+971${national}`, raw } };
}

function india(national: string, raw: string): Normalised<NormalisedPhone, PhoneErrorCode> {
  if (national.length !== 10)
    return fail('PHONE_INVALID_LENGTH', 'An Indian mobile number has 10 digits');
  if (!/^[6-9]/.test(national))
    return fail('PHONE_NOT_MOBILE', 'An Indian mobile number starts with 6, 7, 8 or 9');
  return { ok: true, value: { e164: `+91${national}`, raw } };
}

/**
 * UAE and Indian numbers (owner decision 2026-11-16: customers in Dubai, investors from India).
 * - With a country code (+971 / 00971 / 971…, +91 / 0091 / 91…): that country. A trunk 0 after
 *   the code is dropped ("+971 050…", "+91 098…").
 * - Without one: UAE local forms (050 123 4567, 50 123 4567, 04 123 4567) are UAE; an Indian
 *   mobile (10 digits starting 6–9, or 11 with a trunk 0) is India. The two never overlap: UAE
 *   local numbers start 0 or 5, Indian mobiles 6–9.
 * Spaces, hyphens, dots and parentheses are separators; anything else (letters, extensions, a
 * second "+", Excel scientific notation) is rejected rather than stripped. Other countries and
 * Indian fixed lines are refused: without numbering-plan metadata they cannot be validated, and a
 * wrong number must never become a duplicate-match key.
 */
export function normalisePhone(
  raw: string | null | undefined,
): Normalised<NormalisedPhone, PhoneErrorCode> {
  if (isBlank(raw)) return { ok: true, value: null };
  const trimmed = raw.trim();
  if (trimmed.length > PHONE_MAX_RAW)
    return fail('PHONE_TOO_LONG', `Phone number is longer than ${PHONE_MAX_RAW} characters`);
  if (!/^\+?[\d\s().-]+$/.test(trimmed))
    return fail('PHONE_INVALID_CHARACTERS', 'Phone number may contain only digits and separators');

  const digits = trimmed.replace(/\D/g, '');
  const international = trimmed.startsWith('+') || (digits.startsWith('00') && digits.length > 11);
  if (international) {
    const n = digits.replace(/^00/, '');
    if (n.startsWith('971')) return uae(n.slice(3).replace(/^0/, ''), raw);
    if (n.startsWith('91')) return india(n.slice(2).replace(/^0(?=\d{10}$)/, ''), raw);
    return fail(
      'PHONE_COUNTRY_NOT_SUPPORTED',
      'Only UAE (+971) and Indian (+91) phone numbers are supported',
    );
  }
  // Without a "+": a written country code, then the local forms.
  if (digits.length === 12 && digits.startsWith('971')) return uae(digits.slice(3), raw);
  if (digits.length === 12 && digits.startsWith('91')) return india(digits.slice(2), raw);
  if (/^0[2-9]/.test(digits) && digits.length <= 10) return uae(digits.slice(1), raw);
  if (/^5\d{8}$/.test(digits)) return uae(digits, raw);
  if (digits.length === 11 && digits.startsWith('0')) return india(digits.slice(1), raw);
  if (digits.length === 10 && /^[6-9]/.test(digits)) return india(digits, raw);
  return fail(
    'PHONE_INVALID_LENGTH',
    'Use a UAE number (050 123 4567 or +971…) or an Indian mobile (+91…)',
  );
}

// ---------------------------------------------------------------------------------------------
// Budget (FR-042; AED, owner decision 2026-11-16): "1.5M", "850K", "AED 1,500,000" → AED as a
// numeric(15,2) string. Lakh and crore are no longer accepted.

export type BudgetErrorCode =
  | 'BUDGET_MALFORMED'
  | 'BUDGET_RANGE_NOT_SUPPORTED'
  | 'BUDGET_UNKNOWN_UNIT'
  | 'BUDGET_TOO_PRECISE'
  | 'BUDGET_NOT_POSITIVE'
  | 'BUDGET_TOO_LARGE';

const BUDGET_MAX_RAW = 40;
/** numeric(15,2): 13 integer digits (database-design.md: money is numeric(15,2)). */
const BUDGET_MAX_FILS = 10n ** 15n - 1n;

const UNIT_POWER = new Map<string, number>([
  ['', 0],
  ...['k', 'thousand'].map((u) => [u, 3] as const),
  ...['m', 'mn', 'mil', 'million', 'millions'].map((u) => [u, 6] as const),
]);

// Plain or international (1,234,567) digit grouping.
const NUMBER = /^(\d+|\d{1,3}(?:,\d{3})+)(?:\.(\d+))?$/;
const CURRENCY = /^(?:aed|dhs?\.?|dirhams?)\s*|\s*(?:aed|dhs?\.?|dirhams?)$/g;

/**
 * Parses one budget amount in UAE dirhams. The result is an exact decimal string with two
 * places (e.g. "1500000.00"), suitable for a numeric(15,2) column; the arithmetic is done in
 * integer fils, never in floating point. Ranges ("1-1.5M") are rejected: budget_min and
 * budget_max are separate fields.
 */
export function parseBudget(raw: string | null | undefined): Normalised<string, BudgetErrorCode> {
  if (isBlank(raw)) return { ok: true, value: null };
  let s = raw.trim().toLowerCase();
  if (s.length > BUDGET_MAX_RAW)
    return fail('BUDGET_MALFORMED', `Budget is longer than ${BUDGET_MAX_RAW} characters`);
  if (s.startsWith('-')) return fail('BUDGET_NOT_POSITIVE', 'Budget must be greater than zero');

  s = s.replace(CURRENCY, '').trim();
  if (/\d[a-z.\s]*?(?:-|–|\bto\b)\s*(?:aed\s*)?\d/.test(s))
    return fail('BUDGET_RANGE_NOT_SUPPORTED', 'Enter a single amount, not a range');

  const m = /^([\d.,]+)\s*([a-z]*)\.?$/.exec(s);
  if (!m) return fail('BUDGET_MALFORMED', 'Budget is not a number');
  const number = m[1]!;
  const power = UNIT_POWER.get(m[2]!);
  if (power === undefined)
    return fail('BUDGET_UNKNOWN_UNIT', 'Use AED, K (thousand) or M (million)');
  const parts = NUMBER.exec(number);
  if (!parts) return fail('BUDGET_MALFORMED', 'Budget is not a number');

  const whole = parts[1]!.replace(/,/g, '');
  const fraction = (parts[2] ?? '').replace(/0+$/, '');
  const scale = power + 2 - fraction.length; // fils = digits × 10^scale
  if (scale < 0) return fail('BUDGET_TOO_PRECISE', 'Budget is more precise than one fils');
  const fils = BigInt(whole + fraction) * 10n ** BigInt(scale);

  if (fils === 0n) return fail('BUDGET_NOT_POSITIVE', 'Budget must be greater than zero');
  if (fils > BUDGET_MAX_FILS) return fail('BUDGET_TOO_LARGE', 'Budget is too large');
  return { ok: true, value: `${fils / 100n}.${(fils % 100n).toString().padStart(2, '0')}` };
}
