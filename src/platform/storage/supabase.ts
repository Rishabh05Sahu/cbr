// Supabase Storage adapter. Uses the service-role key, so it must only ever run on the server
// (web or worker); browsers receive signed, single-object upload URLs instead. Every request has
// a timeout, idempotent operations get a few quick retries, and provider errors are reduced to a
// StorageError code before they leave this file (no provider text, URL, token or key).
import { createClient } from '@supabase/supabase-js';
import {
  StorageError,
  type ObjectStorage,
  type StorageConfig,
  type StorageErrorCode,
  type UploadGrant,
} from './types';

/** Supabase signed upload URLs are valid for 2 hours; the API offers no shorter lifetime. */
export const SUPABASE_UPLOAD_TOKEN_TTL_MS = 2 * 60 * 60 * 1000;
const DEFAULT_TIMEOUT_MS = 15_000;
const DEFAULT_ATTEMPTS = 3;
const REMOVE_BATCH = 1000;

function withTimeout(base: typeof fetch, timeoutMs: number): typeof fetch {
  return (input, init) => {
    const timeout = AbortSignal.timeout(timeoutMs);
    const signal = init?.signal ? AbortSignal.any([init.signal, timeout]) : timeout;
    return base(input, { ...init, signal });
  };
}

/** Provider status: storage-js reports some API errors as HTTP 400 with the real code in `statusCode`. */
function statusOf(err: unknown): number | undefined {
  const e = err as { statusCode?: unknown; status?: unknown; originalError?: { status?: unknown } };
  const sc = Number(e?.statusCode);
  if (Number.isInteger(sc) && sc >= 100) return sc;
  if (typeof e?.status === 'number') return e.status;
  if (typeof e?.originalError?.status === 'number') return e.originalError.status;
  return undefined;
}

export function toStorageError(err: unknown): StorageError {
  if (err instanceof StorageError) return err;
  const status = statusOf(err);
  let code: StorageErrorCode;
  if (status === undefined || status === 429 || status >= 500) code = 'UNAVAILABLE';
  else if (status === 404) code = 'NOT_FOUND';
  else if (status === 409) code = 'ALREADY_EXISTS';
  else if (status === 413) code = 'TOO_LARGE';
  else code = 'REJECTED';
  return new StorageError(code, status);
}

async function attempt<T>(attempts: number, op: () => Promise<T>): Promise<T> {
  for (let i = 1; ; i++) {
    try {
      return await op();
    } catch (e) {
      const err = toStorageError(e);
      if (!err.transient || i >= attempts) throw err;
      await new Promise((r) => setTimeout(r, 200 * 2 ** (i - 1)));
    }
  }
}

/** storage-js returns `{ data, error }`; turn an error into a throw so `attempt` can see it. */
function unwrap<T>(res: { data: T | null; error: unknown }): T {
  if (res.error) throw res.error;
  if (res.data === null) throw new StorageError('UNAVAILABLE');
  return res.data;
}

export function createSupabaseStorage(config: StorageConfig): ObjectStorage {
  const attempts = Math.max(1, config.attempts ?? DEFAULT_ATTEMPTS);
  const client = createClient(config.url, config.serviceKey, {
    auth: { persistSession: false, autoRefreshToken: false, detectSessionInUrl: false },
    global: { fetch: withTimeout(config.fetch ?? fetch, config.timeoutMs ?? DEFAULT_TIMEOUT_MS) },
  });
  const bucket = () => client.storage.from(config.bucket);

  const stat: ObjectStorage['stat'] = async (key) => {
    try {
      const info = await attempt(attempts, async () => unwrap(await bucket().info(key)));
      return { size: Number(info.size ?? NaN), contentType: info.contentType ?? null };
    } catch (e) {
      const err = toStorageError(e);
      // Supabase answers a missing object with 400 "Object not found" on some versions.
      if (err.code === 'NOT_FOUND' || (err.code === 'REJECTED' && err.status === 400)) return null;
      throw err;
    }
  };

  return {
    async createUploadGrant(key, contentType): Promise<UploadGrant> {
      const issuedAt = Date.now();
      const data = await attempt(attempts, async () =>
        unwrap(await bucket().createSignedUploadUrl(key, { upsert: false })),
      );
      return {
        url: data.signedUrl,
        method: 'PUT',
        headers: { 'content-type': contentType, 'x-upsert': 'false' },
        providerExpiresAt: new Date(issuedAt + SUPABASE_UPLOAD_TOKEN_TTL_MS),
      };
    },

    async put(key, body, contentType) {
      // Not retried: a lost response after a successful write would turn into ALREADY_EXISTS.
      await attempt(1, async () =>
        unwrap(await bucket().upload(key, body, { contentType, upsert: false })),
      );
    },

    stat,

    async download(key, maxBytes) {
      const meta = await stat(key);
      if (!meta) throw new StorageError('NOT_FOUND');
      if (!(meta.size <= maxBytes)) throw new StorageError('TOO_LARGE');
      const blob = await attempt(attempts, async () => unwrap(await bucket().download(key)));
      if (blob.size > maxBytes) throw new StorageError('TOO_LARGE');
      return new Uint8Array(await blob.arrayBuffer());
    },

    async remove(keys) {
      for (let i = 0; i < keys.length; i += REMOVE_BATCH) {
        const batch = keys.slice(i, i + REMOVE_BATCH);
        await attempt(attempts, async () => unwrap(await bucket().remove(batch)));
      }
    },
  };
}
