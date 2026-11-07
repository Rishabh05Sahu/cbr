// Storage contract and sanitised errors, shared by the adapters and the facade (./index.ts).
export interface UploadGrant {
  /** PUT target. Contains a single-use token: never log it or store it. */
  url: string;
  method: 'PUT';
  /** Headers the browser must send with the PUT. */
  headers: Record<string, string>;
  /** When the provider stops accepting the token (Supabase: 2 hours, not configurable). */
  providerExpiresAt: Date;
}

export interface StoredObject {
  size: number;
  contentType: string | null;
}

export interface ObjectStorage {
  /** Signed, object-specific upload permission. Never overwrites an existing object. */
  createUploadGrant(key: string, contentType: string): Promise<UploadGrant>;
  /** Controlled server-side upload (reports, tests). Never overwrites. */
  put(key: string, body: Uint8Array, contentType: string): Promise<void>;
  /** Metadata, or null when the object does not exist. */
  stat(key: string): Promise<StoredObject | null>;
  /** Whole object, refused when larger than `maxBytes` (checked before and after download). */
  download(key: string, maxBytes: number): Promise<Uint8Array>;
  /** Deletes objects; missing objects are not an error (idempotent cleanup). */
  remove(keys: string[]): Promise<void>;
}

export type StorageErrorCode =
  'NOT_CONFIGURED' | 'NOT_FOUND' | 'ALREADY_EXISTS' | 'TOO_LARGE' | 'REJECTED' | 'UNAVAILABLE';

const MESSAGES: Record<StorageErrorCode, string> = {
  NOT_CONFIGURED: 'File storage is not configured',
  NOT_FOUND: 'The file was not found in storage',
  ALREADY_EXISTS: 'A file already exists at this location',
  TOO_LARGE: 'The file is larger than the allowed size',
  REJECTED: 'File storage refused the request',
  UNAVAILABLE: 'File storage is temporarily unavailable; try again shortly',
};

/**
 * Sanitised storage failure. The message is fixed per code and `status` is the provider's HTTP
 * status: provider messages, URLs, tokens, keys and file contents are never carried, so the
 * error is safe to log and to show.
 */
export class StorageError extends Error {
  override readonly name = 'StorageError';
  constructor(
    readonly code: StorageErrorCode,
    readonly status?: number,
  ) {
    super(MESSAGES[code]);
  }
  /** Worth retrying later (the job layer decides; the adapter already retried briefly). */
  get transient(): boolean {
    return this.code === 'UNAVAILABLE';
  }
}

export interface StorageConfig {
  url: string;
  serviceKey: string;
  bucket: string;
  /** Per-request timeout. */
  timeoutMs?: number;
  /** Attempts for idempotent operations (1 = no retry). */
  attempts?: number;
  fetch?: typeof fetch;
}
