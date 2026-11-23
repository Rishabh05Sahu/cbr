// POST /api/v1/properties/:id/photos — add a photo from the phone (FR-141, Owner/Admin):
// multipart "photo" (JPEG/WebP, longest side ≤ 4096 px) and "thumb" (≤ 640 px), both prepared by
// the app (resized, EXIF removed). The module checks the files, the type and the 20-photo limit.
// Bearer only, so there is no cross-site form risk: the web route's same-origin check is not
// needed here.
import { addPhoto, PHOTO_LIMITS } from '@/modules/properties';
import { apiError, apiRoute } from '@/platform/http/api-route';
import { photoStorage, StorageError } from '@/platform/storage';

export const dynamic = 'force-dynamic';

const MAX_BODY = PHOTO_LIMITS.maxBytes + PHOTO_LIMITS.maxThumbBytes + 64 * 1024;

export const POST = apiRoute<{ id: string }>('property-photo-add', async ({ req, ctx, params }) => {
  const length = Number(req.headers.get('content-length'));
  if (!Number.isFinite(length) || length <= 0)
    return apiError('VALIDATION_FAILED', 'The upload has no length');
  if (length > MAX_BODY) return apiError('VALIDATION_FAILED', 'The photo is too large');
  const form = await req.formData().catch(() => null);
  const photo = form?.get('photo');
  const thumb = form?.get('thumb');
  if (!(photo instanceof Blob) || !(thumb instanceof Blob))
    return apiError('VALIDATION_FAILED', 'Choose a photo to upload');
  try {
    return await addPhoto(
      ctx,
      params.id,
      {
        full: new Uint8Array(await photo.arrayBuffer()),
        thumb: new Uint8Array(await thumb.arrayBuffer()),
      },
      { storage: photoStorage() },
    );
  } catch (e) {
    if (e instanceof StorageError)
      return apiError('UNAVAILABLE', 'Photo storage is not available right now. Try again later.');
    throw e;
  }
});
