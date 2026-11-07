import Link from 'next/link';
import { ActionForm } from '@/components/action-form';
import { Badge, Card, PageHeader } from '@/components/ui';
import { getProperty, PROPERTY_LABELS, responsibleOptions } from '@/modules/properties';
import { updatePropertyAction } from '@/modules/properties/actions';
import { can } from '@/platform/authz';
import { pageContext, pageRequire } from '@/platform/auth/session';
import { LABELS } from '../../leads/labels';
import { priceText, rupees } from '../format';
import { PropertyFields } from '../property-fields';
import { ContactsPanel } from './contacts-panel';

const lab = (c: string | null) => (c ? (PROPERTY_LABELS[c] ?? LABELS[c] ?? c) : '—');

/**
 * FR-140 property page: its details; Owners and Admins edit them. FR-142: owner contacts in their
 * own panel, for Owner, Admin and Sales Manager, shown only on request (audited).
 */
export default async function PropertyPage({ params }: { params: Promise<{ id: string }> }) {
  const { ctx } = await pageContext();
  pageRequire(ctx, 'property.read');
  const { id } = await params;
  const p = await getProperty(ctx, id);
  const canManage = can(ctx, 'property.manage');
  const people = canManage ? await responsibleOptions(ctx) : [];
  const rows: [string, string][] = [
    ['Code', p.code],
    ['Listed for', lab(p.listingType)],
    ['Type', lab(p.propertyType)],
    ['Bedrooms', p.bhk === null ? '—' : `${p.bhk} BHK`],
    ['Price', priceText(p)],
    ['Maintenance', p.maintenance ? rupees(p.maintenance) : '—'],
    ['Deposit', p.deposit ? rupees(p.deposit) : '—'],
    ['City', p.city],
    ['Locality', p.locality ?? '—'],
    ['Address', p.addressLine ?? '—'],
    ['Carpet area', p.carpetAreaSqft ? `${p.carpetAreaSqft} sq ft` : '—'],
    ['Built-up area', p.builtUpAreaSqft ? `${p.builtUpAreaSqft} sq ft` : '—'],
    ['Floor', p.floor ?? '—'],
    ['Facing', p.facing ?? '—'],
    ['Furnishing', lab(p.furnishing)],
    ['Available from', p.availableFrom ?? '—'],
    ['Responsible agent', p.responsibleName],
    ['Amenities', p.amenities.length ? p.amenities.join(', ') : '—'],
  ];
  return (
    <>
      <p className="mb-2 text-sm">
        <Link href="/app/properties" className="tap text-blue-900 underline">
          ← Properties
        </Link>
      </p>
      <PageHeader title={p.title} />
      <div className="mb-4 flex flex-wrap gap-2">
        <Badge tone={p.status === 'AVAILABLE' ? 'good' : p.status === 'DRAFT' ? 'neutral' : 'warn'}>
          {lab(p.status)}
        </Badge>
        <Badge>{p.code}</Badge>
      </div>
      <div className="grid gap-4 lg:grid-cols-3">
        <div className="space-y-4 lg:col-span-2">
          <Card title="Details">
            <dl className="grid gap-x-4 gap-y-2 text-sm sm:grid-cols-2">
              {rows.map(([k, v]) => (
                <div key={k}>
                  <dt className="text-xs text-slate-500">{k}</dt>
                  <dd className="break-words text-slate-900">{v}</dd>
                </div>
              ))}
            </dl>
            {p.description && (
              <p className="mt-3 whitespace-pre-wrap text-sm text-slate-800">{p.description}</p>
            )}
          </Card>
          {canManage && (
            <Card title="Edit property">
              <details>
                <summary className="tap cursor-pointer text-sm font-medium text-blue-900">
                  Edit details
                </summary>
                <ActionForm
                  action={updatePropertyAction}
                  successMessage="Saved."
                  submitLabel="Save changes"
                  resetOnSuccess={false}
                  fieldLabels={{
                    listingType: 'Listed for',
                    propertyType: 'Property type',
                    priceType: 'Price is',
                    responsibleUserId: 'Responsible agent',
                    carpetAreaSqft: 'Carpet area',
                    builtUpAreaSqft: 'Built-up area',
                    availableFrom: 'Available from',
                    bhk: 'Bedrooms',
                  }}
                  className="mt-3 space-y-4"
                >
                  <input type="hidden" name="propertyId" value={p.id} />
                  <input type="hidden" name="version" value={p.version} />
                  <PropertyFields people={people} p={p} />
                </ActionForm>
              </details>
            </Card>
          )}
        </div>
        {can(ctx, 'property.read_owner_contact') && (
          <div>
            <Card title="Owner contacts" description="Confidential.">
              <ContactsPanel propertyId={p.id} canManage={canManage} />
            </Card>
          </div>
        )}
      </div>
    </>
  );
}
