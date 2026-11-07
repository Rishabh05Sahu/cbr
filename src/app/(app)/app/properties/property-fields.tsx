// FR-140 property form fields, shared by the new-property page and the edit form. Plain markup:
// the server validates everything (and the database re-checks it). Owner contacts are not here:
// they are confidential (FR-142) and managed in their own panel.
import { Field, Input, Select } from '@/components/ui';
import { LABELS } from '../leads/labels';
import {
  FACINGS,
  FURNISHINGS,
  LISTING_TYPES,
  PRICE_TYPES,
  PROPERTY_KINDS,
  PROPERTY_LABELS,
  PROPERTY_STATUSES,
} from '@/modules/properties/rules';
import type { PropertyView } from '@/modules/properties';

const textareaClass = 'block w-full rounded-md border border-slate-300 px-3 py-2 text-sm';
const lab = (c: string) => PROPERTY_LABELS[c] ?? LABELS[c] ?? c;

export function PropertyFields({
  people,
  p,
}: {
  people: { userId: string; name: string }[];
  /** The property being edited; absent for a new one. */
  p?: PropertyView;
}) {
  const id = (k: string) => `pf-${k}`;
  return (
    <div className="space-y-6">
      <fieldset className="grid gap-4 sm:grid-cols-2">
        <legend className="mb-2 text-sm font-semibold text-slate-900">Listing</legend>
        <div className="sm:col-span-2">
          <Field label="Title" htmlFor={id('title')}>
            <Input id={id('title')} name="title" maxLength={200} required defaultValue={p?.title} />
          </Field>
        </div>
        <Field label="Listed for" htmlFor={id('listingType')}>
          <Select
            id={id('listingType')}
            name="listingType"
            required
            defaultValue={p?.listingType ?? 'SALE'}
          >
            {LISTING_TYPES.map((v) => (
              <option key={v} value={v}>
                {lab(v)}
              </option>
            ))}
          </Select>
        </Field>
        <Field label="Property type" htmlFor={id('propertyType')}>
          <Select
            id={id('propertyType')}
            name="propertyType"
            required
            defaultValue={p?.propertyType ?? 'APARTMENT'}
          >
            {PROPERTY_KINDS.map((v) => (
              <option key={v} value={v}>
                {lab(v)}
              </option>
            ))}
          </Select>
        </Field>
        <Field
          label="Status"
          htmlFor={id('status')}
          hint="Sold applies to a sale; Rented to rent or lease."
        >
          <Select id={id('status')} name="status" defaultValue={p?.status ?? 'DRAFT'}>
            {PROPERTY_STATUSES.map((v) => (
              <option key={v} value={v}>
                {lab(v)}
              </option>
            ))}
          </Select>
        </Field>
        <Field label="Responsible agent" htmlFor={id('responsibleUserId')}>
          <Select
            id={id('responsibleUserId')}
            name="responsibleUserId"
            defaultValue={p?.responsibleUserId ?? ''}
          >
            {!p && <option value="">Me</option>}
            {people.map((m) => (
              <option key={m.userId} value={m.userId}>
                {m.name}
              </option>
            ))}
          </Select>
        </Field>
      </fieldset>

      <fieldset className="grid gap-4 sm:grid-cols-2">
        <legend className="mb-2 text-sm font-semibold text-slate-900">Price (₹)</legend>
        <Field label="Price" htmlFor={id('price')} hint="Rupees; commas are fine (85,00,000).">
          <Input
            id={id('price')}
            name="price"
            inputMode="decimal"
            required
            defaultValue={p?.price}
          />
        </Field>
        <Field
          label="Price is"
          htmlFor={id('priceType')}
          hint="Total or per sq ft for a sale; per month for rent or lease."
        >
          <Select
            id={id('priceType')}
            name="priceType"
            required
            defaultValue={p?.priceType ?? 'TOTAL'}
          >
            {PRICE_TYPES.map((v) => (
              <option key={v} value={v}>
                {lab(v)}
              </option>
            ))}
          </Select>
        </Field>
        <Field label="Maintenance (optional)" htmlFor={id('maintenance')}>
          <Input
            id={id('maintenance')}
            name="maintenance"
            inputMode="decimal"
            defaultValue={p?.maintenance ?? undefined}
          />
        </Field>
        <Field label="Deposit (rent or lease, optional)" htmlFor={id('deposit')}>
          <Input
            id={id('deposit')}
            name="deposit"
            inputMode="decimal"
            defaultValue={p?.deposit ?? undefined}
          />
        </Field>
      </fieldset>

      <fieldset className="grid gap-4 sm:grid-cols-2">
        <legend className="mb-2 text-sm font-semibold text-slate-900">Location</legend>
        <Field label="City" htmlFor={id('city')}>
          <Input id={id('city')} name="city" maxLength={100} required defaultValue={p?.city} />
        </Field>
        <Field label="Locality (optional)" htmlFor={id('locality')}>
          <Input
            id={id('locality')}
            name="locality"
            maxLength={100}
            defaultValue={p?.locality ?? undefined}
          />
        </Field>
        <div className="sm:col-span-2">
          <Field label="Address (optional)" htmlFor={id('addressLine')}>
            <Input
              id={id('addressLine')}
              name="addressLine"
              maxLength={300}
              defaultValue={p?.addressLine ?? undefined}
            />
          </Field>
        </div>
        <Field label="Latitude (optional)" htmlFor={id('latitude')}>
          <Input
            id={id('latitude')}
            name="latitude"
            inputMode="decimal"
            defaultValue={p?.latitude ?? undefined}
          />
        </Field>
        <Field label="Longitude (optional)" htmlFor={id('longitude')}>
          <Input
            id={id('longitude')}
            name="longitude"
            inputMode="decimal"
            defaultValue={p?.longitude ?? undefined}
          />
        </Field>
      </fieldset>

      <fieldset className="grid gap-4 sm:grid-cols-2">
        <legend className="mb-2 text-sm font-semibold text-slate-900">Details (optional)</legend>
        <Field label="Bedrooms (BHK)" htmlFor={id('bhk')}>
          <Input
            id={id('bhk')}
            name="bhk"
            type="number"
            min={0}
            max={20}
            defaultValue={p?.bhk ?? undefined}
          />
        </Field>
        <Field label="Floor" htmlFor={id('floor')}>
          <Input
            id={id('floor')}
            name="floor"
            maxLength={20}
            defaultValue={p?.floor ?? undefined}
          />
        </Field>
        <Field label="Carpet area (sq ft)" htmlFor={id('carpetAreaSqft')}>
          <Input
            id={id('carpetAreaSqft')}
            name="carpetAreaSqft"
            inputMode="decimal"
            defaultValue={p?.carpetAreaSqft ?? undefined}
          />
        </Field>
        <Field label="Built-up area (sq ft)" htmlFor={id('builtUpAreaSqft')}>
          <Input
            id={id('builtUpAreaSqft')}
            name="builtUpAreaSqft"
            inputMode="decimal"
            defaultValue={p?.builtUpAreaSqft ?? undefined}
          />
        </Field>
        <Field label="Facing" htmlFor={id('facing')}>
          <Select id={id('facing')} name="facing" defaultValue={p?.facing ?? ''}>
            <option value="">Not set</option>
            {FACINGS.map((v) => (
              <option key={v} value={v}>
                {v}
              </option>
            ))}
          </Select>
        </Field>
        <Field label="Furnishing" htmlFor={id('furnishing')}>
          <Select id={id('furnishing')} name="furnishing" defaultValue={p?.furnishing ?? ''}>
            <option value="">Not set</option>
            {FURNISHINGS.map((v) => (
              <option key={v} value={v}>
                {lab(v)}
              </option>
            ))}
          </Select>
        </Field>
        <Field label="Available from" htmlFor={id('availableFrom')}>
          <Input
            id={id('availableFrom')}
            name="availableFrom"
            type="date"
            defaultValue={p?.availableFrom ?? undefined}
          />
        </Field>
        <div className="sm:col-span-2">
          <Field
            label="Amenities"
            htmlFor={id('amenities')}
            hint="Separate with commas, e.g. Lift, Parking, Gym (at most 30)."
          >
            <Input
              id={id('amenities')}
              name="amenities"
              maxLength={3000}
              defaultValue={p?.amenities.join(', ')}
            />
          </Field>
        </div>
        <div className="sm:col-span-2">
          <Field label="Description" htmlFor={id('description')}>
            <textarea
              id={id('description')}
              name="description"
              maxLength={5000}
              rows={4}
              className={textareaClass}
              defaultValue={p?.description ?? undefined}
            />
          </Field>
        </div>
      </fieldset>
    </div>
  );
}
