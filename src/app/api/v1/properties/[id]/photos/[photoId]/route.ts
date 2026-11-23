// GET /api/v1/properties/:id/photos/:photoId?size=thumb — one property photo's bytes (FR-141),
// after the permission check; private and never cached.
import { loadPhoto } from '@/modules/properties';
import { apiError, apiRoute, queryOf } from '@/platform/http/api-route';
import { privateResponse } from '@/platform/http/private-response';
import { photoStorage, StorageError } from '@/platform/storage';

export const dynamic = 'force-dynamic';

export const GET = apiRoute<{ id: string; photoId: string }>(
  'property-photo',
  async ({ req, ctx, params }) => {
    const size = queryOf(req).size === 'thumb' ? 'thumb' : 'full';
    try {
      const file = await loadPhoto(ctx, params.id, params.photoId, size, {
        storage: photoStorage(),
      });
      return privateResponse(Buffer.from(file.body), {
        headers: { 'content-type': file.contentType, 'content-disposition': 'inline' },
      });
    } catch (e) {
      if (e instanceof StorageError) return apiError('NOT_FOUND', 'Photo not found');
      throw e;
    }
  },
);
