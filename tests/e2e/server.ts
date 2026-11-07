// Vitest globalSetup for e2e: runs the BUILT standalone Next.js server and the real worker
// against crm_test / Valkey db 1, plus a local fake of the Supabase Storage API (./fake-storage;
// no cloud). Requires `pnpm build` first.
//
// M6 acceptance:
// - E2E_IMPORT_COMMIT_STRATEGY=row|set selects the worker's import commit (IMPORT_COMMIT_STRATEGY,
//   src/env.ts). Unset means the application default ('set'). Any other value stops the run.
//   Only the worker gets it; a value in .env is never passed through.
// - The worker is supervised: if it exits while the suite runs (the crash-recovery test kills
//   it), a replacement starts with the same environment. Its current pid is in WORKER_PID_FILE.
// - spawnWeb() starts an extra built web server (search-limit tests: a second instance, and one
//   whose Valkey is unreachable).
import { spawn, type ChildProcess } from 'node:child_process';
import { cpSync, existsSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import 'dotenv/config';
import type { TestProject } from 'vitest/node';
import { E2E_BUCKET, E2E_STORAGE_KEY, E2E_STORAGE_URL, startFakeStorage } from './fake-storage';

export const E2E_PORT = 3100;
export const E2E_URL = `http://127.0.0.1:${E2E_PORT}`;
export const WORKER_PID_FILE = join(tmpdir(), 'cbr-crm-e2e-worker.pid');

export type CommitStrategy = 'row' | 'set';

declare module 'vitest' {
  export interface ProvidedContext {
    /** The worker's IMPORT_COMMIT_STRATEGY for this run ('set', the default, when not selected). */
    importCommitStrategy: CommitStrategy;
  }
}

/** The explicitly selected strategy, validated; null when unset (application default). */
export function selectedCommitStrategy(): CommitStrategy | null {
  const v = process.env.E2E_IMPORT_COMMIT_STRATEGY;
  if (v === undefined || v === '') return null;
  if (v !== 'row' && v !== 'set')
    throw new Error(`E2E_IMPORT_COMMIT_STRATEGY must be "row" or "set", got ${JSON.stringify(v)}`);
  return v;
}

export function testEnv(port = E2E_PORT): NodeJS.ProcessEnv {
  const redis = `${(process.env.REDIS_URL ?? 'redis://127.0.0.1:56379').replace(/\/\d+$/, '')}/1`;
  // Strip test-runner variables: the server must behave as in production. The commit switch is
  // set explicitly for the worker only.
  const base = Object.fromEntries(
    Object.entries(process.env).filter(
      ([k]) =>
        k !== 'TEST' &&
        !k.startsWith('VITEST') &&
        k !== 'IMPORT_COMMIT_STRATEGY' &&
        k !== 'E2E_IMPORT_COMMIT_STRATEGY',
    ),
  );
  return {
    ...base,
    NODE_ENV: 'production',
    PORT: String(port),
    HOSTNAME: '127.0.0.1',
    DATABASE_URL: process.env.TEST_DATABASE_URL,
    AUTH_DATABASE_URL: process.env.TEST_AUTH_DATABASE_URL,
    PLATFORM_DATABASE_URL: process.env.TEST_PLATFORM_DATABASE_URL,
    REDIS_URL: redis,
    // Sessions and links name the main server; extra instances share its cookies.
    BETTER_AUTH_URL: E2E_URL,
    LOG_LEVEL: process.env.TEST_LOG_LEVEL ?? 'warn',
    SUPABASE_URL: E2E_STORAGE_URL,
    SUPABASE_SERVICE_ROLE_KEY: E2E_STORAGE_KEY,
    SUPABASE_IMPORT_BUCKET: E2E_BUCKET,
    // Worker only (added below); the web server never gets the cleanup connection.
    CLEANUP_DATABASE_URL: '',
    NEXT_TELEMETRY_DISABLED: '1',
  };
}

export function workerEnv(): NodeJS.ProcessEnv {
  const strategy = selectedCommitStrategy();
  return {
    ...testEnv(),
    SERVICE_NAME: 'worker',
    CLEANUP_DATABASE_URL: process.env.TEST_CLEANUP_DATABASE_URL,
    ...(strategy ? { IMPORT_COMMIT_STRATEGY: strategy } : {}),
  };
}

export async function waitFor(url: string, ms: number) {
  const until = Date.now() + ms;
  while (Date.now() < until) {
    try {
      if ((await fetch(url)).ok) return;
    } catch {
      /* not up yet */
    }
    await new Promise((r) => setTimeout(r, 300));
  }
  throw new Error(`server did not become ready at ${url}`);
}

/** Starts another built web server on `port` (same database and storage); stop it with kill(). */
export async function spawnWeb(port: number, overrides: Record<string, string> = {}) {
  const web = spawn(process.execPath, ['.next/standalone/server.js'], {
    env: { ...testEnv(port), ...overrides },
    stdio: ['ignore', 'inherit', 'inherit'],
  });
  await waitFor(`http://127.0.0.1:${port}/api/health`, 60_000);
  return web;
}

export default async function setup(project: TestProject) {
  if (!existsSync('.next/standalone/server.js'))
    throw new Error('Run `pnpm build` before the e2e suite');
  const strategy = selectedCommitStrategy(); // validated before anything starts
  project.provide('importCommitStrategy', strategy ?? 'set');
  // Standalone output does not include static assets.
  cpSync('.next/static', '.next/standalone/.next/static', { recursive: true });

  const storage = await startFakeStorage();
  const children: ChildProcess[] = [];
  const web = spawn(process.execPath, ['.next/standalone/server.js'], {
    env: testEnv(),
    stdio: ['ignore', 'inherit', 'inherit'],
  });
  children.push(web);

  let stopping = false;
  let restarts = 0;
  let worker: ChildProcess;
  const startWorker = () => {
    worker = spawn(process.execPath, ['--import', 'tsx', 'src/worker/main.ts'], {
      env: workerEnv(),
      stdio: ['ignore', 'inherit', 'inherit'],
    });
    writeFileSync(WORKER_PID_FILE, String(worker.pid));
    worker.on('exit', (code, signal) => {
      if (stopping) return;
      // A worker that cannot start (bad configuration) must not loop.
      if (++restarts > 3) {
        console.error(`e2e worker exited (${code ?? signal}) too often; not restarting`);
        return;
      }
      startWorker();
    });
  };
  startWorker();
  await waitFor(`${E2E_URL}/api/health`, 60_000);

  return async () => {
    stopping = true;
    for (const c of [...children, worker!]) c.kill('SIGTERM');
    await new Promise((r) => setTimeout(r, 500));
    rmSync(WORKER_PID_FILE, { force: true });
    await storage.close();
  };
}
