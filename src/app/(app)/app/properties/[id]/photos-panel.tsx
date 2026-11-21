// FR-141: a property's photos. Everyone who can read the property sees them; Owners and Admins
// add and remove. Images come from the app (after a permission check), never from storage URLs.
import { ActionFormButton } from '@/components/action-form-button';
import { EmptyState } from '@/components/ui';
import { PHOTO_LIMITS, type PhotoView } from '@/modules/properties';
import { removePhotoAction } from '@/modules/properties/actions';
import { PhotoUploader } from './photo-uploader';

export function PhotosPanel({
  propertyId,
  photos,
  canManage,
}: {
  propertyId: string;
  photos: PhotoView[];
  canManage: boolean;
}) {
  const src = (id: string, thumb: boolean) =>
    `/app/properties/${propertyId}/photos/${id}${thumb ? '?size=thumb' : ''}`;
  return (
    <div className="space-y-4">
      {photos.length === 0 ? (
        <EmptyState>No photos yet.</EmptyState>
      ) : (
        <ul className="grid grid-cols-2 gap-3 sm:grid-cols-3" aria-label="Photos">
          {photos.map((p, i) => (
            <li key={p.id} className="space-y-1.5">
              <a
                href={src(p.id, false)}
                target="_blank"
                rel="noopener"
                className="group relative block overflow-hidden rounded-lg border border-slate-200 focus:outline-none focus-visible:ring-2 focus-visible:ring-gold-400"
                title="Open full size"
              >
                {/* eslint-disable-next-line @next/next/no-img-element -- private, app-served image */}
                <img
                  src={src(p.id, true)}
                  alt={`Photo ${i + 1} of ${photos.length}`}
                  loading="lazy"
                  width={480}
                  height={Math.round((480 * p.height) / p.width)}
                  className="aspect-[4/3] w-full bg-slate-100 object-cover transition group-hover:scale-[1.02]"
                />
                {i === 0 && (
                  <span className="absolute top-1.5 left-1.5 rounded bg-blue-900 px-1.5 text-[0.6875rem] font-semibold text-white">
                    Cover
                  </span>
                )}
              </a>
              {canManage && (
                <ActionFormButton
                  action={removePhotoAction}
                  fields={{ photoId: p.id, propertyId }}
                  label="Remove"
                  variant="ghost"
                  confirm="Remove this photo? It will be deleted from storage."
                />
              )}
            </li>
          ))}
        </ul>
      )}
      {canManage && (
        <PhotoUploader propertyId={propertyId} room={PHOTO_LIMITS.maxPhotos - photos.length} />
      )}
    </div>
  );
}
