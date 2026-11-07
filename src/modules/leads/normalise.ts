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
// Phone (FR-043): E.164 with default region IN; the raw value is kept alongside.

export type PhoneErrorCode =
  | 'PHONE_TOO_LONG'
  | 'PHONE_INVALID_CHARACTERS'
  | 'PHONE_NOT_INDIAN'
  | 'PHONE_INVALID_LENGTH'
  | 'PHONE_NOT_MOBILE';

export interface NormalisedPhone {
  e164: string;
  raw: string;
}

const PHONE_MAX_RAW = 32;

/**
 * Indian mobile numbers only: 10 digits starting 6–9, optionally written with the trunk 0, the
 * country code (91, +91, 0091), or both ("+91 0…"). Spaces, hyphens, dots and parentheses are
 * accepted as separators; anything else (letters, extensions, a second "+", Excel scientific
 * notation) is rejected rather than stripped. Other countries and Indian fixed lines are refused:
 * without numbering-plan metadata they cannot be validated (e.g. Bengaluru's 080 overlaps mobile
 * series), and a wrong number must never become a duplicate-match key.
 */
export function normaliseIndianPhone(
  raw: string | null | undefined,
): Normalised<NormalisedPhone, PhoneErrorCode> {
  if (isBlank(raw)) return { ok: true, value: null };
  const trimmed = raw.trim();
  if (trimmed.length > PHONE_MAX_RAW)
    return fail('PHONE_TOO_LONG', `Phone number is longer than ${PHONE_MAX_RAW} characters`);
  if (!/^\+?[\d\s().-]+$/.test(trimmed))
    return fail('PHONE_INVALID_CHARACTERS', 'Phone number may contain only digits and separators');

  let digits = trimmed.replace(/\D/g, '');
  if (trimmed.startsWith('+') || (digits.startsWith('00') && digits.length > 11)) {
    digits = digits.replace(/^00/, '');
    if (!digits.startsWith('91'))
      return fail('PHONE_NOT_INDIAN', 'Only Indian (+91) phone numbers are supported');
    digits = digits.slice(2).replace(/^0(?=\d{10}$)/, '');
  } else if (digits.length === 11 && digits.startsWith('0')) {
    digits = digits.slice(1);
  } else if (digits.length === 12 && digits.startsWith('91')) {
    digits = digits.slice(2);
  }

  if (digits.length !== 10)
    return fail('PHONE_INVALID_LENGTH', 'An Indian mobile number has 10 digits');
  if (!/^[6-9]/.test(digits))
    return fail('PHONE_NOT_MOBILE', 'An Indian mobile number starts with 6, 7, 8 or 9');
  return { ok: true, value: { e164: `+91${digits}`, raw } };
}

// ---------------------------------------------------------------------------------------------
// Budget (FR-042): "1.2 Cr", "85 L", "85,00,000/-", "₹50k" → INR as a numeric(15,2) string.

export type BudgetErrorCode =
  | 'BUDGET_MALFORMED'
  | 'BUDGET_RANGE_NOT_SUPPORTED'
  | 'BUDGET_UNKNOWN_UNIT'
  | 'BUDGET_TOO_PRECISE'
  | 'BUDGET_NOT_POSITIVE'
  | 'BUDGET_TOO_LARGE';

const BUDGET_MAX_RAW = 40;
/** numeric(15,2): 13 integer digits (database-design.md: money is numeric(15,2) INR). */
const BUDGET_MAX_PAISE = 10n ** 15n - 1n;

const UNIT_POWER = new Map<string, number>([
  ['', 0],
  ...['k', 'thousand'].map((u) => [u, 3] as const),
  ...['l', 'lac', 'lacs', 'lakh', 'lakhs'].map((u) => [u, 5] as const),
  ...['cr', 'crs', 'crore', 'crores'].map((u) => [u, 7] as const),
]);

// Plain, Indian (12,34,567) or international (1,234,567) digit grouping.
const NUMBER = /^(\d+|\d{1,2}(?:,\d{2})*,\d{3}|\d{1,3}(?:,\d{3})+)(?:\.(\d+))?$/;

/**
 * Parses one budget amount in rupees. The result is an exact decimal string with two places
 * (e.g. "12000000.00"), suitable for a numeric(15,2) column; the arithmetic is done in integer
 * paise, never in floating point. Ranges ("50-75 L") are rejected: budget_min and budget_max are
 * separate fields.
 */
export function parseBudgetInr(
  raw: string | null | undefined,
): Normalised<string, BudgetErrorCode> {
  if (isBlank(raw)) return { ok: true, value: null };
  let s = raw.trim().toLowerCase();
  if (s.length > BUDGET_MAX_RAW)
    return fail('BUDGET_MALFORMED', `Budget is longer than ${BUDGET_MAX_RAW} characters`);
  if (s.startsWith('-')) return fail('BUDGET_NOT_POSITIVE', 'Budget must be greater than zero');

  s = s
    .replace(/^(₹|rs\.?|inr)\s*/, '')
    .replace(/\s*\/-$/, '')
    .trim();
  if (/\d[a-z.\s]*?(?:-|–|\bto\b)\s*(?:₹|rs\.?\s*)?\d/.test(s))
    return fail('BUDGET_RANGE_NOT_SUPPORTED', 'Enter a single amount, not a range');

  const m = /^([\d.,]+)\s*([a-z]*)\.?$/.exec(s);
  if (!m) return fail('BUDGET_MALFORMED', 'Budget is not a number');
  const number = m[1]!;
  const unit = m[2]!;
  const power = UNIT_POWER.get(unit);
  if (power === undefined)
    return fail('BUDGET_UNKNOWN_UNIT', 'Use rupees, K (thousand), L (lakh) or Cr (crore)');
  const parts = NUMBER.exec(number);
  if (!parts) return fail('BUDGET_MALFORMED', 'Budget is not a number');

  const whole = parts[1]!.replace(/,/g, '');
  const fraction = (parts[2] ?? '').replace(/0+$/, '');
  const scale = power + 2 - fraction.length; // paise = digits × 10^scale
  if (scale < 0) return fail('BUDGET_TOO_PRECISE', 'Budget is more precise than one paisa');
  const paise = BigInt(whole + fraction) * 10n ** BigInt(scale);

  if (paise === 0n) return fail('BUDGET_NOT_POSITIVE', 'Budget must be greater than zero');
  if (paise > BUDGET_MAX_PAISE) return fail('BUDGET_TOO_LARGE', 'Budget is too large');
  return { ok: true, value: `${paise / 100n}.${(paise % 100n).toString().padStart(2, '0')}` };
}
