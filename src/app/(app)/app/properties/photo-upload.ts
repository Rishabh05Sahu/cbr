// FR-141: preparing and uploading a property photo in the browser. The photo is decoded the right
// way up (EXIF orientation applied) and re-drawn on a canvas: the canvas output carries no EXIF or
// XMP, so location data never leaves the device. A photo (≤ 2048 px) and a thumbnail (≤ 480 px)
// are encoded as WebP, or JPEG where the browser cannot write WebP, and posted together. The
// server checks both again (photo-format.ts) and never decodes them.

export const PHOTO_ACCEPT = 'image/jpeg,image/png,image/webp,image/heic,image/heif';
/** Originals larger than this are refused before any work (phone photos are 2–12 MB). */
export const MAX_ORIGINAL_BYTES = 30 * 1024 * 1024;
const FULL_SIDE = 2048;
const THUMB_SIDE = 480;

let encodeType: 'image/webp' | 'image/jpeg' | undefined;
/** WebP when this browser can write it (Safari before 17 could not), else JPEG. */
function outputType(): 'image/webp' | 'image/jpeg' {
  if (!encodeType) {
    const c = document.createElement('canvas');
    c.width = c.height = 1;
    encodeType = c.toDataURL('image/webp').startsWith('data:image/webp')
      ? 'image/webp'
      : 'image/jpeg';
  }
  return encodeType;
}

function draw(img: ImageBitmap, maxSide: number, type: string, quality: number): Promise<Blob> {
  const scale = Math.min(1, maxSide / Math.max(img.width, img.height));
  const canvas = document.createElement('canvas');
  canvas.width = Math.max(1, Math.round(img.width * scale));
  canvas.height = Math.max(1, Math.round(img.height * scale));
  const g = canvas.getContext('2d');
  if (!g) return Promise.reject(new Error('This browser cannot prepare photos'));
  g.fillStyle = '#ffffff'; // transparent PNG areas become white, not black, in a JPEG
  g.fillRect(0, 0, canvas.width, canvas.height);
  g.imageSmoothingQuality = 'high';
  g.drawImage(img, 0, 0, canvas.width, canvas.height);
  return new Promise((resolve, reject) =>
    canvas.toBlob(
      (b) => (b ? resolve(b) : reject(new Error('This photo could not be prepared'))),
      type,
      quality,
    ),
  );
}

/** Decodes and re-draws one chosen file; refuses what cannot be read as an image. */
export async function preparePhoto(file: File): Promise<{ full: Blob; thumb: Blob }> {
  if (file.size > MAX_ORIGINAL_BYTES) throw new Error(`${file.name}: the file is too large`);
  let img: ImageBitmap;
  try {
    img = await createImageBitmap(file, { imageOrientation: 'from-image' });
  } catch {
    throw new Error(`${file.name}: this format could not be read; use a JPEG, PNG or WebP photo`);
  }
  try {
    const type = outputType();
    return {
      full: await draw(img, FULL_SIDE, type, 0.85),
      thumb: await draw(img, THUMB_SIDE, type, 0.8),
    };
  } finally {
    img.close();
  }
}

/** Prepares and uploads one photo to a property; resolves, or rejects with a readable message. */
export async function uploadPhoto(propertyId: string, file: File): Promise<void> {
  const { full, thumb } = await preparePhoto(file);
  const ext = full.type === 'image/webp' ? 'webp' : 'jpg';
  const body = new FormData();
  body.append('photo', full, `photo.${ext}`);
  body.append('thumb', thumb, `thumb.${ext}`);
  const res = await fetch(`/app/properties/${propertyId}/photos`, { method: 'POST', body });
  if (res.ok) return;
  const reason = await res
    .json()
    .then((j: { error?: unknown }) => (typeof j.error === 'string' ? j.error : null))
    .catch(() => null);
  throw new Error(`${file.name}: ${reason ?? 'the upload failed; try again'}`);
}
