// SYNTHETIC data primitives shared by the M6 load-test seeder (scripts/perf) and the import
// corpus (tests/support/import-corpus.ts). Deterministic: the same seed and index always give
// the same value, so a run can be reproduced exactly. Every value is fabricated: names are
// "Synthetic <First> <Last> <n>", e-mails use the reserved example.test domain, and phones come
// from made-up number blocks used only for local tests (never contacted). Nothing here is, or is
// derived from, customer or brokerage data.

/** Small, fast, seedable PRNG (mulberry32). */
export function prng(seed: number): () => number {
  let a = seed >>> 0;
  return () => {
    a = (a + 0x6d2b79f5) >>> 0;
    let t = a;
    t = Math.imul(t ^ (t >>> 15), t | 1);
    t ^= t + Math.imul(t ^ (t >>> 7), t | 61);
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}

/** A per-index PRNG, so row i is the same no matter how many rows are generated. */
export const rowRandom = (seed: number, i: number) => prng((seed * 2654435761 + i * 40503) >>> 0);

export const pick = <T>(r: () => number, xs: readonly T[]): T => xs[Math.floor(r() * xs.length)]!;

/** Weighted pick: [[value, weight], …]. */
export function weighted<T>(r: () => number, xs: readonly (readonly [T, number])[]): T {
  const total = xs.reduce((s, [, w]) => s + w, 0);
  let x = r() * total;
  for (const [v, w] of xs) if ((x -= w) < 0) return v;
  return xs[xs.length - 1]![0];
}

export const FIRST_NAMES = [
  'Aarav',
  'Vihaan',
  'Aditya',
  'Arjun',
  'Sai',
  'Reyansh',
  'Krishna',
  'Ishaan',
  'Rohan',
  'Kabir',
  'Ananya',
  'Diya',
  'Saanvi',
  'Aadhya',
  'Ira',
  'Meera',
  'Kavya',
  'Riya',
  'Pooja',
  'Neha',
  'Rahul',
  'Amit',
  'Suresh',
  'Ramesh',
  'Priya',
  'Sunita',
  'Vikram',
  'Deepa',
  'Manoj',
  'Lakshmi',
] as const;
export const LAST_NAMES = [
  'Sharma',
  'Verma',
  'Patel',
  'Iyer',
  'Nair',
  'Reddy',
  'Rao',
  'Gupta',
  'Kulkarni',
  'Deshpande',
  'Joshi',
  'Mehta',
  'Shah',
  'Singh',
  'Das',
  'Banerjee',
  'Pillai',
  'Menon',
  'Chopra',
  'Kapoor',
] as const;
export const CITIES: Record<string, readonly string[]> = {
  Pune: ['Baner', 'Wakad', 'Hinjewadi', 'Kharadi', 'Viman Nagar', 'Aundh', 'Hadapsar'],
  Mumbai: ['Andheri', 'Powai', 'Thane', 'Borivali', 'Chembur', 'Malad', 'Goregaon'],
  Bengaluru: ['Whitefield', 'HSR Layout', 'Electronic City', 'Hebbal', 'Sarjapur', 'Yelahanka'],
  Hyderabad: ['Gachibowli', 'Kondapur', 'Madhapur', 'Kukatpally', 'Miyapur'],
  Chennai: ['OMR', 'Velachery', 'Porur', 'Tambaram', 'Anna Nagar'],
  Ahmedabad: ['SG Highway', 'Bopal', 'Satellite', 'Gota'],
};
export const CITY_NAMES = Object.keys(CITIES);

export const syntheticName = (r: () => number, n: number) =>
  `Synthetic ${pick(r, FIRST_NAMES)} ${pick(r, LAST_NAMES)} ${n}`;

/**
 * A fabricated 10-digit Indian mobile number (starts 6–9) in a numbered block, unique for
 * index < 100,000,000. Blocks keep different uses (seed leads, imports, other orgs) apart.
 */
export function syntheticMobile(block: 6 | 7 | 8 | 9, i: number, sub = 0): string {
  if (i < 0 || i >= 10_000_000 || sub < 0 || sub > 9) throw new Error('index out of range');
  return `${block}${sub}${String(i).padStart(8, '0')}`;
}

export const syntheticEmail = (n: number, tag = 'lead') => `synthetic.${tag}.${n}@example.test`;

/** INR budget pair in rupees (min ≤ max), in realistic ranges for the property type. */
export function syntheticBudget(r: () => number): { min: number; max: number } {
  const lakhs = pick(r, [25, 35, 45, 60, 75, 85, 95, 120, 150, 200, 300, 500]);
  const min = lakhs * 100_000;
  return { min, max: Math.round(min * (1.1 + r() * 0.5)) };
}

/** Budget spellings the importer accepts (taken from the M4 fixture's valid rows). */
export function budgetText(rupees: number, style: number): string {
  const lakh = rupees / 100_000;
  switch (style % 6) {
    case 0:
      return `${Number(lakh.toFixed(2))} L`;
    case 1:
      return `${Number((lakh / 100).toFixed(2))} Cr`;
    case 2:
      return `₹ ${Number(lakh.toFixed(2))} Lakh`;
    case 3:
      return `${rupees.toLocaleString('en-IN')}/-`;
    case 4:
      return `Rs. ${Number((lakh / 100).toFixed(2))} crore`;
    default:
      return String(rupees);
  }
}

/** Phone spellings the importer accepts (+91, 0, spaces, dashes). */
export function phoneText(digits10: string, style: number): string {
  switch (style % 5) {
    case 0:
      return digits10;
    case 1:
      return `+91 ${digits10}`;
    case 2:
      return `0${digits10.slice(0, 5)} ${digits10.slice(5)}`;
    case 3:
      return `91-${digits10.slice(0, 5)}-${digits10.slice(5)}`;
    default:
      return `${digits10.slice(0, 5)} ${digits10.slice(5)}`;
  }
}
