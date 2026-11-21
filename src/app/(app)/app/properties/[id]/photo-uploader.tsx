'use client';
// FR-141: add photos to an existing property (Owner/Admin): choose, then upload one by one with
// progress; the page refreshes to show them. A failed photo is listed; the others still upload.
import { useRouter } from 'next/navigation';
import { useState } from 'react';
import { Alert, Button } from '@/components/ui';
import { PhotoPicker } from '../photo-picker';
import { uploadPhoto } from '../photo-upload';

export function PhotoUploader({ propertyId, room }: { propertyId: string; room: number }) {
  const router = useRouter();
  const [files, setFiles] = useState<File[]>([]);
  const [busy, setBusy] = useState<string | null>(null);
  const [errors, setErrors] = useState<string[]>([]);
  const [done, setDone] = useState<number | null>(null);

  const upload = async () => {
    const failed: string[] = [];
    let ok = 0;
    for (const [i, f] of files.entries()) {
      setBusy(`Uploading photo ${i + 1} of ${files.length}…`);
      try {
        await uploadPhoto(propertyId, f);
        ok++;
      } catch (e) {
        failed.push(e instanceof Error ? e.message : `${f.name}: the upload failed`);
      }
    }
    setBusy(null);
    setErrors(failed);
    setDone(ok);
    setFiles([]);
    router.refresh();
  };

  return (
    <div className="space-y-3">
      {done !== null && done > 0 && (
        <Alert tone="success">
          {done} photo{done === 1 ? '' : 's'} added.
        </Alert>
      )}
      {errors.length > 0 && (
        <Alert tone="error">
          Some photos were not added:
          <ul className="mt-1 list-disc pl-5">
            {errors.map((e) => (
              <li key={e}>{e}</li>
            ))}
          </ul>
        </Alert>
      )}
      <PhotoPicker files={files} onChange={setFiles} room={room} disabled={busy !== null} />
      {files.length > 0 && (
        <div className="flex flex-wrap items-center gap-3">
          <Button onClick={upload} disabled={busy !== null}>
            {busy ? 'Uploading…' : `Upload ${files.length} photo${files.length === 1 ? '' : 's'}`}
          </Button>
          {busy && (
            <span className="text-sm text-slate-600" aria-live="polite">
              {busy}
            </span>
          )}
        </div>
      )}
    </div>
  );
}
