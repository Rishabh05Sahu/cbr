// FR-141: the structural photo check. Images are built byte by byte here (no decoder involved),
// so each rule is exercised exactly: what a canvas produces passes; metadata, animation, other
// formats, damage and appended bytes are refused.
import { describe, expect, it } from 'vitest';
import { inspectPhoto, PHOTO_LIMITS } from './photo-format';

const LIMITS = { maxBytes: PHOTO_LIMITS.maxBytes, maxSide: PHOTO_LIMITS.maxSide };
const bytes = (...parts: (number[] | Uint8Array)[]) =>
  Uint8Array.from(parts.flatMap((p) => [...p]));
const be16 = (n: number) => [(n >> 8) & 0xff, n & 0xff];
const le24 = (n: number) => [n & 0xff, (n >> 8) & 0xff, (n >> 16) & 0xff];
const le32 = (n: number) => [n & 0xff, (n >> 8) & 0xff, (n >> 16) & 0xff, (n >>> 24) & 0xff];
const ascii = (s: string) => [...s].map((c) => c.charCodeAt(0));

/** A JPEG marker segment: FF, marker, length (including itself), payload. */
const seg = (marker: number, payload: number[]) => [
  0xff,
  marker,
  ...be16(payload.length + 2),
  ...payload,
];
const APP0 = seg(0xe0, [...ascii('JFIF'), 0, 1, 1, 0, 0, 1, 0, 1, 0, 0]);
const sof = (w: number, h: number) => seg(0xc0, [8, ...be16(h), ...be16(w), 1, 1, 0x11, 0]);
const SOS = seg(0xda, [1, 1, 0, 0, 0x3f, 0]);
// Entropy-coded data with a stuffed FF00 and a restart marker, then EOI.
const SCAN = [0x12, 0xff, 0x00, 0x34, 0xff, 0xd0, 0x56];
const EOI = [0xff, 0xd9];
const jpeg = (...middle: number[][]) =>
  bytes([0xff, 0xd8], APP0, ...middle, sof(1600, 1200), SOS, SCAN, EOI);

/** A RIFF/WEBP file from chunks (each padded to even length). */
const chunk = (id: string, data: number[]) => [
  ...ascii(id),
  ...le32(data.length),
  ...data,
  ...(data.length & 1 ? [0] : []),
];
const riff = (...chunks: number[][]) => {
  const body = [...ascii('WEBP'), ...chunks.flat()];
  return bytes(ascii('RIFF'), le32(body.length), body);
};
/** VP8L: signature 0x2f, then width-1 (14 bits) and height-1 (14 bits), then data. */
const vp8l = (w: number, h: number) =>
  chunk('VP8L', [0x2f, ...le32(((w - 1) & 0x3fff) | (((h - 1) & 0x3fff) << 14)), 0, 0, 0]);
/** VP8 (lossy): frame tag, start code 9D 01 2A, 14-bit width and height. */
const vp8 = (w: number, h: number) =>
  chunk('VP8 ', [
    0,
    0,
    0,
    0x9d,
    0x01,
    0x2a,
    w & 0xff,
    (w >> 8) & 0x3f,
    h & 0xff,
    (h >> 8) & 0x3f,
    0,
    0,
  ]);
const vp8x = (flags: number, w: number, h: number) =>
  chunk('VP8X', [flags, 0, 0, 0, ...le24(w - 1), ...le24(h - 1)]);

describe('inspectPhoto: JPEG', () => {
  it('accepts a canvas-style JPEG and reads its size', () => {
    expect(inspectPhoto(jpeg(), LIMITS)).toEqual({
      ok: true,
      value: { type: 'image/jpeg', width: 1600, height: 1200 },
    });
  });
  it('allows colour information (ICC profile, Adobe)', () => {
    expect(
      inspectPhoto(jpeg(seg(0xe2, ascii('ICC_PROFILE')), seg(0xee, ascii('Adobe'))), LIMITS),
    ).toMatchObject({ ok: true });
  });
  it.each([
    ['EXIF (APP1, where GPS lives)', seg(0xe1, [...ascii('Exif'), 0, 0, 1, 2, 3])],
    ['XMP (APP1)', seg(0xe1, ascii('http://ns.adobe.com/xap/1.0/'))],
    ['Photoshop/IPTC (APP13)', seg(0xed, ascii('Photoshop 3.0'))],
    ['a comment', seg(0xfe, ascii('taken at ...'))],
  ])('refuses %s', (_, s) => {
    expect(inspectPhoto(jpeg(s), LIMITS)).toMatchObject({ ok: false, code: 'PHOTO_HAS_METADATA' });
  });
  it('refuses bytes appended after the image', () => {
    const appended = bytes(jpeg(), [0x50, 0x4b, 0x03, 0x04]);
    expect(inspectPhoto(appended, LIMITS)).toMatchObject({ ok: false, code: 'PHOTO_MALFORMED' });
  });
  it('refuses a cut-off file and a scan without a frame header', () => {
    const full = jpeg();
    expect(inspectPhoto(full.subarray(0, full.length - 3), LIMITS)).toMatchObject({
      ok: false,
      code: 'PHOTO_MALFORMED',
    });
    expect(inspectPhoto(bytes([0xff, 0xd8], APP0, SOS, SCAN, EOI), LIMITS)).toMatchObject({
      ok: false,
      code: 'PHOTO_MALFORMED',
    });
  });
  it('refuses a side above the limit', () => {
    const big = bytes([0xff, 0xd8], APP0, sof(5000, 1000), SOS, SCAN, EOI);
    expect(inspectPhoto(big, LIMITS)).toMatchObject({ ok: false, code: 'PHOTO_DIMENSIONS' });
  });
});

describe('inspectPhoto: WebP', () => {
  it('accepts lossless and lossy still images and reads their size', () => {
    expect(inspectPhoto(riff(vp8l(2048, 1536)), LIMITS)).toEqual({
      ok: true,
      value: { type: 'image/webp', width: 2048, height: 1536 },
    });
    expect(inspectPhoto(riff(vp8(800, 600)), LIMITS)).toMatchObject({
      ok: true,
      value: { width: 800, height: 600 },
    });
    expect(
      inspectPhoto(riff(vp8x(0x10, 640, 480), chunk('ALPH', [0, 1]), vp8l(640, 480)), LIMITS),
    ).toMatchObject({ ok: true, value: { width: 640, height: 480 } });
  });
  it('refuses EXIF and XMP chunks, and an extended header that announces them', () => {
    for (const file of [
      riff(vp8l(10, 10), chunk('EXIF', [1, 2, 3, 4])),
      riff(vp8l(10, 10), chunk('XMP ', [1, 2])),
      riff(vp8x(0x08, 10, 10), vp8l(10, 10)),
      riff(vp8x(0x04, 10, 10), vp8l(10, 10)),
    ])
      expect(inspectPhoto(file, LIMITS)).toMatchObject({ ok: false, code: 'PHOTO_HAS_METADATA' });
  });
  it('refuses animation', () => {
    expect(inspectPhoto(riff(vp8x(0x02, 10, 10), vp8l(10, 10)), LIMITS)).toMatchObject({
      ok: false,
      code: 'PHOTO_ANIMATED',
    });
    expect(
      inspectPhoto(riff(chunk('ANIM', [0, 0, 0, 0, 0, 0]), vp8l(10, 10)), LIMITS),
    ).toMatchObject({ ok: false, code: 'PHOTO_ANIMATED' });
  });
  it('refuses a wrong RIFF size, unknown chunks and two images', () => {
    const ok = riff(vp8l(10, 10));
    expect(inspectPhoto(bytes(ok, [0, 0]), LIMITS)).toMatchObject({ code: 'PHOTO_MALFORMED' });
    expect(inspectPhoto(riff(vp8l(10, 10), chunk('ZZZZ', [1, 2])), LIMITS)).toMatchObject({
      code: 'PHOTO_MALFORMED',
    });
    expect(inspectPhoto(riff(vp8l(10, 10), vp8l(10, 10)), LIMITS)).toMatchObject({
      code: 'PHOTO_MALFORMED',
    });
  });
});

describe('inspectPhoto: everything else', () => {
  it('refuses other formats, empty files and files over the size limit', () => {
    const png = bytes([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a, 0, 0, 0, 0]);
    expect(inspectPhoto(png, LIMITS)).toMatchObject({ code: 'PHOTO_NOT_SUPPORTED' });
    expect(inspectPhoto(bytes(ascii('<svg/>')), LIMITS)).toMatchObject({
      code: 'PHOTO_NOT_SUPPORTED',
    });
    expect(inspectPhoto(new Uint8Array(0), LIMITS)).toMatchObject({ code: 'PHOTO_EMPTY' });
    expect(inspectPhoto(jpeg(), { maxBytes: 10, maxSide: 4096 })).toMatchObject({
      code: 'PHOTO_TOO_LARGE',
    });
  });
});
