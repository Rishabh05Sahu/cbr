import { ActionForm } from '@/components/action-form';
import { Card, PageHeader } from '@/components/ui';
import { responsibleOptions } from '@/modules/properties';
import { createPropertyAction } from '@/modules/properties/actions';
import { pageContext, pageRequire } from '@/platform/auth/session';
import { PropertyFields } from '../property-fields';

/** FR-140: add a property (Owner/Admin). Owner contacts are added on its page afterwards. */
export default async function NewPropertyPage() {
  const { ctx } = await pageContext();
  pageRequire(ctx, 'property.manage');
  const people = await responsibleOptions(ctx);
  return (
    <>
      <PageHeader
        title="Add property"
        description="New listings start as Draft unless you choose another status. Its code is assigned automatically. Add owner contacts on its page."
      />
      <Card>
        <ActionForm
          action={createPropertyAction}
          submitLabel="Save property"
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
          resetOnSuccess={false}
        >
          <PropertyFields people={people} />
        </ActionForm>
      </Card>
    </>
  );
}
