// Test-only raw access to crm_test as the schema owner, for setup and assertions.
// Never used by application code.
import { PrismaPg } from '@prisma/adapter-pg';
import pg from 'pg';
import { PrismaClient } from '@/generated/prisma/client';

const g = globalThis as unknown as { __testMigrator?: { prisma: PrismaClient; pool: pg.Pool } };

export function migrator(): PrismaClient {
  if (!g.__testMigrator) {
    const pool = new pg.Pool({ connectionString: process.env.TEST_MIGRATOR_URL, max: 3 });
    g.__testMigrator = { pool, prisma: new PrismaClient({ adapter: new PrismaPg(pool) }) };
  }
  return g.__testMigrator.prisma;
}

/** A connection opened by withRole() or openRole(). */
export type RoleClient = pg.Client;
export type QueryResult = pg.QueryResult;

/** An open connection as an arbitrary role, for interleaved (concurrent) transactions. */
export async function openRole(url: string): Promise<RoleClient> {
  const c = new pg.Client({ connectionString: url });
  await c.connect();
  return c;
}

/** Connects as an arbitrary role for privilege/escalation checks. */
export async function withRole<T>(url: string, fn: (c: pg.Client) => Promise<T>): Promise<T> {
  const c = new pg.Client({ connectionString: url });
  await c.connect();
  try {
    return await fn(c);
  } finally {
    await c.end();
  }
}

export async function closeTestDb(): Promise<void> {
  if (g.__testMigrator) {
    await g.__testMigrator.prisma.$disconnect();
    await g.__testMigrator.pool.end();
    delete g.__testMigrator;
  }
}
