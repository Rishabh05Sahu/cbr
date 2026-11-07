import { describe, expect, it } from 'vitest';
import {
  assertNoDirectDiagnosticEnv,
  assertNoManagedDiagnosticEnv,
  diagnosticEnvFor,
  diagnosticSettingsOf,
  diagnosticTestEnv,
  validateDiagnosticRequest,
  withDiagnosticEnv,
} from './diagnostic-override.mjs';

const target = {
  provider: 'Neon',
  branchId: 'br-test-branch-1',
  endpointId: 'ep-test-endpoint-1',
  productionBranchIds: ['br-prod-branch-1'],
};
const ok = { maxWaitMs: '300000', batches: 's1-08,pooled-s1-08,db-roles', target };

describe('validateDiagnosticRequest', () => {
  it('accepts a verified Neon test branch, the allowed batches and a value above 30 s', () => {
    expect(validateDiagnosticRequest(ok)).toMatchObject({
      binding: false,
      txStartMaxWaitMs: 300_000,
      bindingTxStartMaxWaitMs: 30_000,
      connectionTimeoutMs: 310_000,
      appliesTo: ['s1-08', 'pooled-s1-08'],
      branchId: 'br-test-branch-1',
    });
  });

  it.each([
    ['30000', /above the binding/],
    ['1000', /above the binding/],
    ['600001', /at most/],
    ['5e5', /whole number/],
    ['', /whole number/],
    [undefined, /whole number/],
  ])('rejects maxWait %s', (maxWaitMs, err) => {
    expect(() => validateDiagnosticRequest({ ...ok, maxWaitMs })).toThrow(err);
  });

  it('rejects the production branch, unknown production ids and non-Neon targets', () => {
    const prod = { ...target, productionBranchIds: ['br-test-branch-1'] };
    expect(() => validateDiagnosticRequest({ ...ok, target: prod })).toThrow(/production/);
    for (const productionBranchIds of [[], undefined, ['not-a-branch']])
      expect(() =>
        validateDiagnosticRequest({ ...ok, target: { ...target, productionBranchIds } }),
      ).toThrow(/production branch ids unknown/);
    expect(() =>
      validateDiagnosticRequest({ ...ok, target: { ...target, provider: 'DigitalOcean' } }),
    ).toThrow(/Neon/);
    expect(() => validateDiagnosticRequest({ ...ok, target: null })).toThrow(/Neon/);
  });

  it('requires an explicit batch list limited to the S1-08 batches and db-roles', () => {
    expect(() => validateDiagnosticRequest({ ...ok, batches: undefined })).toThrow(/explicit/);
    expect(() => validateDiagnosticRequest({ ...ok, batches: 's1-08,s1-17' })).toThrow(/s1-17/);
    expect(() => validateDiagnosticRequest({ ...ok, batches: 'db-roles' })).toThrow(/s1-08/);
  });
});

describe('diagnostic environment', () => {
  it('refuses S1_DIAG_* variables set by hand', () => {
    expect(() => assertNoDirectDiagnosticEnv({ S1_DIAG_TX_MAX_WAIT_MS: '1' })).toThrow(/by hand/);
    expect(() => assertNoDirectDiagnosticEnv({ PATH: 'x' })).not.toThrow();
  });

  it('neon-s1.mjs refuses every MANAGED_DIAG_* variable from the shell, even empty', () => {
    for (const k of [
      'MANAGED_DIAG_TX_MAX_WAIT_MS',
      'MANAGED_DIAG_AUTH_FILE',
      'MANAGED_DIAG_AUTH_NONCE',
    ])
      expect(() => assertNoManagedDiagnosticEnv({ [k]: '' })).toThrow(/by hand/);
    expect(() => assertNoManagedDiagnosticEnv({ MANAGED_BATCHES: 's1-08' })).not.toThrow();
  });

  it('only the two S1-08 batches of a diagnostic run get S1_DIAG_* (no inheritance elsewhere)', () => {
    const d = validateDiagnosticRequest(ok);
    expect(Object.keys(diagnosticEnvFor('s1-08', d))).toHaveLength(5);
    expect(Object.keys(diagnosticEnvFor('pooled-s1-08', d))).toHaveLength(5);
    for (const b of ['db-roles', 's1-17', 's1-03-07', 'pooled-s1-03-07', 'mutation'])
      expect(diagnosticEnvFor(b, d)).toEqual({});
    // A diagnostic that selected only s1-08 does not extend to pooled-s1-08.
    const onlyDirect = validateDiagnosticRequest({ ...ok, batches: 's1-08' });
    expect(diagnosticEnvFor('pooled-s1-08', onlyDirect)).toEqual({});
    // Ordinary run: nothing for any batch.
    for (const b of ['s1-08', 'pooled-s1-08', 'db-roles'])
      expect(diagnosticEnvFor(b, null)).toEqual({});
  });

  it('passes the validated values to the test', () => {
    expect(diagnosticTestEnv(validateDiagnosticRequest(ok))).toEqual({
      S1_DIAG_TX_MAX_WAIT_MS: '300000',
      S1_DIAG_NEON_BRANCH_ID: 'br-test-branch-1',
      S1_DIAG_NEON_ENDPOINT_ID: 'ep-test-endpoint-1',
      S1_DIAG_PRODUCTION_BRANCH_IDS: 'br-prod-branch-1',
      S1_CONNECTION_TIMEOUT_MS: '310000',
    });
  });
});

describe('B2: diagnostic connection timeout', () => {
  const d = validateDiagnosticRequest(ok);
  // What neon-s1.mjs passes to every runner child, plus a batch's own values.
  const ambient = { S1_CONNECTION_TIMEOUT_MS: '120000', S1_APP_URL: 'synthetic' };

  it('is maxWait + 10 000 ms: 310 000 for the approved 300 000', () => {
    expect(d.connectionTimeoutMs).toBe(310_000);
    expect(validateDiagnosticRequest({ ...ok, maxWaitMs: '600000' }).connectionTimeoutMs).toBe(
      610_000,
    );
  });

  it('reaches only s1-08 and pooled-s1-08, replacing the ambient value', () => {
    for (const b of ['s1-08', 'pooled-s1-08']) {
      const env = withDiagnosticEnv(ambient, b, d);
      expect(env).toMatchObject({
        S1_CONNECTION_TIMEOUT_MS: '310000',
        S1_DIAG_TX_MAX_WAIT_MS: '300000',
      });
      expect(env.S1_APP_URL).toBe('synthetic');
    }
    for (const b of ['db-roles', 's1-17', 's1-03-07', 'pooled-s1-03-07', 'mutation-permissive'])
      expect(withDiagnosticEnv(ambient, b, d)).toEqual(ambient);
  });

  it('an ordinary run is unchanged: the ambient value stays and nothing is added', () => {
    for (const b of ['s1-08', 'pooled-s1-08', 'db-roles'])
      expect(withDiagnosticEnv(ambient, b, null)).toEqual(ambient);
  });

  it('a diagnostic that selected only s1-08 does not touch pooled-s1-08', () => {
    const onlyDirect = validateDiagnosticRequest({ ...ok, batches: 's1-08' });
    expect(withDiagnosticEnv(ambient, 'pooled-s1-08', onlyDirect)).toEqual(ambient);
  });

  it.each([
    ['missing connection timeout', { connectionTimeoutMs: undefined }],
    ['a different connection timeout', { connectionTimeoutMs: 120_000 }],
    ['a connection timeout as a string', { connectionTimeoutMs: '310000' }],
    ['missing maxWait', { txStartMaxWaitMs: undefined }],
    ['the binding maxWait', { txStartMaxWaitMs: 30_000, connectionTimeoutMs: 40_000 }],
    ['maxWait above the limit', { txStartMaxWaitMs: 700_000, connectionTimeoutMs: 710_000 }],
  ])('fails closed on %s', (_, change) => {
    expect(() => diagnosticEnvFor('s1-08', { ...d, ...change })).toThrow(/refused/);
  });

  it('records the effective values a batch was given, labelled as configuration', () => {
    expect(diagnosticSettingsOf(withDiagnosticEnv(ambient, 's1-08', d))).toEqual({
      kind: 'diagnostic configuration (non-binding), not a test outcome',
      txStartMaxWaitMs: 300_000,
      connectionTimeoutMs: 310_000,
    });
    expect(diagnosticSettingsOf(withDiagnosticEnv(ambient, 'db-roles', d))).toBeNull();
    expect(diagnosticSettingsOf(ambient)).toBeNull();
  });
});
