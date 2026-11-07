// Minimal, bounds-checked ZIP reader for XLSX safety checks (threat model T6). It lists the
// central directory and inflates entries with node:zlib under a hard output cap, so a zip bomb
// or an entry whose real size differs from its declared size is caught before any spreadsheet
// parser sees the file. It never writes to disk and never follows paths.
import { inflateRawSync } from 'node:zlib';

export interface ZipEntry {
  name: string;
  method: number;
  encrypted: boolean;
  compressedSize: number;
  uncompressedSize: number;
  localHeaderOffset: number;
}

export class ZipFormatError extends Error {
  override readonly name = 'ZipFormatError';
}

const EOCD_SIG = 0x06054b50;
const CDH_SIG = 0x02014b50;
const LFH_SIG = 0x04034b50;

/** Lists entries from the central directory. Throws ZipFormatError on anything malformed. */
export function listZipEntries(bytes: Uint8Array, maxEntries: number): ZipEntry[] {
  const view = new DataView(bytes.buffer, bytes.byteOffset, bytes.byteLength);
  const len = bytes.byteLength;
  if (len < 22) throw new ZipFormatError('too short');
  let eocd = -1;
  for (let i = len - 22; i >= Math.max(0, len - 22 - 0xffff); i--) {
    if (view.getUint32(i, true) === EOCD_SIG) {
      eocd = i;
      break;
    }
  }
  if (eocd < 0) throw new ZipFormatError('no end of central directory');
  const count = view.getUint16(eocd + 10, true);
  const cdSize = view.getUint32(eocd + 12, true);
  const cdOffset = view.getUint32(eocd + 16, true);
  if (count === 0xffff || cdSize === 0xffffffff || cdOffset === 0xffffffff)
    throw new ZipFormatError('zip64 not supported');
  if (count > maxEntries) throw new ZipFormatError('too many entries');
  if (cdOffset + cdSize > eocd) throw new ZipFormatError('central directory out of range');

  const entries: ZipEntry[] = [];
  let p = cdOffset;
  for (let n = 0; n < count; n++) {
    if (p + 46 > eocd || view.getUint32(p, true) !== CDH_SIG)
      throw new ZipFormatError('bad central directory entry');
    const flags = view.getUint16(p + 8, true);
    const nameLen = view.getUint16(p + 28, true);
    const extraLen = view.getUint16(p + 30, true);
    const commentLen = view.getUint16(p + 32, true);
    if (p + 46 + nameLen > eocd) throw new ZipFormatError('name out of range');
    const nameBytes = bytes.subarray(p + 46, p + 46 + nameLen);
    entries.push({
      name: new TextDecoder(flags & 0x800 ? 'utf-8' : 'latin1').decode(nameBytes),
      method: view.getUint16(p + 10, true),
      encrypted: (flags & 0x1) !== 0,
      compressedSize: view.getUint32(p + 20, true),
      uncompressedSize: view.getUint32(p + 24, true),
      localHeaderOffset: view.getUint32(p + 42, true),
    });
    p += 46 + nameLen + extraLen + commentLen;
  }
  return entries;
}

/** Inflates one entry, refusing output beyond its declared size (and `maxOut`). */
export function readZipEntry(bytes: Uint8Array, entry: ZipEntry, maxOut: number): Uint8Array {
  const view = new DataView(bytes.buffer, bytes.byteOffset, bytes.byteLength);
  const o = entry.localHeaderOffset;
  if (o + 30 > bytes.byteLength || view.getUint32(o, true) !== LFH_SIG)
    throw new ZipFormatError('bad local header');
  const start = o + 30 + view.getUint16(o + 26, true) + view.getUint16(o + 28, true);
  const end = start + entry.compressedSize;
  if (end > bytes.byteLength) throw new ZipFormatError('entry data out of range');
  if (entry.encrypted) throw new ZipFormatError('encrypted entry');
  const limit = Math.min(entry.uncompressedSize, maxOut);
  const data = bytes.subarray(start, end);
  let out: Uint8Array;
  if (entry.method === 0) out = data;
  else if (entry.method === 8) {
    try {
      out = inflateRawSync(data, { maxOutputLength: Math.max(1, limit) });
    } catch {
      throw new ZipFormatError('entry inflates beyond its declared size or is corrupt');
    }
  } else throw new ZipFormatError('unsupported compression method');
  if (out.byteLength !== entry.uncompressedSize || out.byteLength > maxOut)
    throw new ZipFormatError('entry size differs from its declared size');
  return out;
}
