// Database gateway: the only place raw Prisma clients are constructed (lint-enforced).
// One pool per runtime role. Modules receive `tenantRunner()` (crm_app via withTenant);
// the auth platform receives `authPrisma()` (crm_auth); the platform console receives
// `platformPrisma()` (crm_platform); the worker's import cleanup uses `cleanupPrisma()`
// (crm_cleanup) through ./cleanup.ts only.
import { PrismaPg } from '@prisma/adapter-pg';
import pg from 'pg';
import { serverEnv } from '@/env';
import { PrismaClient } from '@/generated/prisma/client';
import { createTenantRunner, type TenantRunner } from './with-tenant';

export type { Prisma } from '@/generated/prisma/client';
export type DbClient = PrismaClient;

interface Handle {
  prisma: PrismaClient;
  pool: pg.Pool;
}

const g = globalThis as unknown as { __crmDb?: Record<string, Handle> };
const handles = (g.__crmDb ??= {});

function handle(name: 'app' | 'auth' | 'platform' | 'cleanup', url: string, max: number): Handle {
  const existing = handles[name];
  if (existing) return existing;
  const pool = new pg.Pool({
    connectionString: url,
    max,
    connectionTimeoutMillis: 10_000,
    idleTimeoutMillis: 30_000,
    application_name: `cbr-crm-${name}`,
  });
  const created = { pool, prisma: new PrismaClient({ adapter: new PrismaPg(pool) }) };
  handles[name] = created;
  return created;
}

let runner: TenantRunner<import('@/generated/prisma/client').Prisma.TransactionClient> | undefined;

/** crm_app: tenant work only through withTenant()/withUser(). */
export function tenantRunner() {
  const env = serverEnv();
  runner ??= createTenantRunner(handle('app', env.DATABASE_URL, env.DATABASE_POOL_MAX).prisma, {
    maxWait: 10_000,
    timeout: 15_000,
  });
  return runner;
}

/** crm_auth: Better Auth only (src/platform/auth). */
export function authPrisma(): PrismaClient {
  const env = serverEnv();
  return handle('auth', env.AUTH_DATABASE_URL, Math.max(2, Math.floor(env.DATABASE_POOL_MAX / 2)))
    .prisma;
}

/** crm_platform: platform console (organisations, platform audit, support-grant requests). */
export function platformPrisma(): PrismaClient {
  return handle('platform', serverEnv().PLATFORM_DATABASE_URL, 2).prisma;
}

/**
 * crm_cleanup: may only execute app.import_files_due (no table access). Null when
 * CLEANUP_DATABASE_URL is unset (web app, or a worker without the sweep).
 */
export function cleanupPrisma(): PrismaClient | null {
  const url = serverEnv().CLEANUP_DATABASE_URL;
  return url ? handle('cleanup', url, 1).prisma : null;
}

export async function disconnectAll(): Promise<void> {
  for (const [name, h] of Object.entries(handles)) {
    await h.prisma.$disconnect();
    await h.pool.end();
    delete handles[name];
  }
  runner = undefined;
}
