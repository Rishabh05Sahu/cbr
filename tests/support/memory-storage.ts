// In-memory ObjectStorage for integration tests (no network, no cloud). Mirrors the contract
// of the Supabase adapter: grants are per object and never overwrite, stat returns null for a
// missing object, download enforces the size cap, remove is idempotent. `browserPut` plays the
// browser's PUT to a grant URL; `tamper` lets a test swap an object's bytes behind the server.
import { StorageError, type ObjectStorage } from '@/platform/storage';

export interface MemoryStorage extends ObjectStorage {
  objects: Map<string, { body: Uint8Array; contentType: string }>;
  removed: string[];
  /** The key a grant URL is for. */
  keyOf(grantUrl: string): string;
  /** Uploads as the browser would with the grant (refuses a second upload to the same key). */
  browserPut(grantUrl: string, body: Uint8Array, contentType: string): void;
  tamper(key: string, body: Uint8Array): void;
}

const PREFIX = 'memory://upload/';

export function memoryStorage(): MemoryStorage {
  const objects = new Map<string, { body: Uint8Array; contentType: string }>();
  const removed: string[] = [];
  const keyOf = (url: string) => {
    if (!url.startsWith(PREFIX)) throw new Error('not a grant url');
    return decodeURIComponent(url.slice(PREFIX.length).split('?')[0]!);
  };
  return {
    objects,
    removed,
    keyOf,
    async createUploadGrant(key, contentType) {
      return {
        url: `${PREFIX}${encodeURIComponent(key)}?token=test-token`,
        method: 'PUT',
        headers: { 'content-type': contentType, 'x-upsert': 'false' },
        providerExpiresAt: new Date(Date.now() + 2 * 3600_000),
      };
    },
    browserPut(url, body, contentType) {
      const key = keyOf(url);
      if (objects.has(key)) throw new StorageError('ALREADY_EXISTS', 409);
      objects.set(key, { body, contentType });
    },
    tamper(key, body) {
      const o = objects.get(key);
      if (!o) throw new Error('no such object');
      objects.set(key, { ...o, body });
    },
    async put(key, body, contentType) {
      if (objects.has(key)) throw new StorageError('ALREADY_EXISTS', 409);
      objects.set(key, { body, contentType });
    },
    async stat(key) {
      const o = objects.get(key);
      return o ? { size: o.body.byteLength, contentType: o.contentType } : null;
    },
    async download(key, maxBytes) {
      const o = objects.get(key);
      if (!o) throw new StorageError('NOT_FOUND', 404);
      if (o.body.byteLength > maxBytes) throw new StorageError('TOO_LARGE', 413);
      return o.body;
    },
    async remove(keys) {
      for (const k of keys) {
        objects.delete(k);
        removed.push(k);
      }
    },
  };
}
