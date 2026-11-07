// Real-bucket check for the import storage (runbook §4, step 1). Run by the owner AFTER creating
// the private bucket and setting SUPABASE_URL / SUPABASE_SERVICE_ROLE_KEY in .env:
//
//   pnpm exec tsx scripts/storage-check/verify-bucket.ts
//
// It writes only two tiny synthetic objects under a probe org id that no real org can have
// (orgs/00000000-0000-7000-8000-00000000c4ec/…), and deletes them again, also on failure.
// It never prints the service key, signed URLs or tokens. `--local-fake <url>` is only for
// testing this script against tests/e2e/fake-storage.ts; it refuses plain http otherwise.
import 'dotenv/config';
import { createHash, randomBytes } from 'node:crypto';
import { uuidv7 } from '@/lib/uuidv7';
import { objectKeyFor } from '@/platform/storage';
import { createSupabaseStorage } from '@/platform/storage/supabase';

const PROBE_ORG = '00000000-0000-7000-8000-00000000c4ec';
const args = process.argv.slice(2);
const fakeAt = args[0] === '--local-fake' ? args[1] : undefined;
const url = fakeAt ?? process.env.SUPABASE_URL ?? '';
const key = fakeAt ? (args[2] ?? '') : (process.env.SUPABASE_SERVICE_ROLE_KEY ?? '');
const bucket = process.env.SUPABASE_IMPORT_BUCKET || 'crm-imports';

let failures = 0;
function check(label: string, ok: boolean, detail = '') {
  if (!ok) failures++;
  console.log(`${ok ? 'PASS' : 'FAIL'}  ${label}${detail ? `  (${detail})` : ''}`);
}

async function main() {
  if (!url || !key) {
    console.log(
      'SUPABASE_URL and SUPABASE_SERVICE_ROLE_KEY must be set (runbook §3). Nothing done.',
    );
    process.exit(2);
  }
  if (!fakeAt && !/^https:\/\/[a-z0-9-]+\.supabase\.co\/?$/.test(url)) {
    console.log('SUPABASE_URL must be https://<project-ref>.supabase.co. Nothing done.');
    process.exit(2);
  }
  check('service key is a secret key, not the publishable one', !key.startsWith('sb_publishable_'));
  const storage = createSupabaseStorage({ url, serviceKey: key, bucket });
  const origin = new URL(url).origin;
  const probeKey = objectKeyFor(PROBE_ORG, 'imports', uuidv7(), 'csv');
  const controlKey = objectKeyFor(PROBE_ORG, 'imports', uuidv7(), 'csv');
  const body = new TextEncoder().encode('Name,Mobile\nSynthetic Probe,9800000001\n');
  const control = new TextEncoder().encode('Name,Mobile\nControl Object,9800000002\n');
  try {
    // A control object that nothing below may overwrite or delete.
    await storage.put(controlKey, control, 'text/csv');

    const grant = await storage.createUploadGrant(probeKey, 'text/csv');
    check('grant URL points at the project storage origin', new URL(grant.url).origin === origin);
    check('grant names exactly the probe object', grant.url.includes(`/${bucket}/${probeKey}?`));
    check(
      'grant carries no service key',
      !grant.url.includes(key) && !JSON.stringify(grant).includes(key),
    );

    // The browser's PUT: no Authorization header, only the grant's headers.
    const put = await fetch(grant.url, { method: 'PUT', headers: grant.headers, body });
    check('browser-style PUT with the signed grant succeeds', put.ok, `HTTP ${put.status}`);
    const replay = await fetch(grant.url, {
      method: 'PUT',
      headers: grant.headers,
      body: randomBytes(body.byteLength),
    });
    check('replaying the grant cannot overwrite the object', !replay.ok, `HTTP ${replay.status}`);
    const otherPath = grant.url.replace(probeKey, controlKey);
    const swap = await fetch(otherPath, { method: 'PUT', headers: grant.headers, body });
    check('the grant cannot be used for another object', !swap.ok, `HTTP ${swap.status}`);

    const meta = await storage.stat(probeKey);
    check('server sees the exact size', meta?.size === body.byteLength, `${meta?.size}`);
    check(
      'server sees the granted type',
      meta?.contentType?.split(';')[0] === 'text/csv',
      `${meta?.contentType}`,
    );
    const got = await storage.download(probeKey, body.byteLength);
    const sha = (b: Uint8Array) => createHash('sha256').update(b).digest('hex');
    check('downloaded bytes match what was uploaded (SHA-256)', sha(got) === sha(body));
    const ctl = await storage.download(controlKey, control.byteLength);
    check('control object unchanged', sha(ctl) === sha(control));

    for (const [label, path] of [
      ['public URL', `/storage/v1/object/public/${bucket}/${probeKey}`],
      ['authenticated URL without a key', `/storage/v1/object/authenticated/${bucket}/${probeKey}`],
      ['direct object URL without a key', `/storage/v1/object/${bucket}/${probeKey}`],
    ] as const) {
      const r = await fetch(`${origin}${path}`);
      check(`anonymous read via ${label} is refused`, !r.ok, `HTTP ${r.status}`);
    }

    await storage.remove([probeKey]);
    check('probe object deleted', (await storage.stat(probeKey)) === null);
    await storage.remove([probeKey]);
    check('deleting again is harmless', true);
    check(
      'control object survives the deletion',
      (await storage.stat(controlKey))?.size === control.byteLength,
    );
  } finally {
    await storage.remove([probeKey, controlKey]).catch(() => undefined);
    const left = [
      await storage.stat(probeKey).catch(() => 'error'),
      await storage.stat(controlKey).catch(() => 'error'),
    ];
    check(
      'nothing left behind',
      left.every((x) => x === null),
    );
  }
  console.log(failures ? `${failures} FAILED` : 'ALL PASSED');
  process.exit(failures ? 1 : 0);
}

main().catch((e: unknown) => {
  // StorageError messages are fixed text; never print provider bodies or URLs.
  console.log('ERROR', e instanceof Error ? `${e.name}: ${e.message}` : 'unknown');
  process.exit(1);
});
