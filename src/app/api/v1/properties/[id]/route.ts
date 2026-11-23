// GET /api/v1/properties/:id — one property with its photo list (FR-140/141). Owner contacts stay
// behind the website's reveal.
import { getProperty, listPhotos } from '@/modules/properties';
import { can } from '@/platform/authz';
import { apiRoute } from '@/platform/http/api-route';

export const dynamic = 'force-dynamic';

export const GET = apiRoute<{ id: string }>('property', async ({ ctx, params }) => {
  const property = await getProperty(ctx, params.id);
  return {
    property,
    photos: await listPhotos(ctx, property.id),
    canManage: can(ctx, 'property.manage'),
  };
});
