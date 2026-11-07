// FR-140 property rules (ADR-0021), free of the database so they can be unit tested. The same
// rules are CHECK constraints in migration 0025.

export const LISTING_TYPES = ['SALE', 'RENT', 'LEASE'] as const;
export type ListingType = (typeof LISTING_TYPES)[number];
/** Same codes as a lead's property type, so matching (FR-143) can compare them directly. */
export const PROPERTY_KINDS = [
  'APARTMENT',
  'VILLA',
  'PLOT',
  'ROW_HOUSE',
  'OFFICE',
  'SHOP',
  'WAREHOUSE',
  'OTHER',
] as const;
export const PRICE_TYPES = ['TOTAL', 'PER_SQFT', 'MONTHLY_RENT'] as const;
export type PriceType = (typeof PRICE_TYPES)[number];
export const PROPERTY_STATUSES = [
  'DRAFT',
  'AVAILABLE',
  'ON_HOLD',
  'SOLD',
  'RENTED',
  'WITHDRAWN',
] as const;
export type PropertyStatus = (typeof PROPERTY_STATUSES)[number];
export const FACINGS = ['N', 'NE', 'E', 'SE', 'S', 'SW', 'W', 'NW'] as const;
export const FURNISHINGS = ['UNFURNISHED', 'SEMI_FURNISHED', 'FURNISHED'] as const;
export const CONTACT_RELATIONSHIPS = ['OWNER', 'AUTHORISED_AGENT', 'DEVELOPER'] as const;
export const MAX_AMENITIES = 30;

export const PROPERTY_LABELS: Record<string, string> = {
  SALE: 'Sale',
  RENT: 'Rent',
  LEASE: 'Lease',
  TOTAL: 'Total price',
  PER_SQFT: 'Per sq ft',
  MONTHLY_RENT: 'Per month',
  DRAFT: 'Draft',
  AVAILABLE: 'Available',
  ON_HOLD: 'On hold',
  SOLD: 'Sold',
  RENTED: 'Rented',
  WITHDRAWN: 'Withdrawn',
  UNFURNISHED: 'Unfurnished',
  SEMI_FURNISHED: 'Semi-furnished',
  FURNISHED: 'Furnished',
  OWNER: 'Owner',
  AUTHORISED_AGENT: 'Authorised agent',
  DEVELOPER: 'Developer',
};

/** Price types allowed for a listing type: a sale is a total or per sq ft; rent/lease monthly. */
export const priceTypesFor = (l: ListingType): readonly PriceType[] =>
  l === 'SALE' ? ['TOTAL', 'PER_SQFT'] : ['MONTHLY_RENT'];

/** Statuses allowed for a listing type: Sold for sales, Rented for rent and lease. */
export const statusesFor = (l: ListingType): readonly PropertyStatus[] =>
  PROPERTY_STATUSES.filter((s) =>
    s === 'SOLD' ? l === 'SALE' : s === 'RENTED' ? l !== 'SALE' : true,
  );

/** Cross-field problems of a listing, keyed by field (empty when consistent). */
export function listingProblems(p: {
  listingType: ListingType;
  priceType: PriceType;
  status: PropertyStatus;
  deposit: string | null;
}): Record<string, string[]> {
  const out: Record<string, string[]> = {};
  if (!priceTypesFor(p.listingType).includes(p.priceType))
    out.priceType = [
      p.listingType === 'SALE'
        ? 'A sale price is a total or per sq ft'
        : 'A rent or lease price is per month',
    ];
  if (!statusesFor(p.listingType).includes(p.status))
    out.status = [
      p.status === 'SOLD' ? 'Only a sale can be sold' : 'Only a rental or lease can be rented',
    ];
  if (p.deposit !== null && p.listingType === 'SALE')
    out.deposit = ['A deposit applies to rentals and leases only'];
  return out;
}

/**
 * An amount in rupees as a decimal string with at most 2 decimals and 13 integer digits
 * (numeric(15,2)); commas and spaces are ignored ("85,00,000"). Null for blank, undefined for bad.
 */
export function parseAmount(raw: string | undefined, max = 13): string | null | undefined {
  const s = (raw ?? '').replace(/[,\s]/g, '');
  if (!s) return null;
  const m = new RegExp(`^(\\d{1,${max}})(?:\\.(\\d{1,2}))?$`).exec(s);
  if (!m) return undefined;
  return m[2] ? `${m[1]}.${m[2]}` : m[1]!;
}

/** Amenities from a comma- or newline-separated list: trimmed, distinct (case-insensitive). */
export function parseAmenities(raw: string | undefined): string[] {
  const seen = new Set<string>();
  const out: string[] = [];
  for (const part of (raw ?? '').split(/[,\n]/)) {
    const a = part.replace(/\s+/g, ' ').trim();
    if (a && !seen.has(a.toLowerCase())) {
      seen.add(a.toLowerCase());
      out.push(a);
    }
  }
  return out;
}

/**
 * The next org property code after the highest existing number (41 → "P-00042"). The number is
 * read numerically, so codes past P-99999 keep counting ("P-100000").
 */
export function nextPropertyCode(highest: number | null): string {
  return `P-${String((highest ?? 0) + 1).padStart(5, '0')}`;
}
