// S1-08 transaction-start budget (Prisma `maxWait`). 30 000 ms is the binding value. The only
// other value is the Neon WAN diagnostic override (owner approval 2026-10-21;
// docs/NEON-S1-FAILURE-TRIAGE.md §1d), which scripts/managed-db/s1-managed-run.mjs sets through
// the S1_DIAG_* variables after neon-s1.mjs has verified the test branch. Spike code only: the
// application's own limits live in src/platform/db/client.ts and never read these variables.
// A .env file can never supply them: the s1 project loads .env through
// loadDotenvWithoutDiagnostics() (../setup-env.ts), which refuses these keys in the file.

import { config } from 'dotenv';

export const BINDING_TX_MAX_WAIT_MS = 30_000;
export const MAX_DIAGNOSTIC_TX_MAX_WAIT_MS = 600_000;
/**
 * Diagnostic only: the spike pool's S1_CONNECTION_TIMEOUT_MS must be maxWait + this margin.
 * pg-pool applies that timeout to waiting for a busy pool, so a shorter value would end the
 * wait before the diagnostic maxWait (scripts/managed-db/diagnostic-override.mjs sets it).
 */
export const DIAGNOSTIC_CONNECTION_MARGIN_MS = 10_000;

export interface DiagnosticTarget {
  readonly branchId: string;
  readonly endpointId: string;
  readonly productionBranchIds: readonly string[];
}

export interface DiagnosticBudget extends DiagnosticTarget {
  /** The spike pool's connection (and pool-wait) timeout for this diagnostic. */
  readonly connectionTimeoutMs: number;
}

export interface TxStartBudget {
  readonly maxWaitMs: number;
  /** null for the binding value. */
  readonly diagnostic: DiagnosticBudget | null;
}

const KEYS = [
  'S1_DIAG_TX_MAX_WAIT_MS',
  'S1_DIAG_NEON_BRANCH_ID',
  'S1_DIAG_NEON_ENDPOINT_ID',
  'S1_DIAG_PRODUCTION_BRANCH_IDS',
] as const;

/**
 * Binding unless every S1_DIAG_* variable is present and valid; a partial set throws. With the
 * override, S1_CONNECTION_TIMEOUT_MS must be exactly maxWait + DIAGNOSTIC_CONNECTION_MARGIN_MS
 * (missing, malformed or any other value throws).
 */
export function txStartBudgetFromEnv(
  env: Readonly<Record<string, string | undefined>> = process.env,
): TxStartBudget {
  const present = KEYS.filter((k) => env[k] !== undefined && env[k] !== '');
  if (present.length === 0) return { maxWaitMs: BINDING_TX_MAX_WAIT_MS, diagnostic: null };
  if (present.length !== KEYS.length)
    throw new Error(`incomplete diagnostic override: ${present.join(', ')} set without the rest`);

  const raw = env.S1_DIAG_TX_MAX_WAIT_MS!;
  const ms = Number(raw);
  if (!/^\d+$/.test(raw) || ms <= BINDING_TX_MAX_WAIT_MS || ms > MAX_DIAGNOSTIC_TX_MAX_WAIT_MS)
    throw new Error(
      `S1_DIAG_TX_MAX_WAIT_MS must be above ${BINDING_TX_MAX_WAIT_MS} and at most ${MAX_DIAGNOSTIC_TX_MAX_WAIT_MS}`,
    );
  const branchId = env.S1_DIAG_NEON_BRANCH_ID!;
  const endpointId = env.S1_DIAG_NEON_ENDPOINT_ID!;
  const productionBranchIds = env.S1_DIAG_PRODUCTION_BRANCH_IDS!.split(',').filter(Boolean);
  if (!/^br-[a-z0-9-]+$/.test(branchId))
    throw new Error('S1_DIAG_NEON_BRANCH_ID is not a branch id');
  if (!/^ep-[a-z0-9-]+$/.test(endpointId))
    throw new Error('S1_DIAG_NEON_ENDPOINT_ID is not an endpoint id');
  if (productionBranchIds.length === 0 || productionBranchIds.includes(branchId))
    throw new Error('diagnostic override refused: production branch unknown or targeted');
  const connectionTimeoutMs = ms + DIAGNOSTIC_CONNECTION_MARGIN_MS;
  if (env.S1_CONNECTION_TIMEOUT_MS !== String(connectionTimeoutMs))
    throw new Error(
      `diagnostic override refused: S1_CONNECTION_TIMEOUT_MS must be ${connectionTimeoutMs} ` +
        `(maxWait + ${DIAGNOSTIC_CONNECTION_MARGIN_MS} ms)`,
    );
  return {
    maxWaitMs: ms,
    diagnostic: { branchId, endpointId, productionBranchIds, connectionTimeoutMs },
  };
}

/**
 * Every connection URL the test uses must point at the verified test endpoint (direct or its
 * pooler). Neon endpoints belong to exactly one branch, so this also excludes production.
 */
export function assertDiagnosticHosts(target: DiagnosticTarget, urls: readonly string[]): void {
  for (const url of urls) {
    const label = new URL(url).hostname.split('.')[0];
    if (label !== target.endpointId && label !== `${target.endpointId}-pooler`)
      throw new Error(`diagnostic override refused: a connection is not on ${target.endpointId}`);
  }
}

/** Label added to the S1-08 test name, so a diagnostic result cannot pass for a binding one. */
export function diagnosticLabel(budget: TxStartBudget): string {
  return budget.diagnostic
    ? ` [DIAGNOSTIC, NON-BINDING: transaction-start maxWait ${budget.maxWaitMs} ms, binding value ${BINDING_TX_MAX_WAIT_MS} ms]`
    : '';
}

/** Keys that only the managed runner may set, never a .env file. */
const DIAGNOSTIC_KEY = /^(S1_DIAG_|MANAGED_DIAG_|S1_APP_POOLED$)/;

/**
 * Copies parsed .env values into `target` the way dotenv does (a variable already set, even to
 * '', wins), after refusing any diagnostic key in the file. Nothing is copied if one is found.
 * Only key names are reported, never values.
 */
export function applyDotenvWithoutDiagnostics(
  parsed: Readonly<Record<string, string>>,
  target: Record<string, string | undefined>,
): void {
  const forbidden = Object.keys(parsed).filter((k) => DIAGNOSTIC_KEY.test(k));
  if (forbidden.length)
    throw new Error(
      `the .env file must not define ${forbidden.join(', ')}: the S1-08 diagnostic override ` +
        'and the pooled S1-08 mode come only from the managed runner',
    );
  for (const [k, v] of Object.entries(parsed))
    if (!Object.prototype.hasOwnProperty.call(target, k)) target[k] = v;
}

/** The s1 project's replacement for `dotenv/config` (same file, same precedence). */
export function loadDotenvWithoutDiagnostics(
  target: Record<string, string | undefined> = process.env,
  path?: string,
): void {
  const { parsed } = config({ processEnv: {}, quiet: true, ...(path ? { path } : {}) });
  applyDotenvWithoutDiagnostics(parsed ?? {}, target);
}
