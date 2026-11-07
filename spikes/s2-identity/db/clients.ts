// S2 db gateway: the only spike folder allowed to import the raw generated client.
import { PrismaPg } from '@prisma/adapter-pg';
import pg from 'pg';
import { createTenantRunner } from '@/platform/db/with-tenant';
import { PrismaClient } from '../generated/prisma/client';

export type { Prisma } from '../generated/prisma/client';
export type AuthPrismaClient = PrismaClient;

function requireEnv(name: string): string {
  const value = process.env[name];
  if (!value) throw new Error(`${name} is not set (see .env.example)`);
  return value;
}

export interface ClientHandle {
  readonly prisma: PrismaClient;
  close(): Promise<void>;
}

function create(url: string, max: number): ClientHandle {
  const pool = new pg.Pool({ connectionString: url, max, connectionTimeoutMillis: 10_000 });
  const prisma = new PrismaClient({ adapter: new PrismaPg(pool) });
  return {
    prisma,
    async close() {
      await prisma.$disconnect();
      await pool.end();
    },
  };
}

/** crm_auth: handed to Better Auth only. Business code never receives this client. */
export const createAuthClient = (max = 5) => create(requireEnv('S2_AUTH_URL'), max);
/** crm_app: business code, via withTenant()/withUser() only. */
export const createAppClient = (max = 5) => create(requireEnv('S2_APP_URL'), max);
/** crm_platform: platform-admin tooling. */
export const createPlatformClient = (max = 2) => create(requireEnv('S2_PLATFORM_URL'), max);
/** Schema owner: test setup and assertions only. */
export const createMigratorClient = (max = 2) => create(requireEnv('S2_MIGRATOR_URL'), max);

export function tenantRunnerFor(handle: ClientHandle) {
  return createTenantRunner(handle.prisma, { maxWait: 10_000, timeout: 10_000 });
}
