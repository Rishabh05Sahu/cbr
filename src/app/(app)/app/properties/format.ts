// Display helpers for properties (FR-140): rupee amounts in Indian grouping, price with its basis.
import type { PropertyView } from '@/modules/properties';

/** "8500000.00" → "₹85,00,000"; paise shown only when not zero. */
export function rupees(amount: string): string {
  const [whole, paise] = amount.split('.');
  const n = Number(whole);
  const text = n.toLocaleString('en-IN');
  return paise && Number(paise) !== 0 ? `₹${text}.${paise.padEnd(2, '0')}` : `₹${text}`;
}

export function priceText(p: Pick<PropertyView, 'price' | 'priceType'>): string {
  const base = rupees(p.price);
  return p.priceType === 'PER_SQFT'
    ? `${base} per sq ft`
    : p.priceType === 'MONTHLY_RENT'
      ? `${base} per month`
      : base;
}
