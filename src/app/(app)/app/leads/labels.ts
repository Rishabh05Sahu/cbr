// Display labels for lead vocabularies (lead-lifecycle §4). Codes stay in the database.
import { DISPLAY_TIME_ZONE } from '@/lib/display';
export const LABELS: Record<string, string> = {
  BUY: 'Buy',
  RENT: 'Rent',
  LEASE_COMMERCIAL: 'Lease (commercial)',
  SELL: 'Sell (owner)',
  LET_OUT: 'Let out (owner)',
  APARTMENT: 'Apartment',
  VILLA: 'Villa',
  PLOT: 'Plot',
  ROW_HOUSE: 'Row house',
  OFFICE: 'Office',
  SHOP: 'Shop',
  WAREHOUSE: 'Warehouse',
  OTHER: 'Other',
  PHONE: 'Phone',
  WHATSAPP: 'WhatsApp',
  EMAIL: 'Email',
  ANY: 'Any',
  SELF_USE: 'Self use',
  INVESTMENT: 'Investment',
  UNKNOWN: 'Unknown',
  IMMEDIATE: 'Immediate',
  WITHIN_1M: 'Within 1 month',
  '1_3M': '1–3 months',
  '3_6M': '3–6 months',
  '6M_PLUS': '6+ months',
  HOT: 'Hot',
  WARM: 'Warm',
  COLD: 'Cold',
};

export const label = (code: string | null | undefined) => (code ? (LABELS[code] ?? code) : '—');

export const fmtDateTime = (d: Date) =>
  d.toLocaleString('en-IN', {
    day: 'numeric',
    month: 'short',
    year: 'numeric',
    hour: 'numeric',
    minute: '2-digit',
    timeZone: DISPLAY_TIME_ZONE,
  });

/** Budgets in AED (owner decision 2026-11-16). */
export { fmtAed } from '@/lib/display';
