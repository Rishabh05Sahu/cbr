'use client';
// FR-141: choose property photos (gallery or camera on a phone), with previews and a way to drop
// one before uploading. The input has no name, so the files never ride along in a form post: they
// are prepared and uploaded one by one (photo-upload.ts).
import { useEffect, useMemo } from 'react';
import { PHOTO_ACCEPT } from './photo-upload';

export function PhotoPicker({
  files,
  onChange,
  room,
  disabled = false,
}: {
  files: File[];
  onChange: (files: File[]) => void;
  /** How many more photos the property can take. */
  room: number;
  disabled?: boolean;
}) {
  const previews = useMemo(() => files.map((f) => URL.createObjectURL(f)), [files]);
  useEffect(() => () => previews.forEach((u) => URL.revokeObjectURL(u)), [previews]);
  const full = files.length >= room;

  return (
    <div className="space-y-3">
      <label
        className={`tap flex min-h-24 cursor-pointer flex-col items-center justify-center gap-1 rounded-xl border-2 border-dashed px-4 py-5 text-center text-sm transition ${
          disabled || full
            ? 'cursor-not-allowed border-slate-200 text-slate-400'
            : 'border-slate-300 text-slate-700 hover:border-gold-400 hover:bg-gold-50'
        }`}
      >
        <svg
          width="28"
          height="28"
          viewBox="0 0 24 24"
          fill="none"
          stroke="currentColor"
          strokeWidth="1.6"
          strokeLinecap="round"
          strokeLinejoin="round"
          aria-hidden="true"
        >
          <rect x="3" y="5" width="18" height="14" rx="2" />
          <circle cx="9" cy="10" r="1.8" />
          <path d="m21 16-5-5-8 8" />
        </svg>
        <span className="font-medium">{full ? 'Photo limit reached' : 'Add photos'}</span>
        <span className="text-xs text-slate-500">
          JPEG, PNG or WebP · up to {room} more · location data is removed
        </span>
        <input
          type="file"
          accept={PHOTO_ACCEPT}
          multiple
          className="sr-only"
          disabled={disabled || full}
          onChange={(e) => {
            const chosen = [...(e.target.files ?? [])];
            e.target.value = ''; // the same file can be chosen again after removing it
            onChange([...files, ...chosen].slice(0, room));
          }}
        />
      </label>
      {files.length > 0 && (
        <ul className="grid grid-cols-3 gap-2 sm:grid-cols-4" aria-label="Photos to upload">
          {files.map((f, i) => (
            <li key={`${f.name}-${f.lastModified}-${i}`} className="relative">
              {/* eslint-disable-next-line @next/next/no-img-element -- local preview (blob:) */}
              <img
                src={previews[i]}
                alt={f.name}
                className="aspect-square w-full rounded-lg border border-slate-200 object-cover"
              />
              <button
                type="button"
                disabled={disabled}
                onClick={() => onChange(files.filter((_, j) => j !== i))}
                className="absolute top-1 right-1 flex h-7 w-7 items-center justify-center rounded-full bg-slate-900/70 text-sm text-white hover:bg-slate-900 disabled:opacity-50"
                aria-label={`Remove ${f.name}`}
              >
                ×
              </button>
            </li>
          ))}
        </ul>
      )}
    </div>
  );
}
