// S1 db gateway: the only spike folder allowed to import the raw generated client.
import { PrismaPg } from '@prisma/adapter-pg';
import pg from 'pg';
import { createTenantRunner } from '@/platform/db/with-tenant';
import { PrismaClient } from '../generated/prisma/client';
import {
  BINDING_TX_MAX_WAIT_MS,
  type DiagnosticTarget,
  type TxStartBudget,
} from './diagnostic-override';

export type { Prisma, MembershipRole } from '../generated/prisma/client';

function requireEnv(name: string): string {
  const value = process.env[name];
  if (!value) throw new Error(`${name} is not set (see .env.example)`);
  return value;
}

export interface ClientHandle {
  readonly prisma: PrismaClient;
  readonly pool: pg.Pool;
  close(): Promise<void>;
}

// Remote runs (S1-18) queue longer for a pooled connection: 50 workers share 5 connections and
// every query pays the network round trip. Local default unchanged.
const connectionTimeoutMillis = Number(process.env.S1_CONNECTION_TIMEOUT_MS ?? 10_000);

function create(url: string, max: number): ClientHandle {
  const pool = new pg.Pool({ connectionString: url, max, connectionTimeoutMillis });
  const prisma = new PrismaClient({ adapter: new PrismaPg(pool) });
  return {
    prisma,
    pool,
    async close() {
      await prisma.$disconnect();
      await pool.end();
    },
  };
}

/** Runtime role crm_app (subject to RLS). */
export const createAppClient = (max = 5) => create(requireEnv('S1_APP_URL'), max);
/** Schema owner. Test setup/seeding and structural (FK) checks only. */
export const createMigratorClient = (max = 5) => create(requireEnv('S1_MIGRATOR_URL'), max);
/** Platform-admin role. */
export const createPlatformClient = (max = 2) => create(requireEnv('S1_PLATFORM_URL'), max);

/**
 * Pool for the S1-17 "without RLS" baseline only: the local superuser, or on managed hosting
 * the provider admin (S1_BASELINE_URL; DigitalOcean's doadmin has BYPASSRLS). Both bypass RLS;
 * neither is ever used by the app.
 */
export function createLocalSuperuserBaselinePool(): pg.Pool {
  if (process.env.S1_BASELINE_URL)
    return new pg.Pool({ connectionString: process.env.S1_BASELINE_URL, max: 1 });
  const password = requireEnv('POSTGRES_SUPERUSER_PASSWORD');
  const url = new URL(requireEnv('S1_MIGRATOR_URL'));
  url.username = 'postgres';
  url.password = password;
  return new pg.Pool({ connectionString: url.toString(), max: 1 });
}

/**
 * `maxWait` (transaction-start budget) is 30 s unless S1-08 passes the Neon diagnostic budget
 * (./diagnostic-override.ts). `timeout` is never overridden.
 */
export function tenantRunnerFor(handle: ClientHandle, budget?: TxStartBudget) {
  return createTenantRunner(handle.prisma, {
    maxWait: budget?.maxWaitMs ?? BINDING_TX_MAX_WAIT_MS,
    timeout: 30_000,
  });
}

/**
 * Diagnostic override only: the server behind `handle` must report the verified Neon test
 * branch. A NULL (not Neon) or different branch throws. If the role may not read the setting,
 * the endpoint-host check and the runner's admin-side check (s1-managed-run.mjs) still apply;
 * the result says which.
 */
export async function assertDiagnosticServer(
  handle: ClientHandle,
  target: DiagnosticTarget,
): Promise<'branch matched' | 'branch setting not readable by this role'> {
  let branch: string | null;
  try {
    const { rows } = await handle.pool.query<{ branch: string | null }>(
      "SELECT current_setting('neon.branch_id', true) AS branch",
    );
    branch = rows[0]?.branch ?? null;
  } catch (e) {
    if (/permission denied|must be superuser/i.test((e as Error).message))
      return 'branch setting not readable by this role';
    throw e;
  }
  if (branch === null || branch === '')
    throw new Error('diagnostic override refused: not a Neon server');
  if (target.productionBranchIds.includes(branch) || branch !== target.branchId)
    throw new Error('diagnostic override refused: server is not the verified Neon test branch');
  return 'branch matched';
}
