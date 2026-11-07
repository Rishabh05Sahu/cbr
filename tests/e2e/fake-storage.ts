// Local stand-in for the Supabase Storage REST API, for the e2e suite only (no cloud, no
// charges). It implements the calls the storage adapter and a browser make:
//   POST   /storage/v1/object/upload/sign/{bucket}/{key}   service key → single-use token URL
//   PUT    /storage/v1/object/upload/sign/{bucket}/{key}?token=…   browser upload, no key
//   GET    /storage/v1/object/info/{bucket}/{key}          service key → size, content type
//   GET    /storage/v1/object/{bucket}/{key}               service key → bytes
//   DELETE /storage/v1/object/{bucket}  {prefixes:[…]}     service key → idempotent delete
// It enforces what the real bucket would: the service key on server calls, a private bucket
// (no anonymous reads), tokens bound to one key and usable once, and no overwrite.
// Optional `allowedOrigin` (local browser testing only, scripts/dev/import-browser-test.mts): a
// real browser's cross-origin upload PUT, preflight included, is accepted from exactly that one
// origin; any request carrying another Origin is refused without CORS headers. Off by default,
// so the e2e suite (server-side calls, no Origin) behaves exactly as before.
import { randomBytes } from 'node:crypto';
import { createServer, type Server } from 'node:http';

export const E2E_STORAGE_PORT = 3199;
export const E2E_STORAGE_URL = `http://127.0.0.1:${E2E_STORAGE_PORT}`;
/** A fake key that only this server accepts (looks like a secret key; is not one). */
export const E2E_STORAGE_KEY = 'sb_secret_E2E_local_fake_only_0123456789abcdef';
export const E2E_BUCKET = 'crm-imports';

export interface FakeStorage {
  server: Server;
  objects: Map<string, { body: Buffer; contentType: string }>;
  close(): Promise<void>;
}

export interface FakeStorageOptions {
  /** The one browser origin allowed to upload, e.g. 'http://localhost:3100'. No wildcards. */
  allowedOrigin?: string;
  /** Listening port on 127.0.0.1 (default E2E_STORAGE_PORT; 0 picks a free port, for tests). */
  port?: number;
}

/** Headers the browser upload sends (src/platform/storage/supabase.ts createUploadGrant). */
const UPLOAD_HEADERS = ['content-type', 'x-upsert'];

function exactOrigin(origin: string): string {
  const u = new URL(origin);
  if (!/^https?:$/.test(u.protocol) || u.origin !== origin)
    throw new Error('allowedOrigin must be an exact origin such as http://localhost:3100');
  return origin;
}

export async function startFakeStorage(opts: FakeStorageOptions = {}): Promise<FakeStorage> {
  const allowedOrigin =
    opts.allowedOrigin === undefined ? undefined : exactOrigin(opts.allowedOrigin);
  const objects = new Map<string, { body: Buffer; contentType: string }>();
  const tokens = new Map<string, string>(); // token → key
  const server = createServer(async (req, res) => {
    const url = new URL(req.url ?? '/', E2E_STORAGE_URL);
    const path = decodeURIComponent(url.pathname.replace(/^\/storage\/v1/, ''));
    const isUploadPath = path.startsWith(`/object/upload/sign/${E2E_BUCKET}/`);
    if (allowedOrigin !== undefined) {
      const origin = req.headers.origin;
      if (origin !== undefined && origin !== allowedOrigin) {
        // Another site: refused, and no CORS headers, so its browser cannot read anything.
        res.writeHead(403, { 'content-type': 'application/json' });
        return res.end(JSON.stringify({ statusCode: '403', message: 'origin not allowed' }));
      }
      if (req.method === 'OPTIONS') {
        const method = req.headers['access-control-request-method'];
        const asked = String(req.headers['access-control-request-headers'] ?? '')
          .split(',')
          .map((h) => h.trim().toLowerCase())
          .filter(Boolean);
        if (
          origin !== allowedOrigin ||
          !isUploadPath ||
          method !== 'PUT' ||
          asked.some((h) => !UPLOAD_HEADERS.includes(h))
        ) {
          res.writeHead(403, { vary: 'Origin' });
          return res.end();
        }
        res.writeHead(204, {
          'access-control-allow-origin': allowedOrigin,
          'access-control-allow-methods': 'PUT',
          'access-control-allow-headers': UPLOAD_HEADERS.join(', '),
          'access-control-max-age': '600',
          vary: 'Origin',
        });
        return res.end();
      }
      // The browser may read the upload's response; nothing else is ever exposed to it.
      if (origin === allowedOrigin && req.method === 'PUT' && isUploadPath) {
        res.setHeader('access-control-allow-origin', allowedOrigin);
        res.setHeader('vary', 'Origin');
      }
    }
    const chunks: Buffer[] = [];
    for await (const c of req) chunks.push(c as Buffer);
    const body = Buffer.concat(chunks);
    const json = (status: number, v: unknown) => {
      res.writeHead(status, { 'content-type': 'application/json' });
      res.end(JSON.stringify(v));
    };
    const notFound = () =>
      json(400, { statusCode: '404', error: 'not_found', message: 'Object not found' });
    const authed = req.headers.authorization === `Bearer ${E2E_STORAGE_KEY}`;
    const bucketKey = (prefix: string) => {
      const rest = path.slice(prefix.length);
      if (!rest.startsWith(`${E2E_BUCKET}/`)) return null;
      return rest.slice(E2E_BUCKET.length + 1);
    };
    let key: string | null;

    if (req.method === 'PUT' && (key = bucketKey('/object/upload/sign/'))) {
      const token = url.searchParams.get('token') ?? '';
      if (tokens.get(token) !== key)
        return json(400, { statusCode: '403', message: 'invalid token' });
      if (objects.has(key)) return json(400, { statusCode: '409', message: 'Duplicate' });
      tokens.delete(token);
      objects.set(key, { body, contentType: String(req.headers['content-type'] ?? '') });
      return json(200, { Key: `${E2E_BUCKET}/${key}` });
    }
    if (!authed) return json(400, { statusCode: '403', message: 'unauthorized' });
    if (req.method === 'POST' && (key = bucketKey('/object/upload/sign/'))) {
      const token = randomBytes(16).toString('hex');
      tokens.set(token, key);
      return json(200, {
        url: `/object/upload/sign/${E2E_BUCKET}/${encodeURI(key)}?token=${token}`,
      });
    }
    if (req.method === 'POST' && (key = bucketKey('/object/'))) {
      // Server-side upload (adapter put), never an overwrite.
      if (objects.has(key)) return json(400, { statusCode: '409', message: 'Duplicate' });
      objects.set(key, { body, contentType: String(req.headers['content-type'] ?? '') });
      return json(200, { Key: `${E2E_BUCKET}/${key}` });
    }
    if (req.method === 'GET' && (key = bucketKey('/object/info/'))) {
      const o = objects.get(key);
      return o
        ? json(200, { name: key, size: o.body.length, content_type: o.contentType })
        : notFound();
    }
    if (
      req.method === 'GET' &&
      (key = bucketKey('/object/authenticated/') ?? bucketKey('/object/'))
    ) {
      const o = objects.get(key);
      if (!o) return notFound();
      res.writeHead(200, { 'content-type': o.contentType });
      return res.end(o.body);
    }
    if (req.method === 'DELETE' && path === `/object/${E2E_BUCKET}`) {
      const { prefixes } = JSON.parse(body.toString() || '{}') as { prefixes?: string[] };
      for (const p of prefixes ?? []) objects.delete(p);
      return json(200, []);
    }
    return json(400, { statusCode: '404', message: 'unknown route' });
  });
  return new Promise((resolve) =>
    server.listen(opts.port ?? E2E_STORAGE_PORT, '127.0.0.1', () =>
      resolve({
        server,
        objects,
        close: () => new Promise<void>((r) => server.close(() => r())),
      }),
    ),
  );
}
