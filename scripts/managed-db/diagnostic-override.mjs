// Diagnostic-only override of the S1-08 transaction-start budget (Prisma `maxWait`) for the
// Neon WAN diagnostic (owner approval 2026-10-21; docs/NEON-S1-FAILURE-TRIAGE.md §1d).
//
// The binding S1-08 value is 30 000 ms (spikes/s1-tenant-isolation/db/diagnostic-override.ts).
// A run with the override:
//   - is accepted only for a Neon target that neon-s1.mjs verified (control plane + server),
//     whose branch is not one of the project's production branches;
//   - may select only the batches below and changes the budget only for S1-08;
//   - is labelled "diagnostic" in the run directory name, state.json, the S1-08 test name and
//     the report, and is never reported as a binding S1-08 result.
// The S1_DIAG_* variables the test reads are set only by s1-managed-run.mjs from this module;
// setting them by hand is refused. With them, the two S1-08 batches also get the spike pool's
// S1_CONNECTION_TIMEOUT_MS = maxWait + 10 000 ms (310 000 for 300 000): pg-pool applies that
// timeout to waiting for a busy pool, so a shorter one would cap the diagnostic budget. The
// runner sets it last, over any ambient value, and records both in state.json and the report.
//
// Handoff neon-s1.mjs -> s1-managed-run.mjs: the runner accepts MANAGED_DIAG_TX_MAX_WAIT_MS only
// with a one-time authorization that neon-s1.mjs issues after verifying the target. It is a
// file in a fresh private temp directory holding the SHA-256 of a random nonce, the issuing
// process id and SHA-256 of the exact MANAGED_TARGET, plus the timeout, batches and hosts it
// was issued for. The nonce itself travels only in the child's environment. The runner deletes
// the file before validating it (single use), requires its parent process to be the issuer,
// and refuses it when expired or when anything differs. This stops a direct invocation with
// hand-set MANAGED_TARGET/MANAGED_DIAG_TX_MAX_WAIT_MS. It is not a defence against someone
// editing this code; the server identity checks in the runner and the test still apply.
import { createHash, randomBytes, timingSafeEqual } from 'node:crypto';
import { lstatSync, mkdtempSync, readFileSync, rmdirSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { basename, dirname, join, resolve } from 'node:path';

export const BINDING_TX_MAX_WAIT_MS = 30_000;
export const MAX_DIAGNOSTIC_TX_MAX_WAIT_MS = 600_000;
/** Batches a diagnostic invocation may run. db-roles does not use the spike runner. */
export const DIAGNOSTIC_BATCHES = ['s1-08', 'pooled-s1-08', 'db-roles'];
/** Batches whose transaction-start budget the override changes. */
export const DIAGNOSTIC_APPLIES_TO = ['s1-08', 'pooled-s1-08'];
/** The diagnostic pool-wait timeout is the transaction-start budget plus this margin. */
export const DIAGNOSTIC_CONNECTION_MARGIN_MS = 10_000;

const BRANCH_ID = /^br-[a-z0-9-]+$/;
const ENDPOINT_ID = /^ep-[a-z0-9-]+$/;

/** Throws unless the request is a well-formed diagnostic against a verified Neon test branch. */
export function validateDiagnosticRequest({ maxWaitMs, batches, target }) {
  if (!/^\d+$/.test(String(maxWaitMs ?? '')))
    throw new Error('diagnostic transaction-start maxWait must be a whole number of milliseconds');
  const ms = Number(maxWaitMs);
  if (ms <= BINDING_TX_MAX_WAIT_MS || ms > MAX_DIAGNOSTIC_TX_MAX_WAIT_MS)
    throw new Error(
      `diagnostic transaction-start maxWait must be above the binding ${BINDING_TX_MAX_WAIT_MS} ms ` +
        `and at most ${MAX_DIAGNOSTIC_TX_MAX_WAIT_MS} ms`,
    );
  if (target?.provider !== 'Neon')
    throw new Error('the diagnostic override is only for a verified Neon test branch');
  if (!BRANCH_ID.test(target.branchId ?? '')) throw new Error('verified branch id missing');
  if (!ENDPOINT_ID.test(target.endpointId ?? '')) throw new Error('verified endpoint id missing');
  const prod = target.productionBranchIds;
  if (!Array.isArray(prod) || prod.length === 0 || !prod.every((p) => BRANCH_ID.test(p)))
    throw new Error('production branch ids unknown: cannot exclude the production branch');
  if (prod.includes(target.branchId))
    throw new Error('the diagnostic override must never target a production branch');
  const list = String(batches ?? '')
    .split(',')
    .map((s) => s.trim())
    .filter(Boolean);
  if (list.length === 0)
    throw new Error('the diagnostic override needs an explicit --batches list');
  const other = list.filter((b) => !DIAGNOSTIC_BATCHES.includes(b));
  if (other.length)
    throw new Error(
      `batches not allowed in a diagnostic run: ${other.join(', ')} (allowed: ${DIAGNOSTIC_BATCHES.join(', ')})`,
    );
  const appliesTo = list.filter((b) => DIAGNOSTIC_APPLIES_TO.includes(b));
  if (appliesTo.length === 0)
    throw new Error('a diagnostic run must select s1-08 and/or pooled-s1-08');
  return {
    binding: false,
    purpose:
      'WAN diagnostic of S1-08 transaction-start timeouts (docs/NEON-S1-FAILURE-TRIAGE.md §1d)',
    txStartMaxWaitMs: ms,
    bindingTxStartMaxWaitMs: BINDING_TX_MAX_WAIT_MS,
    connectionTimeoutMs: ms + DIAGNOSTIC_CONNECTION_MARGIN_MS,
    appliesTo,
    branchId: target.branchId,
    endpointId: target.endpointId,
    productionBranchIds: prod,
  };
}

/** The S1_DIAG_* variables may only come from the runner. */
export function assertNoDirectDiagnosticEnv(env) {
  const keys = Object.keys(env).filter((k) => k.startsWith('S1_DIAG_'));
  if (keys.length)
    throw new Error(
      `${keys.join(', ')} must not be set by hand; use neon-s1.mjs --diagnostic-tx-max-wait-ms`,
    );
}

/** neon-s1.mjs: every MANAGED_DIAG_* variable is set by it, never inherited from the shell. */
export function assertNoManagedDiagnosticEnv(env) {
  const keys = Object.keys(env).filter((k) => k.startsWith('MANAGED_DIAG_'));
  if (keys.length)
    throw new Error(
      `${keys.join(', ')} must not be set by hand; use neon-s1.mjs --diagnostic-tx-max-wait-ms`,
    );
}

/** Environment for the S1-08 test process of a diagnostic batch. Throws if inconsistent. */
export function diagnosticTestEnv(d) {
  const ms = d?.txStartMaxWaitMs;
  if (
    !Number.isInteger(ms) ||
    ms <= BINDING_TX_MAX_WAIT_MS ||
    ms > MAX_DIAGNOSTIC_TX_MAX_WAIT_MS ||
    d.connectionTimeoutMs !== ms + DIAGNOSTIC_CONNECTION_MARGIN_MS
  )
    throw new Error(
      'diagnostic override refused: transaction-start maxWait or connection timeout missing or inconsistent',
    );
  return {
    S1_DIAG_TX_MAX_WAIT_MS: String(ms),
    S1_DIAG_NEON_BRANCH_ID: d.branchId,
    S1_DIAG_NEON_ENDPOINT_ID: d.endpointId,
    S1_DIAG_PRODUCTION_BRANCH_IDS: d.productionBranchIds.join(','),
    S1_CONNECTION_TIMEOUT_MS: String(d.connectionTimeoutMs),
  };
}

/** The S1_DIAG_* variables a batch's test process gets: only the two S1-08 batches, only with a diagnostic. */
export function diagnosticEnvFor(batchName, d) {
  return d && DIAGNOSTIC_APPLIES_TO.includes(batchName) && d.appliesTo.includes(batchName)
    ? diagnosticTestEnv(d)
    : {};
}

/**
 * A batch's test environment: `env` with the diagnostic values (if any) applied last, so an
 * ambient S1_CONNECTION_TIMEOUT_MS never replaces the diagnostic one.
 */
export function withDiagnosticEnv(env, batchName, d) {
  return { ...env, ...diagnosticEnvFor(batchName, d) };
}

/** What state.json records for a diagnostic batch: the values its test process was given. */
export function diagnosticSettingsOf(testEnv) {
  if (testEnv.S1_DIAG_TX_MAX_WAIT_MS === undefined) return null;
  return {
    kind: 'diagnostic configuration (non-binding), not a test outcome',
    txStartMaxWaitMs: Number(testEnv.S1_DIAG_TX_MAX_WAIT_MS),
    connectionTimeoutMs: Number(testEnv.S1_CONNECTION_TIMEOUT_MS),
  };
}

// --- one-time authorization (see the header) ---

export const AUTH_FILE_ENV = 'MANAGED_DIAG_AUTH_FILE';
export const AUTH_NONCE_ENV = 'MANAGED_DIAG_AUTH_NONCE';
export const AUTH_TTL_MS = 120_000;
const AUTH_DIR_PREFIX = 'cbr-s1-diag-';
const AUTH_DIR = /^cbr-s1-diag-[A-Za-z0-9]{6}$/;
const AUTH_FILE_NAME = 'authorization.json';
const NONCE = /^[A-Za-z0-9_-]{43}$/;

const sha256 = (s) => createHash('sha256').update(String(s)).digest('hex');
const sameHash = (a, b) =>
  typeof b === 'string' && a.length === b.length && timingSafeEqual(Buffer.from(a), Buffer.from(b));
const batchKey = (b) =>
  String(b ?? '')
    .split(',')
    .map((s) => s.trim())
    .filter(Boolean)
    .sort()
    .join(',');
const hostOf = (url) => {
  try {
    return new URL(url).hostname;
  } catch {
    return null;
  }
};
const refuse = (why) => {
  throw new Error(`diagnostic override refused: ${why}`);
};

/**
 * neon-s1.mjs, after verifying the target and validating `diag`: writes the one-time
 * authorization and returns its directory (to remove after the runner exits) and the two
 * variables for the runner's environment. Nothing here is logged.
 */
export function issueDiagnosticAuthorization({
  diag,
  targetJson,
  batches,
  adminHost,
  poolHost,
  issuerPid = process.pid,
  now = Date.now(),
}) {
  const dir = mkdtempSync(join(tmpdir(), AUTH_DIR_PREFIX));
  const nonce = randomBytes(32).toString('base64url');
  const file = join(dir, AUTH_FILE_NAME);
  const token = {
    version: 1,
    nonceSha256: sha256(nonce),
    issuerPid,
    issuedAt: now,
    expiresAt: now + AUTH_TTL_MS,
    targetSha256: sha256(targetJson),
    txStartMaxWaitMs: diag.txStartMaxWaitMs,
    batches: batchKey(batches),
    adminHost,
    poolHost: poolHost ?? '',
  };
  writeFileSync(file, JSON.stringify(token), { flag: 'wx', mode: 0o600 });
  return { dir, env: { [AUTH_FILE_ENV]: file, [AUTH_NONCE_ENV]: nonce } };
}

/** Only a file neon-s1.mjs could have issued: <tmpdir>/cbr-s1-diag-XXXXXX/authorization.json. */
function authorizationPath(file) {
  const p = resolve(file);
  const dir = dirname(p);
  const same = (a, b) =>
    process.platform === 'win32' ? a.toLowerCase() === b.toLowerCase() : a === b;
  if (
    basename(p) !== AUTH_FILE_NAME ||
    !AUTH_DIR.test(basename(dir)) ||
    !same(dirname(dir), resolve(tmpdir()))
  )
    refuse('the authorization file is not one issued by neon-s1.mjs');
  return p;
}

/**
 * s1-managed-run.mjs, at start-up: null for an ordinary run (no override and no authorization);
 * otherwise consumes the one-time authorization and returns the validated diagnostic. Throws
 * (fail closed) when the authorization is missing, malformed, used, expired, issued to another
 * process, or inconsistent with the target, timeout, batches or hosts of this invocation.
 */
export function authorizeDiagnosticRun(env, { ppid = process.ppid, now = Date.now() } = {}) {
  const maxWait = env.MANAGED_DIAG_TX_MAX_WAIT_MS;
  const file = env[AUTH_FILE_ENV];
  const nonce = env[AUTH_NONCE_ENV];
  if (!maxWait) {
    if (file || nonce) refuse('an authorization was passed without an override');
    return null;
  }
  if (!file || !nonce)
    refuse('no authorization from neon-s1.mjs (a direct runner invocation cannot enable it)');
  if (!NONCE.test(nonce)) refuse('malformed authorization');
  const path = authorizationPath(file);
  let raw;
  try {
    if (!lstatSync(path).isFile()) refuse('the authorization is not a regular file');
    raw = readFileSync(path, 'utf8');
  } catch (e) {
    if (String(e?.message).startsWith('diagnostic override refused')) throw e;
    refuse('authorization missing or already used');
  }
  // Single use: removed before it is checked, so no outcome leaves it reusable.
  rmSync(path, { force: true });
  try {
    rmdirSync(dirname(path));
  } catch {
    // not empty or already gone; neon-s1.mjs removes the directory after the run
  }
  let token;
  try {
    token = JSON.parse(raw);
  } catch {
    refuse('malformed authorization');
  }
  if (token?.version !== 1) refuse('malformed authorization');
  if (!sameHash(sha256(nonce), token.nonceSha256)) refuse('the authorization does not match');
  if (token.issuerPid !== ppid) refuse('the authorization was issued to another process');
  if (!(now >= token.issuedAt - 5_000 && now <= token.expiresAt))
    refuse('the authorization expired');
  if (!sameHash(sha256(env.MANAGED_TARGET ?? ''), token.targetSha256))
    refuse('MANAGED_TARGET differs from the target neon-s1.mjs verified');
  if (String(token.txStartMaxWaitMs) !== String(maxWait))
    refuse('the timeout differs from the authorized one');
  if (batchKey(env.MANAGED_BATCHES) !== token.batches)
    refuse('the batches differ from the authorized ones');
  const target = JSON.parse(env.MANAGED_TARGET);
  const adminHost = hostOf(env.MANAGED_ADMIN_URL);
  if (!adminHost || adminHost !== token.adminHost || adminHost.split('.')[0] !== target.endpointId)
    refuse('the admin host is not the verified endpoint');
  const poolHost = env.MANAGED_POOL_HOST ?? '';
  if (
    poolHost !== token.poolHost ||
    (poolHost && poolHost.split('.')[0] !== `${target.endpointId}-pooler`)
  )
    refuse('the pool host is not the verified pooler');
  if (env.MANAGED_POOL_NAME || env.MANAGED_POOL_PORT)
    refuse('MANAGED_POOL_NAME/MANAGED_POOL_PORT do not apply to a Neon diagnostic');
  if (
    env.MANAGED_REHEARSAL === '1' ||
    (env.MANAGED_SSLMODE && env.MANAGED_SSLMODE !== 'verify-full')
  )
    refuse('a diagnostic needs the managed target with verify-full TLS');
  return validateDiagnosticRequest({ maxWaitMs: maxWait, batches: env.MANAGED_BATCHES, target });
}
