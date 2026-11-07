// Private object storage for tenant files (Phase 2 M4: import uploads). Server-side only: the
// web server and the worker use it; browsers only ever receive one short-lived, object-specific
// upload URL. The provider (Supabase Storage today) sits behind this interface so it can be
// swapped for another S3-compatible store without touching the import module.
import { serverEnv } from '@/env';
import { createSupabaseStorage } from './supabase';
import { StorageError, type ObjectStorage } from './types';

export {
  keyBelongsTo,
  objectKeyFor,
  parseObjectKey,
  type ObjectKey,
  type ObjectKind,
} from './keys';

export {
  StorageError,
  type ObjectStorage,
  type StorageConfig,
  type StorageErrorCode,
  type StoredObject,
  type UploadGrant,
} from './types';

let cached: ObjectStorage | undefined;

export function isStorageConfigured(): boolean {
  const env = serverEnv();
  return Boolean(env.SUPABASE_URL && env.SUPABASE_SERVICE_ROLE_KEY);
}

/** The import bucket, configured from the server environment. */
export function importStorage(): ObjectStorage {
  if (typeof window !== 'undefined') throw new StorageError('NOT_CONFIGURED');
  if (cached) return cached;
  const env = serverEnv();
  if (!env.SUPABASE_URL || !env.SUPABASE_SERVICE_ROLE_KEY) throw new StorageError('NOT_CONFIGURED');
  cached = createSupabaseStorage({
    url: env.SUPABASE_URL,
    serviceKey: env.SUPABASE_SERVICE_ROLE_KEY,
    bucket: env.SUPABASE_IMPORT_BUCKET,
  });
  return cached;
}

/**
 * Lead export files (Phase 2 M5): the same private bucket, under the distinct
 * orgs/<org>/exports/<job>/ prefix (objectKeyFor(..., 'exports', ...)). Never handed to browsers:
 * downloads are streamed by the server after a single-use claim.
 */
export const exportStorage = importStorage;

/** Origin the browser uploads to (for the CSP connect-src), or null when not configured. */
export function storageUploadOrigin(url: string | undefined): string | null {
  if (!url) return null;
  try {
    return new URL(url).origin;
  } catch {
    return null;
  }
}
