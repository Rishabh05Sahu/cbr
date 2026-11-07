// Entry-point tests of scripts/managed-db/s1-managed-run.mjs (no database, no network): the real
// runner is started with synthetic values and must stop at start-up. Every case either refuses the
// diagnostic override or gets past it and then stops at the existing "MANAGED_CA_FILE is
// required" check (no CA file is given), which runs before any directory is created or any
// connection is made. Hosts use the reserved .invalid domain.
import { spawnSync } from 'node:child_process';
import { existsSync, readdirSync, rmSync } from 'node:fs';
import { afterEach, describe, expect, it } from 'vitest';
import {
  AUTH_FILE_ENV,
  issueDiagnosticAuthorization,
  validateDiagnosticRequest,
} from './diagnostic-override.mjs';

const RUNNER = 'scripts/managed-db/s1-managed-run.mjs';
const RESULT_DIRS = ['spikes/results/managed-runs', 'spikes/results/managed-rehearsal'];
const target = {
  provider: 'Neon',
  branchId: 'br-test-branch-1',
  endpointId: 'ep-test-endpoint-1',
  productionBranchIds: ['br-prod-branch-1'],
};
const BATCHES = 's1-08,pooled-s1-08,db-roles';
const ADMIN_HOST = 'ep-test-endpoint-1.example.invalid';
const POOL_HOST = 'ep-test-endpoint-1-pooler.example.invalid';

// Only what node needs; nothing from the developer's environment or .env reaches the runner.
const baseEnv = Object.fromEntries(
  ['PATH', 'Path', 'SystemRoot', 'TEMP', 'TMP', 'TMPDIR', 'HOME', 'USERPROFILE']
    .filter((k) => process.env[k] !== undefined)
    .map((k) => [k, process.env[k]]),
);
const managedEnv = {
  MANAGED_ADMIN_URL: `postgresql://synthetic:synthetic@${ADMIN_HOST}/neondb`,
  MANAGED_POOL_HOST: POOL_HOST,
  MANAGED_TARGET: JSON.stringify(target),
  MANAGED_BATCHES: BATCHES,
};

const listing = () =>
  RESULT_DIRS.map((d) => (existsSync(d) ? readdirSync(d).sort().join(',') : '(none)'));
const before = listing();

const dirs = [];
afterEach(() => {
  for (const d of dirs.splice(0)) rmSync(d, { recursive: true, force: true });
  // No run directory is ever created by these start-up failures.
  expect(listing()).toEqual(before);
});

function runRunner(env) {
  const r = spawnSync(process.execPath, [RUNNER], {
    env: { ...baseEnv, ...env },
    encoding: 'utf8',
    timeout: 30_000,
  });
  return { status: r.status, stderr: r.stderr };
}

/** The runner is our direct child, so issue the authorization with this process as issuer. */
function authorized() {
  const diag = validateDiagnosticRequest({ maxWaitMs: '300000', batches: BATCHES, target });
  const auth = issueDiagnosticAuthorization({
    diag,
    targetJson: managedEnv.MANAGED_TARGET,
    batches: BATCHES,
    adminHost: ADMIN_HOST,
    poolHost: POOL_HOST,
    issuerPid: process.pid,
  });
  dirs.push(auth.dir);
  return { ...managedEnv, MANAGED_DIAG_TX_MAX_WAIT_MS: '300000', ...auth.env };
}

describe('s1-managed-run.mjs start-up', () => {
  it('ordinary run without an override: passes the override gate (then needs its CA file)', () => {
    const r = runRunner(managedEnv);
    expect(r.status).not.toBe(0);
    expect(r.stderr).toMatch(/MANAGED_CA_FILE is required/);
    expect(r.stderr).not.toMatch(/diagnostic override refused/);
  });

  it('direct invocation with hand-set MANAGED_TARGET and MANAGED_DIAG_TX_MAX_WAIT_MS is refused', () => {
    const r = runRunner({ ...managedEnv, MANAGED_DIAG_TX_MAX_WAIT_MS: '300000' });
    expect(r.status).not.toBe(0);
    expect(r.stderr).toMatch(/diagnostic override refused: no authorization from neon-s1.mjs/);
  });

  it('hand-set S1_DIAG_* variables are refused before anything else', () => {
    const r = runRunner({ ...managedEnv, S1_DIAG_TX_MAX_WAIT_MS: '300000' });
    expect(r.status).not.toBe(0);
    expect(r.stderr).toMatch(/S1_DIAG_TX_MAX_WAIT_MS must not be set by hand/);
  });

  it('an authorization issued by the parent is accepted once; a replay is refused', () => {
    const env = authorized();
    const first = runRunner(env);
    expect(first.stderr).not.toMatch(/diagnostic override refused/);
    expect(first.stderr).toMatch(/MANAGED_CA_FILE is required/);
    expect(existsSync(env[AUTH_FILE_ENV])).toBe(false);
    const replay = runRunner(env);
    expect(replay.status).not.toBe(0);
    expect(replay.stderr).toMatch(/missing or already used/);
  });

  it('an authorization with a tampered target or extra batch is refused', () => {
    const tampered = {
      ...authorized(),
      MANAGED_TARGET: JSON.stringify({ ...target, branchId: 'br-prod-branch-1' }),
    };
    expect(runRunner(tampered).stderr).toMatch(/MANAGED_TARGET differs/);
    const extra = { ...authorized(), MANAGED_BATCHES: `${BATCHES},s1-17` };
    expect(runRunner(extra).stderr).toMatch(/batches differ/);
  });

  it('the nonce never appears in the runner output', () => {
    const env = authorized();
    const r = runRunner({ ...env, MANAGED_BATCHES: 's1-08' });
    expect(r.stderr).toMatch(/batches differ/);
    expect(r.stderr).not.toContain(env.MANAGED_DIAG_AUTH_NONCE);
  });
});
