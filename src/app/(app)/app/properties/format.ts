// Display helpers for properties (FR-140): AED amounts (owner decision 2026-11-16), price with its
// basis.
import type { PropertyView } from '@/modules/properties';
import { fmtAed } from '@/lib/display';

/** "1500000.00" → "AED 1,500,000"; fils shown only when not zero. */
export const aed = (amount: string): string => fmtAed(amount);

export function priceText(p: Pick<PropertyView, 'price' | 'priceType'>): string {
  const base = aed(p.price);
  return p.priceType === 'PER_SQFT'
    ? `${base} per sq ft`
    : p.priceType === 'MONTHLY_RENT'
      ? `${base} per month`
      : base;
}
