import Link from 'next/link';
import { Badge, Card, EmptyState, Field, Input, PageHeader, Select } from '@/components/ui';
import {
  listProperties,
  LISTING_TYPES,
  PROPERTY_KINDS,
  PROPERTY_LABELS,
  PROPERTY_STATUSES,
  type PropertyView,
} from '@/modules/properties';
import { can } from '@/platform/authz';
import { pageContext, pageRequire } from '@/platform/auth/session';
import { LABELS } from '../leads/labels';
import { priceText } from './format';

const lab = (c: string) => PROPERTY_LABELS[c] ?? LABELS[c] ?? c;
const one = (v: string | string[] | undefined) => (Array.isArray(v) ? v[0] : v);

/**
 * FR-140 property inventory: filters (status, listing type, property type, city, price range,
 * bedrooms) and a search over code, title and locality; newest first. Owner contacts never appear
 * here (FR-142). Owners and Admins add properties.
 */
export default async function PropertiesPage({
  searchParams,
}: {
  searchParams: Promise<Record<string, string | string[] | undefined>>;
}) {
  const { ctx } = await pageContext();
  pageRequire(ctx, 'property.read');
  const sp = await searchParams;
  const raw = Object.fromEntries(Object.entries(sp).map(([k, v]) => [k, one(v)]));
  const { rows, page, hasMore, query } = await listProperties(ctx, raw);
  const pageHref = (n: number) => {
    const p = new URLSearchParams(
      Object.entries({ ...query, page: String(n) }).filter(([, v]) => v) as [string, string][],
    );
    return `/app/properties?${p.toString()}` as '/app/properties';
  };
  return (
    <>
      <PageHeader
        title="Properties"
        description="Inventory of listings for sale, rent or lease. Owner contacts are on each property's page, for those allowed to see them."
      />
      {can(ctx, 'property.manage') && (
        <p className="mb-4">
          <Link
            href="/app/properties/new"
            className="tap inline-block rounded-md bg-blue-900 px-3 py-2 text-sm font-medium text-white"
          >
            Add property
          </Link>
        </p>
      )}
      <Card>
        <form method="get" className="grid gap-3 sm:grid-cols-4" aria-label="Filter properties">
          <div className="sm:col-span-2">
            <Field label="Search" htmlFor="pq">
              <Input
                id="pq"
                name="q"
                defaultValue={query.q}
                placeholder="Code, title or locality"
              />
            </Field>
          </div>
          <Field label="Status" htmlFor="ps">
            <Select id="ps" name="status" defaultValue={query.status ?? ''}>
              <option value="">Any</option>
              {PROPERTY_STATUSES.map((s) => (
                <option key={s} value={s}>
                  {lab(s)}
                </option>
              ))}
            </Select>
          </Field>
          <Field label="Listed for" htmlFor="pl">
            <Select id="pl" name="listingType" defaultValue={query.listingType ?? ''}>
              <option value="">Any</option>
              {LISTING_TYPES.map((s) => (
                <option key={s} value={s}>
                  {lab(s)}
                </option>
              ))}
            </Select>
          </Field>
          <Field label="Type" htmlFor="pt">
            <Select id="pt" name="propertyType" defaultValue={query.propertyType ?? ''}>
              <option value="">Any</option>
              {PROPERTY_KINDS.map((s) => (
                <option key={s} value={s}>
                  {lab(s)}
                </option>
              ))}
            </Select>
          </Field>
          <Field label="City" htmlFor="pc">
            <Input id="pc" name="city" defaultValue={query.city} />
          </Field>
          <Field label="Min price (₹)" htmlFor="pmin">
            <Input id="pmin" name="minPrice" inputMode="decimal" defaultValue={query.minPrice} />
          </Field>
          <Field label="Max price (₹)" htmlFor="pmax">
            <Input id="pmax" name="maxPrice" inputMode="decimal" defaultValue={query.maxPrice} />
          </Field>
          <Field label="BHK" htmlFor="pb">
            <Input id="pb" name="bhk" type="number" min={0} max={20} defaultValue={query.bhk} />
          </Field>
          <div className="flex items-end gap-2 sm:col-span-3">
            <button
              type="submit"
              className="tap rounded-md bg-blue-900 px-3 py-2 text-sm font-medium text-white"
            >
              Apply
            </button>
            <Link href="/app/properties" className="tap px-2 py-2 text-sm text-blue-900 underline">
              Clear
            </Link>
          </div>
        </form>
      </Card>
      <div className="mt-4">
        <Card>
          {rows.length === 0 ? (
            <EmptyState>No properties match.</EmptyState>
          ) : (
            <ul className="divide-y divide-slate-100" aria-label="Properties">
              {rows.map((p) => (
                <Row key={p.id} p={p} />
              ))}
            </ul>
          )}
        </Card>
      </div>
      {(page > 1 || hasMore) && (
        <nav aria-label="Pages" className="mt-4 flex gap-3 text-sm">
          {page > 1 && (
            <Link href={pageHref(page - 1)} className="tap text-blue-900 underline">
              ← Previous
            </Link>
          )}
          <span className="text-slate-600">Page {page}</span>
          {hasMore && (
            <Link href={pageHref(page + 1)} className="tap text-blue-900 underline">
              Next →
            </Link>
          )}
        </nav>
      )}
    </>
  );
}

function Row({ p }: { p: PropertyView }) {
  return (
    <li className="space-y-1 py-3 text-sm" data-testid="property-row">
      <div className="flex flex-wrap items-center gap-2">
        <Link
          href={`/app/properties/${p.id}` as '/app/properties'}
          className="tap font-medium text-blue-900 underline-offset-2 hover:underline"
        >
          {p.title}
        </Link>
        <span className="text-xs text-slate-500">{p.code}</span>
        <Badge tone={p.status === 'AVAILABLE' ? 'good' : p.status === 'DRAFT' ? 'neutral' : 'warn'}>
          {lab(p.status)}
        </Badge>
      </div>
      <p className="text-slate-700">
        {lab(p.listingType)} · {lab(p.propertyType)}
        {p.bhk !== null && ` · ${p.bhk} BHK`} · {[p.locality, p.city].filter(Boolean).join(', ')}
      </p>
      <p className="font-medium text-slate-900">{priceText(p)}</p>
    </li>
  );
}
