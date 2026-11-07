// Unit tests (no database, no network): the runner accepts the S1-08 diagnostic override only
// with the one-time authorization neon-s1.mjs issues, bound to its process, target, timeout,
// batches and hosts. Synthetic identifiers only.
import { existsSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join } from 'node:path';
import { afterEach, describe, expect, it } from 'vitest';
import {
  AUTH_FILE_ENV,
  AUTH_NONCE_ENV,
  AUTH_TTL_MS,
  authorizeDiagnosticRun,
  issueDiagnosticAuthorization,
  validateDiagnosticRequest,
} from './diagnostic-override.mjs';

const ISSUER = 4242;
const target = {
  provider: 'Neon',
  projectId: 'test-project-1',
  branchId: 'br-test-branch-1',
  endpointId: 'ep-test-endpoint-1',
  productionBranchIds: ['br-prod-branch-1'],
};
const targetJson = JSON.stringify(target);
const BATCHES = 's1-08,pooled-s1-08,db-roles';
const ADMIN_HOST = 'ep-test-endpoint-1.c-1.us-east-2.aws.neon.invalid';
const POOL_HOST = 'ep-test-endpoint-1-pooler.c-1.us-east-2.aws.neon.invalid';

const dirs = [];
afterEach(() => {
  for (const d of dirs.splice(0)) rmSync(d, { recursive: true, force: true });
});

/** What neon-s1.mjs does after verification: issue, then the runner's environment. */
function issue(overrides = {}) {
  const diag = validateDiagnosticRequest({ maxWaitMs: '300000', batches: BATCHES, target });
  const auth = issueDiagnosticAuthorization({
    diag,
    targetJson,
    batches: BATCHES,
    adminHost: ADMIN_HOST,
    poolHost: POOL_HOST,
    issuerPid: ISSUER,
    ...overrides,
  });
  dirs.push(auth.dir);
  const env = {
    MANAGED_ADMIN_URL: `postgresql://neondb_owner:pw@${ADMIN_HOST}/neondb`,
    MANAGED_POOL_HOST: POOL_HOST,
    MANAGED_TARGET: targetJson,
    MANAGED_BATCHES: BATCHES,
    MANAGED_DIAG_TX_MAX_WAIT_MS: '300000',
    ...auth.env,
  };
  return { auth, env };
}
const authorize = (env, opts = {}) => authorizeDiagnosticRun(env, { ppid: ISSUER, ...opts });

describe('authorizeDiagnosticRun', () => {
  it('ordinary run: no override and no authorization -> null (runner usable as before)', () => {
    expect(authorizeDiagnosticRun({})).toBeNull();
    expect(authorizeDiagnosticRun({ MANAGED_DIAG_TX_MAX_WAIT_MS: '' })).toBeNull();
  });

  it('accepts the authorization once, for its issuer, and returns the validated diagnostic', () => {
    const { auth, env } = issue();
    expect(authorize(env)).toMatchObject({
      binding: false,
      txStartMaxWaitMs: 300_000,
      branchId: 'br-test-branch-1',
      appliesTo: ['s1-08', 'pooled-s1-08'],
    });
    expect(existsSync(auth.env[AUTH_FILE_ENV])).toBe(false);
    // Reuse: the file is gone.
    expect(() => authorize(env)).toThrow(/missing or already used/);
  });

  it('direct invocation: hand-set MANAGED_TARGET + MANAGED_DIAG_TX_MAX_WAIT_MS is refused', () => {
    const { env } = issue();
    const direct = { ...env };
    delete direct[AUTH_FILE_ENV];
    delete direct[AUTH_NONCE_ENV];
    expect(() => authorize(direct)).toThrow(/no authorization from neon-s1.mjs/);
  });

  it('refuses an authorization passed without an override', () => {
    const { env } = issue();
    expect(() => authorize({ ...env, MANAGED_DIAG_TX_MAX_WAIT_MS: '' })).toThrow(
      /without an override/,
    );
  });

  it('refuses a malformed or wrong nonce, and the attempt consumes the authorization', () => {
    const { env } = issue();
    expect(() => authorize({ ...env, [AUTH_NONCE_ENV]: 'short' })).toThrow(/malformed/);
    expect(() => authorize({ ...env, [AUTH_NONCE_ENV]: 'A'.repeat(43) })).toThrow(/does not match/);
    expect(() => authorize(env)).toThrow(/already used/); // spent by the failed attempt
  });

  it('refuses a different parent process (not started by the issuing neon-s1.mjs)', () => {
    const { env } = issue();
    expect(() => authorize(env, { ppid: ISSUER + 1 })).toThrow(/another process/);
  });

  it('refuses an expired authorization', () => {
    const { env } = issue({ now: Date.now() - AUTH_TTL_MS - 1 });
    expect(() => authorize(env)).toThrow(/expired/);
  });

  it.each([
    [
      'a target edited to aim at the production branch',
      {
        MANAGED_TARGET: JSON.stringify({
          ...target,
          branchId: 'br-prod-branch-1',
          productionBranchIds: ['br-other-1'],
        }),
      },
      /MANAGED_TARGET differs/,
    ],
    ['a different timeout', { MANAGED_DIAG_TX_MAX_WAIT_MS: '600000' }, /timeout differs/],
    ['extra batches', { MANAGED_BATCHES: `${BATCHES},s1-17` }, /batches differ/],
    ['fewer batches', { MANAGED_BATCHES: 's1-08' }, /batches differ/],
    [
      'another admin host',
      { MANAGED_ADMIN_URL: 'postgresql://u:p@ep-production-1.c-1.aws.neon.invalid/neondb' },
      /admin host/,
    ],
    ['a malformed admin URL', { MANAGED_ADMIN_URL: 'not a url' }, /admin host/],
    [
      'another pool host',
      { MANAGED_POOL_HOST: 'ep-production-1-pooler.neon.invalid' },
      /pool host/,
    ],
    ['a DigitalOcean pool name', { MANAGED_POOL_NAME: 's1-pool' }, /POOL_NAME/],
    ['the local rehearsal', { MANAGED_REHEARSAL: '1' }, /verify-full/],
    ['TLS turned off', { MANAGED_SSLMODE: 'disable' }, /verify-full/],
  ])('refuses %s', (_, change, err) => {
    const { env } = issue();
    expect(() => authorize({ ...env, ...change })).toThrow(err);
  });

  it('accepts the same batches in another order', () => {
    const { env } = issue();
    expect(authorize({ ...env, MANAGED_BATCHES: 'db-roles,pooled-s1-08,s1-08' })).not.toBeNull();
  });

  it('never reads or deletes a file outside a neon-s1.mjs authorization directory', () => {
    const d = mkdtempSync(join(tmpdir(), 'cbr-other-'));
    dirs.push(d);
    const victim = join(d, 'authorization.json');
    writeFileSync(victim, '{}');
    const { env } = issue();
    expect(() => authorize({ ...env, [AUTH_FILE_ENV]: victim })).toThrow(/not one issued/);
    expect(existsSync(victim)).toBe(true);
    const inRepo = join(process.cwd(), 'package.json');
    expect(() => authorize({ ...env, [AUTH_FILE_ENV]: inRepo })).toThrow(/not one issued/);
    expect(existsSync(inRepo)).toBe(true);
  });

  it('refuses a forged file in a look-alike directory (wrong nonce hash)', () => {
    const { env } = issue();
    const forgedDir = mkdtempSync(join(tmpdir(), 'cbr-s1-diag-'));
    dirs.push(forgedDir);
    const forged = join(forgedDir, 'authorization.json');
    writeFileSync(forged, JSON.stringify({ version: 1, nonceSha256: 'x', issuerPid: ISSUER }));
    expect(() => authorize({ ...env, [AUTH_FILE_ENV]: forged })).toThrow(/does not match/);
    expect(existsSync(forged)).toBe(false); // consumed
    expect(existsSync(dirname(forged))).toBe(false);
  });
});
