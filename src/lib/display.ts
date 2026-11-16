// Display conventions for the UAE (owner decision 2026-11-16: customers are in Dubai).
// Shared by server pages and client components; no server-only imports.

/**
 * The time zone dates and times are shown in. Scheduling inputs use each organisation's own
 * setting (Settings → Organisation), which should also be Asia/Dubai. Showing times in each
 * organisation's zone is a follow-up.
 */
export const DISPLAY_TIME_ZONE = 'Asia/Dubai';

/** "1500000.00" → "AED 1,500,000"; fils shown only when not zero. Null → "—". */
export function fmtAed(v: string | null): string {
  if (v === null) return '—';
  const [whole, fils] = v.split('.');
  const text = Number(whole).toLocaleString('en-AE');
  return fils && Number(fils) !== 0 ? `AED ${text}.${fils.padEnd(2, '0')}` : `AED ${text}`;
}
