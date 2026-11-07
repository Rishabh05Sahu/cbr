// Local browser testing of imports against the e2e fake Supabase Storage, never the real bucket.
// Runbook: docs/runbooks/local-import-browser-testing.md. Nothing here edits .env or prints a key.
//
//   npx tsx scripts/dev/import-browser-test.mts check    verify the web and worker settings; starts nothing
//   npx tsx scripts/dev/import-browser-test.mts storage  fake storage on 127.0.0.1:3199 (Ctrl+C stops it; files are in memory)
//   npx tsx scripts/dev/import-browser-test.mts web      next dev on localhost:3100 with the overrides below
//   npx tsx scripts/dev/import-browser-test.mts worker   the worker with the same overrides and the cleanup sweep OFF
//
// Overrides (process environment only; .env supplies everything else, local databases only):
//   SUPABASE_URL=http://127.0.0.1:3199, SUPABASE_SERVICE_ROLE_KEY=<the fake key in
//   tests/e2e/fake-storage.ts>, SUPABASE_IMPORT_BUCKET=crm-imports,
//   BETTER_AUTH_URL=http://localhost:3100, CLEANUP_DATABASE_URL='' (the sweep cannot start).
import { spawn } from 'node:child_process';
import { readFileSync } from 'node:fs';
import { connect } from 'node:net';
import { fileURLToPath } from 'node:url';
import { parse } from 'dotenv';
import { serverEnvSchema } from '../../src/env';
import {
  E2E_BUCKET,
  E2E_STORAGE_KEY,
  E2E_STORAGE_PORT,
  E2E_STORAGE_URL,
  startFakeStorage,
} from '../../tests/e2e/fake-storage';

const ROOT = fileURLToPath(new URL('../../', import.meta.url));
const WEB_PORT = 3100;
const WEB_ORIGIN = `http://localhost:${WEB_PORT}`;
const LOOPBACK = new Set(['127.0.0.1', 'localhost', '[::1]', '::1']);

function fail(message: string): never {
  console.error(`REFUSED: ${message}`);
  process.exit(1);
}

// The fake must be loopback-only at the documented address.
{
  const u = new URL(E2E_STORAGE_URL);
  if (u.protocol !== 'http:' || u.hostname !== '127.0.0.1' || Number(u.port) !== 3199)
    fail('the fake storage URL is not http://127.0.0.1:3199');
  if (E2E_STORAGE_PORT !== 3199) fail('the fake storage port is not 3199');
}

const OVERRIDES = {
  SUPABASE_URL: E2E_STORAGE_URL,
  SUPABASE_SERVICE_ROLE_KEY: E2E_STORAGE_KEY,
  SUPABASE_IMPORT_BUCKET: E2E_BUCKET,
  BETTER_AUTH_URL: WEB_ORIGIN,
  // Blank → unset by src/env.ts → cleanupPrisma() is null → the worker's sweep loop returns.
  CLEANUP_DATABASE_URL: '',
} as const;

/** The environment a process gets: .env, then the shell, then the overrides (which win). */
function processEnv(): NodeJS.ProcessEnv {
  const fromFile = parse(readFileSync(`${ROOT}.env`));
  return { ...fromFile, ...process.env, ...OVERRIDES };
}

/** Validates with the app's own schema and refuses anything that could reach real storage. */
function verify(env: NodeJS.ProcessEnv, who: 'web' | 'worker') {
  const parsed = serverEnvSchema.safeParse(env);
  if (!parsed.success)
    fail(
      `${who} environment is invalid: ${parsed.error.issues.map((i) => i.path.join('.')).join(', ')}`,
    );
  const e = parsed.data;
  const storage = new URL(e.SUPABASE_URL ?? 'http://invalid');
  const checks: [string, boolean][] = [
    ['storage URL is the local fake (http://127.0.0.1:3199)', e.SUPABASE_URL === E2E_STORAGE_URL],
    ['storage host is loopback', LOOPBACK.has(storage.hostname)],
    [
      'storage key is the fake key (not the .env key)',
      e.SUPABASE_SERVICE_ROLE_KEY === E2E_STORAGE_KEY,
    ],
    ['bucket is the fake bucket', e.SUPABASE_IMPORT_BUCKET === E2E_BUCKET],
    ['cleanup sweep disabled (CLEANUP_DATABASE_URL unset)', e.CLEANUP_DATABASE_URL === undefined],
    [`auth URL is ${WEB_ORIGIN}`, e.BETTER_AUTH_URL === WEB_ORIGIN],
  ];
  for (const k of ['DATABASE_URL', 'AUTH_DATABASE_URL', 'PLATFORM_DATABASE_URL'] as const) {
    const v = (e as Record<string, unknown>)[k];
    if (typeof v === 'string')
      checks.push([`${k} is a local database`, LOOPBACK.has(new URL(v).hostname)]);
  }
  checks.push([
    'REDIS_URL is local',
    typeof e.REDIS_URL !== 'string' || LOOPBACK.has(new URL(e.REDIS_URL).hostname),
  ]);
  for (const [label, ok] of checks) console.log(`  ${ok ? 'ok  ' : 'FAIL'} ${who}: ${label}`);
  if (checks.some(([, ok]) => !ok)) fail(`${who} settings are not isolated`);
  const db = typeof e.DATABASE_URL === 'string' ? new URL(e.DATABASE_URL).pathname.slice(1) : '?';
  console.log(`  info ${who}: application database "${db}" (from .env)`);
}

function portOpen(port: number): Promise<boolean> {
  return new Promise((resolve) => {
    const s = connect({ host: '127.0.0.1', port });
    s.once('connect', () => (s.destroy(), resolve(true)));
    s.once('error', () => resolve(false));
  });
}

function run(cmd: string, args: string[], env: NodeJS.ProcessEnv) {
  const child = spawn(cmd, args, {
    cwd: ROOT,
    env,
    stdio: 'inherit',
    shell: process.platform === 'win32',
  });
  const stop = () => child.kill('SIGINT');
  process.on('SIGINT', stop);
  process.on('SIGTERM', stop);
  child.on('exit', (code) => process.exit(code ?? 0));
}

const mode = process.argv[2];
if (mode === 'check') {
  verify(processEnv(), 'web');
  verify(processEnv(), 'worker');
  console.log('All checks passed. Nothing was started.');
} else if (mode === 'storage') {
  if (await portOpen(E2E_STORAGE_PORT)) fail(`port ${E2E_STORAGE_PORT} is already in use`);
  const fake = await startFakeStorage({ allowedOrigin: WEB_ORIGIN });
  console.log(`Fake storage on ${E2E_STORAGE_URL} (127.0.0.1 only), bucket "${E2E_BUCKET}".`);
  console.log(`Browser uploads accepted only from ${WEB_ORIGIN}. Files live in memory.`);
  console.log('Press Ctrl+C to stop; every stored file is discarded.');
  const stop = async () => {
    await fake.close();
    console.log(`Stopped; ${fake.objects.size} in-memory file(s) discarded.`);
    process.exit(0);
  };
  process.on('SIGINT', () => void stop());
  process.on('SIGTERM', () => void stop());
} else if (mode === 'web' || mode === 'worker') {
  const env = processEnv();
  verify(env, mode);
  if (!(await portOpen(E2E_STORAGE_PORT)))
    fail(`the fake storage is not running on ${E2E_STORAGE_URL} (start "storage" first)`);
  if (mode === 'web') {
    if (await portOpen(WEB_PORT))
      fail(`port ${WEB_PORT} is already in use; stop that server first`);
    run('pnpm', ['exec', 'next', 'dev', '--port', String(WEB_PORT)], env);
  } else {
    console.log('  note worker: the outbox relay will also deliver events already queued.');
    run('npx', ['tsx', 'src/worker/main.ts'], env);
  }
} else {
  fail('usage: import-browser-test.mts <check|storage|web|worker>');
}
