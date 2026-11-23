// GET /api/v1/property-options — who can be made responsible for a property (property.manage),
// for the app's "Add property" form.
import { responsibleOptions } from '@/modules/properties';
import { apiRoute } from '@/platform/http/api-route';

export const dynamic = 'force-dynamic';

export const GET = apiRoute('property-options', async ({ ctx }) => ({
  responsible: await responsibleOptions(ctx),
}));
