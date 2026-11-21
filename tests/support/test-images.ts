// Tiny synthetic images for FR-141 tests, built byte by byte: structurally valid (they pass the
// server's photo check), but not real pictures. `exif` adds an EXIF block, which must be refused.
const be16 = (n: number) => [(n >> 8) & 0xff, n & 0xff];
const le32 = (n: number) => [n & 0xff, (n >> 8) & 0xff, (n >> 16) & 0xff, (n >>> 24) & 0xff];
const ascii = (s: string) => [...s].map((c) => c.charCodeAt(0));
const seg = (marker: number, payload: number[]) => [
  0xff,
  marker,
  ...be16(payload.length + 2),
  ...payload,
];

/** A JPEG of the given size (header only; the scan is a few placeholder bytes). */
export function testJpeg(
  width: number,
  height: number,
  opts: { exif?: boolean } = {},
): Uint8Array<ArrayBuffer> {
  return new Uint8Array([
    0xff,
    0xd8,
    ...seg(0xe0, [...ascii('JFIF'), 0, 1, 1, 0, 0, 1, 0, 1, 0, 0]),
    ...(opts.exif ? seg(0xe1, [...ascii('Exif'), 0, 0, ...ascii('GPS 25.2,55.3')]) : []),
    ...seg(0xc0, [8, ...be16(height), ...be16(width), 1, 1, 0x11, 0]),
    ...seg(0xda, [1, 1, 0, 0, 0x3f, 0]),
    0x12,
    0x34,
    0x56,
    0xff,
    0xd9,
  ]);
}

/** A lossless WebP of the given size. */
export function testWebp(width: number, height: number): Uint8Array<ArrayBuffer> {
  const data = [0x2f, ...le32(((width - 1) & 0x3fff) | (((height - 1) & 0x3fff) << 14)), 0, 0, 0];
  const chunk = [...ascii('VP8L'), ...le32(data.length), ...data, ...(data.length & 1 ? [0] : [])];
  const body = [...ascii('WEBP'), ...chunk];
  return new Uint8Array([...ascii('RIFF'), ...le32(body.length), ...body]);
}
