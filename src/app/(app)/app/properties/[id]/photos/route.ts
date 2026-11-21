import { addPhoto, PHOTO_LIMITS } from '@/modules/properties';
import { requireContext } from '@/platform/auth/session';
import { DomainError } from '@/platform/errors';
import { privateResponse, privateRoute } from '@/platform/http/private-response';
import { photoStorage, StorageError } from '@/platform/storage';

/** The two files and the multipart framing around them. */
const MAX_BODY = PHOTO_LIMITS.maxBytes + PHOTO_LIMITS.maxThumbBytes + 64 * 1024;

const json = (status: number, body: Record<string, unknown>) =>
  privateResponse(JSON.stringify(body), {
    status,
    headers: { 'content-type': 'application/json; charset=utf-8' },
  });

/**
 * Same-origin requests only: unlike Server Actions, a route handler has no built-in origin check.
 * The Origin's host must be this server's host (as the framework compares for Server Actions).
 */
function sameOrigin(req: Request): boolean {
  const origin = req.headers.get('origin');
  const host = req.headers.get('x-forwarded-host') ?? req.headers.get('host');
  if (!origin || !host) return false;
  try {
    return new URL(origin).host === host;
  } catch {
    return false;
  }
}

/**
 * FR-141: upload one photo with its thumbnail (multipart fields "photo" and "thumb"), both
 * prepared by the browser. Owner/Admin; the module checks the files and the 20-photo limit.
 */
export const POST = privateRoute(
  'property-photo-upload',
  async (req: Request, { params }: RouteContext<'/app/properties/[id]/photos'>) => {
    if (!sameOrigin(req)) return json(403, { error: 'Cross-site requests are not allowed' });
    const length = Number(req.headers.get('content-length'));
    if (!Number.isFinite(length) || length <= 0)
      return json(411, { error: 'The upload has no length' });
    if (length > MAX_BODY) return json(413, { error: 'The photo is too large' });
    const { id } = await params;
    try {
      const ctx = await requireContext();
      const form = await req.formData().catch(() => null);
      const photo = form?.get('photo');
      const thumb = form?.get('thumb');
      if (!(photo instanceof Blob) || !(thumb instanceof Blob))
        return json(400, { error: 'Choose a photo to upload' });
      const added = await addPhoto(
        ctx,
        id,
        {
          full: new Uint8Array(await photo.arrayBuffer()),
          thumb: new Uint8Array(await thumb.arrayBuffer()),
        },
        { storage: photoStorage() },
      );
      return json(201, { id: added.id });
    } catch (e) {
      if (e instanceof DomainError) {
        if (e.code === 'UNAUTHENTICATED') return json(401, { error: 'Sign in first' });
        // No permission, another org's or a missing property: the same answer.
        if (e.code === 'NOT_FOUND' || e.code === 'FORBIDDEN')
          return json(404, { error: 'Property not found' });
        return json(422, { error: e.message });
      }
      if (e instanceof StorageError)
        return json(e.code === 'NOT_CONFIGURED' ? 503 : 502, { error: e.message });
      throw e;
    }
  },
);
