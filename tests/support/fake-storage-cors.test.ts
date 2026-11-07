// The e2e fake Supabase Storage (tests/e2e/fake-storage.ts) with and without the opt-in CORS
// support used for local browser testing of imports. Runs in the unit project on a free port.
import { request } from 'node:http';
import type { AddressInfo } from 'node:net';
import { afterEach, describe, expect, it } from 'vitest';
import {
  E2E_BUCKET,
  E2E_STORAGE_KEY,
  startFakeStorage,
  type FakeStorage,
} from '../e2e/fake-storage';

const ALLOWED = 'http://localhost:3100';
const KEY = 'orgs/00000000-0000-0000-0000-000000000001/imports/job/file.csv';
let fake: FakeStorage | undefined;

afterEach(async () => {
  await fake?.close();
  fake = undefined;
});

interface Reply {
  status: number;
  headers: Record<string, string | string[] | undefined>;
  body: string;
}

function send(
  method: string,
  path: string,
  headers: Record<string, string> = {},
  body?: string,
): Promise<Reply> {
  const { port } = fake!.server.address() as AddressInfo;
  return new Promise((resolve, reject) => {
    const req = request({ host: '127.0.0.1', port, method, path, headers }, (res) => {
      let text = '';
      res.on('data', (c) => (text += c));
      res.on('end', () =>
        resolve({ status: res.statusCode ?? 0, headers: res.headers, body: text }),
      );
    });
    req.on('error', reject);
    if (body !== undefined) req.write(body);
    req.end();
  });
}

/** Server-side signing (service key, no Origin), as the storage adapter does. */
async function signedUploadPath(key = KEY): Promise<string> {
  const r = await send('POST', `/storage/v1/object/upload/sign/${E2E_BUCKET}/${key}`, {
    authorization: `Bearer ${E2E_STORAGE_KEY}`,
  });
  expect(r.status).toBe(200);
  return `/storage/v1${(JSON.parse(r.body) as { url: string }).url}`;
}

const preflight = (path: string, origin: string, headers = 'content-type,x-upsert') =>
  send('OPTIONS', path, {
    origin,
    'access-control-request-method': 'PUT',
    'access-control-request-headers': headers,
  });

const upload = (path: string, origin?: string) =>
  send(
    'PUT',
    path,
    { 'content-type': 'text/csv', 'x-upsert': 'false', ...(origin ? { origin } : {}) },
    'Name,Phone\nSynthetic One,9876543210\n',
  );

describe('fake storage with allowedOrigin', () => {
  it('answers the preflight from the allowed origin with the minimum CORS headers', async () => {
    fake = await startFakeStorage({ allowedOrigin: ALLOWED, port: 0 });
    const r = await preflight(await signedUploadPath(), ALLOWED);
    expect(r.status).toBe(204);
    expect(r.headers['access-control-allow-origin']).toBe(ALLOWED);
    expect(r.headers['access-control-allow-methods']).toBe('PUT');
    expect(r.headers['access-control-allow-headers']).toBe('content-type, x-upsert');
    expect(r.headers['access-control-allow-credentials']).toBeUndefined();
  });

  it('refuses preflights from other origins, other methods, extra headers or other paths', async () => {
    fake = await startFakeStorage({ allowedOrigin: ALLOWED, port: 0 });
    const path = await signedUploadPath();
    for (const r of [
      await preflight(path, 'http://localhost:3000'),
      await preflight(path, 'http://127.0.0.1:3100'),
      await preflight(path, 'https://evil.example'),
      await preflight(path, ALLOWED, 'content-type,authorization'),
      await preflight(`/storage/v1/object/${E2E_BUCKET}/${KEY}`, ALLOWED),
      await send('OPTIONS', path, {
        origin: ALLOWED,
        'access-control-request-method': 'DELETE',
      }),
    ]) {
      expect(r.status).toBe(403);
      expect(r.headers['access-control-allow-origin']).toBeUndefined();
    }
  });

  it('accepts the upload from the allowed origin, once; the token stays single-use', async () => {
    fake = await startFakeStorage({ allowedOrigin: ALLOWED, port: 0 });
    const path = await signedUploadPath();
    const first = await upload(path, ALLOWED);
    expect(first.status).toBe(200);
    expect(first.headers['access-control-allow-origin']).toBe(ALLOWED);
    expect(fake.objects.get(KEY)?.contentType).toBe('text/csv');
    // Same token again: refused (token consumed), object unchanged.
    const again = await upload(path, ALLOWED);
    expect(again.status).toBe(400);
    expect(JSON.parse(again.body)).toMatchObject({ statusCode: '403', message: 'invalid token' });
    // A token for another key, or no token, never writes.
    expect((await upload(path.replace('file.csv', 'other.csv'), ALLOWED)).status).toBe(400);
    expect((await upload(path.split('?')[0]!, ALLOWED)).status).toBe(400);
    expect([...fake.objects.keys()]).toEqual([KEY]);
  });

  it('refuses any request from another origin, without CORS headers, and writes nothing', async () => {
    fake = await startFakeStorage({ allowedOrigin: ALLOWED, port: 0 });
    const path = await signedUploadPath();
    const r = await upload(path, 'https://evil.example');
    expect(r.status).toBe(403);
    expect(r.headers['access-control-allow-origin']).toBeUndefined();
    expect(fake.objects.size).toBe(0);
    // The token was not consumed by the refused request: the allowed origin can still use it.
    expect((await upload(path, ALLOWED)).status).toBe(200);
    // Server routes are refused for a foreign origin even with the service key.
    const read = await send('GET', `/storage/v1/object/${E2E_BUCKET}/${KEY}`, {
      authorization: `Bearer ${E2E_STORAGE_KEY}`,
      origin: 'https://evil.example',
    });
    expect(read.status).toBe(403);
  });

  it('server-side calls (no Origin) work as before and never get CORS headers', async () => {
    fake = await startFakeStorage({ allowedOrigin: ALLOWED, port: 0 });
    await upload(await signedUploadPath());
    const info = await send('GET', `/storage/v1/object/info/${E2E_BUCKET}/${KEY}`, {
      authorization: `Bearer ${E2E_STORAGE_KEY}`,
    });
    expect(info.status).toBe(200);
    expect(info.headers['access-control-allow-origin']).toBeUndefined();
    // A browser holding no key cannot read objects, even from the allowed origin.
    const anon = await send('GET', `/storage/v1/object/${E2E_BUCKET}/${KEY}`, { origin: ALLOWED });
    expect(anon.status).toBe(400);
    expect(anon.headers['access-control-allow-origin']).toBeUndefined();
  });

  it('rejects wildcard or non-origin values', async () => {
    for (const bad of [
      '*',
      'http://localhost:3100/',
      'http://localhost:3100/app',
      'localhost:3100',
    ])
      await expect(startFakeStorage({ allowedOrigin: bad, port: 0 })).rejects.toThrow(
        /exact origin|Invalid URL/,
      );
  });
});

describe('fake storage default (no allowedOrigin): unchanged', () => {
  it('sends no CORS headers and gives preflights no permission', async () => {
    fake = await startFakeStorage({ port: 0 });
    const path = await signedUploadPath();
    const pre = await preflight(path, ALLOWED);
    expect(pre.headers['access-control-allow-origin']).toBeUndefined();
    expect(pre.status).not.toBe(204);
    const put = await upload(path, ALLOWED);
    expect(put.status).toBe(200);
    expect(put.headers['access-control-allow-origin']).toBeUndefined();
    expect((await upload(path)).status).toBe(400); // still single-use
  });

  it('binds to 127.0.0.1 only', async () => {
    fake = await startFakeStorage({ port: 0 });
    expect((fake.server.address() as AddressInfo).address).toBe('127.0.0.1');
  });
});
