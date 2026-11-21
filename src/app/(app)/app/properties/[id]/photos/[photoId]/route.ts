import { loadPhoto } from '@/modules/properties';
import { requireContext } from '@/platform/auth/session';
import { DomainError } from '@/platform/errors';
import { privateResponse, privateRoute } from '@/platform/http/private-response';
import { photoStorage, StorageError } from '@/platform/storage';

/**
 * FR-141: one property photo (?size=thumb for its thumbnail), streamed from private storage after
 * the permission check; no storage URL reaches the browser. Private and never cached, like every
 * file of a signed-in user (private-response.ts).
 */
export const GET = privateRoute(
  'property-photo',
  async (req: Request, { params }: RouteContext<'/app/properties/[id]/photos/[photoId]'>) => {
    const { id, photoId } = await params;
    const size = new URL(req.url).searchParams.get('size') === 'thumb' ? 'thumb' : 'full';
    try {
      const file = await loadPhoto(await requireContext(), id, photoId, size, {
        storage: photoStorage(),
      });
      return privateResponse(Buffer.from(file.body), {
        headers: { 'content-type': file.contentType, 'content-disposition': 'inline' },
      });
    } catch (e) {
      if (e instanceof DomainError) {
        if (e.code === 'UNAUTHENTICATED') return privateResponse('Sign in first', { status: 401 });
        return privateResponse('Not found', { status: 404 });
      }
      if (e instanceof StorageError && e.code === 'NOT_FOUND')
        return privateResponse('Not found', { status: 404 });
      throw e;
    }
  },
);
