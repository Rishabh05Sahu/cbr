// The lead's country (UAE or India), read from its phone number's prefix (+971 / +91). Works on a
// masked number too ("+971 •••…"). Nothing is shown for a number without a known country.
import { PHONE_COUNTRIES, phoneCountry } from '@/modules/leads/normalise';

const TONE = {
  AE: 'border-blue-200 bg-blue-50 text-blue-900',
  IN: 'border-amber-200 bg-amber-50 text-amber-900',
} as const;

export function CountryTag({ phone }: { phone: string | null | undefined }) {
  const c = phoneCountry(phone);
  if (!c) return null;
  return (
    <span
      className={`inline-flex shrink-0 items-center rounded border px-1.5 text-[0.6875rem] leading-4 font-semibold tracking-wide ${TONE[c]}`}
      title={`${PHONE_COUNTRIES[c].name} number`}
    >
      {PHONE_COUNTRIES[c].name}
    </span>
  );
}
