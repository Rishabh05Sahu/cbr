// Supabase Storage adapter against an in-memory fake of the Storage REST API (no network).
import { describe, expect, it } from 'vitest';
import { keyBelongsTo, objectKeyFor, parseObjectKey, StorageError } from './index';
import { createSupabaseStorage } from './supabase';

const URL_BASE = 'https://example-project.supabase.co';
const SECRET = 'sb_secret_TEST_ONLY_not_a_real_key_0123456789';
const ORG = '0199a000-0000-7000-8000-000000000001';
const JOB = '0199a000-0000-7000-8000-000000000002';

type Handler = (req: { method: string; path: string; headers: Headers }) => Response | 'hang';

function fakeStorage(override?: Handler) {
  const objects = new Map<string, { body: Uint8Array; type: string }>();
  const calls: { method: string; path: string; auth: string | null }[] = [];
  const json = (status: number, body: unknown) =>
    new Response(JSON.stringify(body), { status, headers: { 'content-type': 'application/json' } });
  const fetchImpl: typeof fetch = async (input, init) => {
    const url = new URL(String(input instanceof Request ? input.url : input));
    const method = (init?.method ?? 'GET').toUpperCase();
    const headers = new Headers(init?.headers);
    const path = url.pathname.replace('/storage/v1', '');
    calls.push({ method, path, auth: headers.get('authorization') });
    const o = override?.({ method, path, headers });
    if (o === 'hang')
      return new Promise((_, reject) =>
        init?.signal?.addEventListener('abort', () => reject(init.signal!.reason)),
      );
    if (o) return o;
    let m: RegExpExecArray | null;
    if (method === 'POST' && (m = /^\/object\/upload\/sign\/(.+)$/.exec(path)))
      return json(200, { url: `/object/upload/sign/${m[1]}?token=signed-token-xyz` });
    if (method === 'GET' && (m = /^\/object\/info\/[^/]+\/(.+)$/.exec(path))) {
      const obj = objects.get(m[1]!);
      return obj
        ? json(200, { size: obj.body.length, content_type: obj.type, name: m[1] })
        : json(400, { statusCode: '404', error: 'not_found', message: 'Object not found' });
    }
    if (method === 'GET' && (m = /^\/object\/[^/]+\/(.+)$/.exec(path))) {
      const obj = objects.get(m[1]!);
      return obj
        ? new Response(Buffer.from(obj.body))
        : json(400, { statusCode: '404', message: 'nf' });
    }
    if (method === 'POST' && (m = /^\/object\/[^/]+\/(.+)$/.exec(path))) {
      if (objects.has(m[1]!)) return json(400, { statusCode: '409', message: 'Duplicate' });
      objects.set(m[1]!, {
        body: new Uint8Array(await new Response(init!.body as BodyInit).arrayBuffer()),
        type: headers.get('content-type') ?? '',
      });
      return json(200, { Key: m[1] });
    }
    if (method === 'DELETE' && /^\/object\/[^/]+$/.test(path)) {
      const { prefixes } = JSON.parse(String(init!.body)) as { prefixes: string[] };
      for (const p of prefixes) objects.delete(p);
      return json(200, []);
    }
    return json(500, { message: 'unexpected' });
  };
  const storage = createSupabaseStorage({
    url: URL_BASE,
    serviceKey: SECRET,
    bucket: 'crm-imports',
    fetch: fetchImpl,
    timeoutMs: 200,
  });
  return { storage, objects, calls };
}

const key = () => objectKeyFor(ORG, 'imports', JOB, 'csv');

describe('object keys', () => {
  it('are namespaced by org and record, random, and never contain a filename', () => {
    const a = key();
    expect(a).toMatch(new RegExp(`^orgs/${ORG}/imports/${JOB}/[0-9a-f]{32}\\.csv$`));
    expect(key()).not.toBe(a);
    expect(parseObjectKey(a)).toMatchObject({ orgId: ORG, kind: 'imports', recordId: JOB });
    expect(keyBelongsTo(a, ORG, 'imports', JOB)).toBe(true);
  });

  it('refuse non-UUID ids and anything they could not have produced', () => {
    expect(() => objectKeyFor('../other', 'imports', JOB, 'csv')).toThrow();
    const other = '0199a000-0000-7000-8000-000000000009';
    for (const bad of [
      `orgs/${ORG}/imports/${JOB}/../../x.csv`,
      `orgs/${ORG}/imports/${JOB}/leads.csv`,
      `orgs/${ORG}/imports/${JOB}/${'a'.repeat(32)}.xlsm`,
      `/orgs/${ORG}/imports/${JOB}/${'a'.repeat(32)}.csv`,
    ])
      expect(parseObjectKey(bad), bad).toBeNull();
    expect(keyBelongsTo(key(), other, 'imports', JOB)).toBe(false);
    expect(keyBelongsTo(key(), ORG, 'imports', other)).toBe(false);
  });

  it('export keys are CSV only and never match an import record', () => {
    const e = objectKeyFor(ORG, 'exports', JOB, 'csv');
    expect(e).toMatch(new RegExp(`^orgs/${ORG}/exports/${JOB}/[0-9a-f]{32}\\.csv$`));
    expect(keyBelongsTo(e, ORG, 'exports', JOB)).toBe(true);
    expect(keyBelongsTo(e, ORG, 'imports', JOB)).toBe(false);
    expect(() => objectKeyFor(ORG, 'exports', JOB, 'xlsx')).toThrow();
    expect(parseObjectKey(`orgs/${ORG}/exports/${JOB}/${'a'.repeat(32)}.xlsx`)).toBeNull();
  });
});

describe('Supabase storage adapter', () => {
  it('issues an object-specific, no-overwrite upload grant without exposing the service key', async () => {
    const { storage, calls } = fakeStorage();
    const k = key();
    const grant = await storage.createUploadGrant(k, 'text/csv');
    expect(grant.method).toBe('PUT');
    expect(
      grant.url.startsWith(`${URL_BASE}/storage/v1/object/upload/sign/crm-imports/${k}?token=`),
    ).toBe(true);
    expect(grant.headers).toEqual({ 'content-type': 'text/csv', 'x-upsert': 'false' });
    expect(JSON.stringify(grant)).not.toContain(SECRET);
    // The key is used server-to-server only.
    expect(calls[0]!.auth).toBe(`Bearer ${SECRET}`);
    expect(grant.providerExpiresAt.getTime() - Date.now()).toBeLessThanOrEqual(2 * 3600_000);
  });

  it('stats, downloads within the limit, refuses oversize before downloading, and removes', async () => {
    const { storage, calls } = fakeStorage();
    const k = key();
    expect(await storage.stat(k)).toBeNull();
    await storage.put(k, new TextEncoder().encode('name,phone\n'), 'text/csv');
    expect(await storage.stat(k)).toEqual({ size: 11, contentType: 'text/csv' });
    expect(new TextDecoder().decode(await storage.download(k, 11))).toBe('name,phone\n');

    const before = calls.length;
    await expect(storage.download(k, 10)).rejects.toMatchObject({ code: 'TOO_LARGE' });
    expect(calls.slice(before).map((c) => c.method)).toEqual(['GET']); // info only, no body
    await expect(storage.put(k, new Uint8Array([1]), 'text/csv')).rejects.toMatchObject({
      code: 'ALREADY_EXISTS',
    });
    await storage.remove([k]);
    await storage.remove([k]); // idempotent
    expect(await storage.stat(k)).toBeNull();
    await expect(storage.download(k, 100)).rejects.toMatchObject({ code: 'NOT_FOUND' });
  });

  it('retries transient failures a bounded number of times, never client errors', async () => {
    let failures = 2;
    const flaky = fakeStorage(({ path }) =>
      path.startsWith('/object/upload/sign') && failures-- > 0
        ? new Response('{"message":"busy"}', { status: 503 })
        : (undefined as unknown as Response),
    );
    await flaky.storage.createUploadGrant(key(), 'text/csv');
    expect(flaky.calls).toHaveLength(3);

    const down = fakeStorage(() => new Response('{"message":"down"}', { status: 503 }));
    await expect(down.storage.stat(key())).rejects.toMatchObject({ code: 'UNAVAILABLE' });
    expect(down.calls).toHaveLength(3);

    const denied = fakeStorage(() => new Response('{"message":"nope"}', { status: 403 }));
    await expect(denied.storage.createUploadGrant(key(), 'text/csv')).rejects.toMatchObject({
      code: 'REJECTED',
      status: 403,
    });
    expect(denied.calls).toHaveLength(1);
  });

  it('times out hung requests', async () => {
    const { storage, calls } = fakeStorage(() => 'hang');
    const started = Date.now();
    await expect(storage.stat(key())).rejects.toMatchObject({ code: 'UNAVAILABLE' });
    expect(calls).toHaveLength(3);
    expect(Date.now() - started).toBeLessThan(5_000);
  });

  it('never carries provider text, URLs, tokens or keys in its errors', async () => {
    const leaky = `token=signed-token-xyz key=${SECRET} row: Asha Rao 9876543210`;
    const { storage } = fakeStorage(
      () => new Response(JSON.stringify({ message: leaky, statusCode: '403' }), { status: 400 }),
    );
    const err = await storage.createUploadGrant(key(), 'text/csv').catch((e: unknown) => e);
    expect(err).toBeInstanceOf(StorageError);
    const seen = JSON.stringify({ ...(err as object), message: (err as Error).message });
    for (const s of ['signed-token', SECRET, 'Asha', '9876543210', 'supabase.co'])
      expect(seen).not.toContain(s);
    expect((err as Error).stack ?? '').not.toContain(SECRET);
  });
});
