'use client';
// Upload step (FR-040): the server creates the import and a signed permission for ONE object;
// the browser PUTs the file straight to private storage, then asks the server to verify it.
// Nothing is shown as uploaded until the server has checked the stored object.
import { useRouter } from 'next/navigation';
import { useState } from 'react';
import { Alert, Button, Field, Input } from '@/components/ui';
import { confirmUploadAction, startImportAction } from '@/modules/imports/actions';

type Phase = 'idle' | 'starting' | 'uploading' | 'verifying';

function put(
  url: string,
  headers: Record<string, string>,
  file: File,
  onProgress: (p: number) => void,
) {
  return new Promise<void>((resolve, reject) => {
    const xhr = new XMLHttpRequest();
    xhr.open('PUT', url);
    for (const [k, v] of Object.entries(headers)) xhr.setRequestHeader(k, v);
    xhr.upload.onprogress = (e) => e.lengthComputable && onProgress(e.loaded / e.total);
    xhr.onload = () =>
      xhr.status >= 200 && xhr.status < 300
        ? resolve()
        : reject(new Error(`The upload was refused (HTTP ${xhr.status}). Try again.`));
    xhr.onerror = () =>
      reject(new Error('The upload could not reach storage. Check your connection.'));
    xhr.send(file);
  });
}

export function UploadForm({ maxBytes, disabled }: { maxBytes: number; disabled: boolean }) {
  const router = useRouter();
  const [phase, setPhase] = useState<Phase>('idle');
  const [progress, setProgress] = useState(0);
  const [error, setError] = useState<string | null>(null);
  const busy = phase !== 'idle';

  async function onSubmit(e: React.FormEvent<HTMLFormElement>) {
    e.preventDefault();
    if (busy) return;
    const file = (e.currentTarget.elements.namedItem('file') as HTMLInputElement).files?.[0];
    if (!file) return setError('Choose a file first.');
    if (file.size > maxBytes) return setError('The file is larger than the allowed upload size.');
    setError(null);
    setPhase('starting');
    try {
      const started = await startImportAction({
        fileName: file.name,
        size: file.size,
        type: file.type,
      });
      if (!started.ok)
        throw new Error(started.error.fieldErrors?.file?.[0] ?? started.error.message);
      setPhase('uploading');
      await put(started.data.upload.url, started.data.upload.headers, file, setProgress);
      setPhase('verifying');
      const verified = await confirmUploadAction(started.data.importId);
      if (!verified.ok) throw new Error(verified.error.message);
      router.push(`/app/leads/import/${started.data.importId}`);
    } catch (err) {
      setError(err instanceof Error ? err.message : 'The upload failed. Try again.');
      setPhase('idle');
      setProgress(0);
    }
  }

  return (
    <form onSubmit={onSubmit} className="space-y-4">
      {error && <Alert tone="error">{error}</Alert>}
      <Field label="Spreadsheet (.xlsx or .csv)" htmlFor="import-file">
        <Input
          id="import-file"
          name="file"
          type="file"
          accept=".xlsx,.csv,application/vnd.openxmlformats-officedocument.spreadsheetml.sheet,text/csv"
          disabled={disabled || busy}
          required
        />
      </Field>
      {phase === 'uploading' && (
        <div className="space-y-1" aria-live="polite">
          <div className="h-2 w-full overflow-hidden rounded bg-slate-100">
            <div className="h-2 bg-blue-700" style={{ width: `${Math.round(progress * 100)}%` }} />
          </div>
          <p className="text-xs text-slate-600">Uploading… {Math.round(progress * 100)}%</p>
        </div>
      )}
      {phase === 'verifying' && <p className="text-sm text-slate-600">Checking the stored file…</p>}
      <Button type="submit" disabled={disabled || busy}>
        {phase === 'idle' ? 'Upload and check' : 'Working…'}
      </Button>
    </form>
  );
}
