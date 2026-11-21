'use client';
// FR-140 + FR-141: add a property and its photos in one go. The property is saved first (the
// server returns its id instead of redirecting when photos are waiting); the photos are then
// prepared and uploaded one by one, and the property's page opens. If a photo fails, the page
// says so and it can be added again there.
import { useRouter } from 'next/navigation';
import { useState, type ReactNode } from 'react';
import { ActionForm } from '@/components/action-form';
import { createPropertyAction } from '@/modules/properties/actions';
import { PHOTO_LIMITS } from '@/modules/properties/photo-format';
import { PhotoPicker } from '../photo-picker';
import { uploadPhoto } from '../photo-upload';

export function NewPropertyForm({
  fieldLabels,
  children,
}: {
  fieldLabels: Record<string, string>;
  children: ReactNode;
}) {
  const router = useRouter();
  const [files, setFiles] = useState<File[]>([]);
  const [busy, setBusy] = useState<string | null>(null);

  const afterSave = async (data: unknown) => {
    const id = (data as { id?: unknown } | null)?.id;
    if (typeof id !== 'string') return;
    let failed = 0;
    for (const [i, f] of files.entries()) {
      setBusy(`Property saved. Uploading photo ${i + 1} of ${files.length}…`);
      try {
        await uploadPhoto(id, f);
      } catch {
        failed++;
      }
    }
    router.push(`/app/properties/${id}${failed ? `?photosFailed=${failed}` : ''}` as '/app');
  };

  return (
    // Disabled while photos upload, so the property cannot be saved twice.
    <fieldset disabled={busy !== null} className="min-w-0">
      <ActionForm
        action={createPropertyAction}
        submitLabel={
          files.length
            ? `Save property and upload ${files.length} photo${files.length === 1 ? '' : 's'}`
            : 'Save property'
        }
        fieldLabels={fieldLabels}
        resetOnSuccess={false}
        onSuccess={(data) => void afterSave(data)}
      >
        {/* The server returns the new id instead of redirecting while photos are waiting. */}
        <input type="hidden" name="photosPending" value={files.length ? '1' : ''} />
        {children}
        <section
          aria-labelledby="new-property-photos"
          className="space-y-2 border-t border-slate-200 pt-4"
        >
          <h2 id="new-property-photos" className="text-base font-semibold text-slate-900">
            Photos
          </h2>
          <p className="text-sm text-slate-600">
            Optional. You can also add or remove photos later on the property&apos;s page.
          </p>
          <PhotoPicker
            files={files}
            onChange={setFiles}
            room={PHOTO_LIMITS.maxPhotos}
            disabled={busy !== null}
          />
        </section>
        {busy && (
          <p className="text-sm font-medium text-blue-900" aria-live="polite">
            {busy}
          </p>
        )}
      </ActionForm>
    </fieldset>
  );
}
