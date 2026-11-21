// Object keys for tenant files. The server builds every key from ids it owns (the session's org
// and a record it created) plus 128 random bits; the original filename is never part of a key.
// Cleanup parses a key back and deletes only when it names the expected org and record.
import { randomBytes } from 'node:crypto';
import { z } from 'zod';

export type ObjectKind = 'imports' | 'exports' | 'property-photos';
export type ObjectExt = 'csv' | 'xlsx' | 'jpg' | 'webp';

export interface ObjectKey {
  orgId: string;
  kind: ObjectKind;
  recordId: string;
  ext: ObjectExt;
}

const KEY =
  /^orgs\/([0-9a-f-]{36})\/(imports|exports|property-photos)\/([0-9a-f-]{36})\/([0-9a-f]{32})\.(csv|xlsx|jpg|webp)$/;
const uuid = z.uuid();
/**
 * Each kind has its own file types: imports CSV or XLSX, exports CSV only (mirrors
 * export_job_storage_key in 0006), property photos JPEG or WebP (mirrors property_photo in 0030).
 */
const EXTS: Record<ObjectKind, readonly ObjectExt[]> = {
  imports: ['csv', 'xlsx'],
  exports: ['csv'],
  'property-photos': ['jpg', 'webp'],
};
const allowedExt = (kind: ObjectKind, ext: ObjectExt) => EXTS[kind].includes(ext);

export function objectKeyFor(
  orgId: string,
  kind: ObjectKind,
  recordId: string,
  ext: ObjectExt,
): string {
  if (!uuid.safeParse(orgId).success || !uuid.safeParse(recordId).success)
    throw new TypeError('object keys need server-issued UUIDs');
  if (!allowedExt(kind, ext)) throw new TypeError(`${kind} keys cannot be .${ext}`);
  return `orgs/${orgId}/${kind}/${recordId}/${randomBytes(16).toString('hex')}.${ext}`;
}

/** Null for anything that is not exactly a key this module could have produced. */
export function parseObjectKey(key: string): ObjectKey | null {
  const m = KEY.exec(key);
  if (!m) return null;
  const [, orgId, kind, recordId, , ext] = m;
  if (!uuid.safeParse(orgId).success || !uuid.safeParse(recordId).success) return null;
  if (!allowedExt(kind as ObjectKind, ext as ObjectExt)) return null;
  return {
    orgId: orgId!,
    kind: kind as ObjectKind,
    recordId: recordId!,
    ext: ext as ObjectExt,
  };
}

/** True only when `key` is well formed and belongs to this org, kind and record. */
export function keyBelongsTo(key: string, orgId: string, kind: ObjectKind, recordId: string) {
  const k = parseObjectKey(key);
  return !!k && k.orgId === orgId && k.kind === kind && k.recordId === recordId;
}
