// FR-141 property photos: structural checks on an uploaded image (pure; no decoding). The browser
// re-draws every photo on a canvas before upload, which drops EXIF/XMP (including GPS location),
// and sends a JPEG or WebP. The server never decodes pixels: it reads only the container
// structure, accepts JPEG and still WebP, refuses any metadata block, and reads the dimensions
// from the frame header. Anything it cannot fully account for is refused.

export const PHOTO_LIMITS = {
  /** Photos per property (FR-141); the database enforces it too (0030). */
  maxPhotos: 20,
  /** One photo, after the browser's resize (FR-141: ≤ 10 MB). */
  maxBytes: 10 * 1024 * 1024,
  /** Longest side of a photo, in pixels. */
  maxSide: 4096,
  /** The thumbnail: longest side and size. */
  maxThumbSide: 640,
  maxThumbBytes: 1024 * 1024,
} as const;

export type PhotoType = 'image/jpeg' | 'image/webp';
export const PHOTO_TYPES: readonly PhotoType[] = ['image/jpeg', 'image/webp'];
export const PHOTO_EXT: Record<PhotoType, 'jpg' | 'webp'> = {
  'image/jpeg': 'jpg',
  'image/webp': 'webp',
};

export type PhotoErrorCode =
  | 'PHOTO_EMPTY'
  | 'PHOTO_TOO_LARGE'
  | 'PHOTO_NOT_SUPPORTED'
  | 'PHOTO_MALFORMED'
  | 'PHOTO_HAS_METADATA'
  | 'PHOTO_ANIMATED'
  | 'PHOTO_DIMENSIONS';

export interface InspectedPhoto {
  type: PhotoType;
  width: number;
  height: number;
}

export type Inspection =
  { ok: true; value: InspectedPhoto } | { ok: false; code: PhotoErrorCode; message: string };

const fail = (code: PhotoErrorCode, message: string): Inspection => ({ ok: false, code, message });
const MALFORMED = () => fail('PHOTO_MALFORMED', 'The image file is damaged or incomplete');
const METADATA = () =>
  fail('PHOTO_HAS_METADATA', 'The image still carries metadata (such as location); re-add it');

/**
 * Checks one image: its type, structure, metadata and dimensions. `maxSide` and `maxBytes` are
 * the limits for this file (a photo or a thumbnail).
 */
export function inspectPhoto(
  bytes: Uint8Array,
  limits: { maxBytes: number; maxSide: number },
): Inspection {
  if (bytes.length === 0) return fail('PHOTO_EMPTY', 'The image file is empty');
  if (bytes.length > limits.maxBytes)
    return fail('PHOTO_TOO_LARGE', 'The image is larger than allowed');
  const r =
    bytes[0] === 0xff && bytes[1] === 0xd8
      ? jpeg(bytes)
      : ascii(bytes, 0, 4) === 'RIFF' && ascii(bytes, 8, 4) === 'WEBP'
        ? webp(bytes)
        : fail('PHOTO_NOT_SUPPORTED', 'Only JPEG and WebP photos are accepted');
  if (!r.ok) return r;
  const { width, height } = r.value;
  if (width < 1 || height < 1 || width > limits.maxSide || height > limits.maxSide)
    return fail('PHOTO_DIMENSIONS', `Each side must be between 1 and ${limits.maxSide} pixels`);
  return r;
}

function ascii(b: Uint8Array, at: number, n: number): string {
  if (at + n > b.length) return '';
  return String.fromCharCode(...b.subarray(at, at + n));
}

const u16be = (b: Uint8Array, i: number) => (b[i]! << 8) | b[i + 1]!;
const u24le = (b: Uint8Array, i: number) => b[i]! | (b[i + 1]! << 8) | (b[i + 2]! << 16);
const u32le = (b: Uint8Array, i: number) =>
  (b[i]! | (b[i + 1]! << 8) | (b[i + 2]! << 16) | (b[i + 3]! << 24)) >>> 0;

// ---------------------------------------------------------------------------------------------
// JPEG: segments until EOI. APP0 (JFIF), APP2 (ICC colour profile) and APP14 (Adobe colour
// transform) are colour/format information and allowed; every other APPn (APP1 is EXIF/XMP,
// APP13 Photoshop/IPTC, ...) and comments (COM) are metadata and refused.

const SOF = new Set([0xc0, 0xc1, 0xc2, 0xc3, 0xc5, 0xc6, 0xc7, 0xc9, 0xca, 0xcb, 0xcd, 0xce, 0xcf]);
const ALLOWED_APP = new Set([0xe0, 0xe2, 0xee]);

function jpeg(b: Uint8Array): Inspection {
  let i = 2;
  let size: { width: number; height: number } | null = null;
  while (i < b.length) {
    if (b[i] !== 0xff) return MALFORMED();
    while (b[i] === 0xff) i++; // fill bytes
    if (i >= b.length) return MALFORMED();
    const marker = b[i++]!;
    if (marker === 0xd9) {
      // EOI: the image must be complete (frame and scan seen); trailing bytes are refused, as
      // they could carry appended data.
      if (!size || i !== b.length) return MALFORMED();
      return { ok: true, value: { type: 'image/jpeg', ...size } };
    }
    if (marker === 0x01 || (marker >= 0xd0 && marker <= 0xd7)) continue; // no length
    if (i + 2 > b.length) return MALFORMED();
    const len = u16be(b, i);
    if (len < 2 || i + len > b.length) return MALFORMED();
    if ((marker >= 0xe0 && marker <= 0xef && !ALLOWED_APP.has(marker)) || marker === 0xfe)
      return METADATA();
    if (SOF.has(marker)) {
      if (len < 8) return MALFORMED();
      size = { height: u16be(b, i + 3), width: u16be(b, i + 5) };
    }
    i += len;
    if (marker === 0xda) {
      // Entropy-coded data runs to the next marker that is not a stuffed 0xFF00 or a restart.
      if (!size) return MALFORMED();
      while (i < b.length) {
        if (b[i] === 0xff && i + 1 < b.length) {
          const next = b[i + 1]!;
          if (next !== 0x00 && !(next >= 0xd0 && next <= 0xd7) && next !== 0xff) break;
        }
        i++;
      }
    }
  }
  return MALFORMED();
}

// ---------------------------------------------------------------------------------------------
// WebP: RIFF chunks. Image data (VP8 or VP8L), its alpha (ALPH), the extended header (VP8X) and
// an ICC profile are allowed; EXIF and XMP chunks are metadata and refused, ANIM/ANMF animation.

const WEBP_ALLOWED = new Set(['VP8 ', 'VP8L', 'VP8X', 'ALPH', 'ICCP']);

function webp(b: Uint8Array): Inspection {
  if (b.length < 20 || u32le(b, 4) + 8 !== b.length) return MALFORMED();
  let i = 12;
  let size: { width: number; height: number } | null = null;
  let frames = 0;
  while (i < b.length) {
    if (i + 8 > b.length) return MALFORMED();
    const id = ascii(b, i, 4);
    const len = u32le(b, i + 4);
    const data = i + 8;
    if (data + len > b.length) return MALFORMED();
    if (id === 'EXIF' || id === 'XMP ') return METADATA();
    if (id === 'ANIM' || id === 'ANMF')
      return fail('PHOTO_ANIMATED', 'Animated images are not accepted');
    if (!WEBP_ALLOWED.has(id)) return MALFORMED();
    if (id === 'VP8X') {
      if (len < 10) return MALFORMED();
      const flags = b[data]!;
      if (flags & 0x02) return fail('PHOTO_ANIMATED', 'Animated images are not accepted');
      if (flags & 0x0c) return METADATA(); // EXIF (0x08) or XMP (0x04) flagged
      size = { width: u24le(b, data + 4) + 1, height: u24le(b, data + 7) + 1 };
    } else if (id === 'VP8 ') {
      frames++;
      if (len < 10 || b[data + 3] !== 0x9d || b[data + 4] !== 0x01 || b[data + 5] !== 0x2a)
        return MALFORMED();
      size ??= {
        width: (b[data + 6]! | (b[data + 7]! << 8)) & 0x3fff,
        height: (b[data + 8]! | (b[data + 9]! << 8)) & 0x3fff,
      };
    } else if (id === 'VP8L') {
      frames++;
      if (len < 5 || b[data] !== 0x2f) return MALFORMED();
      const bits = u32le(b, data + 1);
      size ??= { width: (bits & 0x3fff) + 1, height: ((bits >>> 14) & 0x3fff) + 1 };
    }
    i = data + len + (len & 1); // chunks are padded to an even length
  }
  if (frames !== 1 || !size) return MALFORMED();
  return { ok: true, value: { type: 'image/webp', ...size } };
}
