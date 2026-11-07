// Unit tests (no database): the S1-08 transaction-start budget stays binding unless the
// complete, valid diagnostic override is present.
import { mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, describe, expect, it } from 'vitest';
import {
  applyDotenvWithoutDiagnostics,
  assertDiagnosticHosts,
  diagnosticLabel,
  loadDotenvWithoutDiagnostics,
  txStartBudgetFromEnv,
} from './diagnostic-override';

const diag = {
  S1_DIAG_TX_MAX_WAIT_MS: '300000',
  S1_DIAG_NEON_BRANCH_ID: 'br-test-branch-1',
  S1_DIAG_NEON_ENDPOINT_ID: 'ep-test-endpoint-1',
  S1_DIAG_PRODUCTION_BRANCH_IDS: 'br-prod-branch-1',
  S1_CONNECTION_TIMEOUT_MS: '310000',
};

describe('txStartBudgetFromEnv', () => {
  it('is the binding 30 s with no override, and the label is empty', () => {
    const b = txStartBudgetFromEnv({});
    expect(b).toEqual({ maxWaitMs: 30_000, diagnostic: null });
    expect(diagnosticLabel(b)).toBe('');
  });

  it('applies a complete, valid override and labels it non-binding', () => {
    const b = txStartBudgetFromEnv(diag);
    expect(b.maxWaitMs).toBe(300_000);
    expect(b.diagnostic?.branchId).toBe('br-test-branch-1');
    expect(b.diagnostic?.connectionTimeoutMs).toBe(310_000);
    expect(diagnosticLabel(b)).toMatch(/DIAGNOSTIC, NON-BINDING.*300000 ms.*30000 ms/);
  });

  it('refuses a partial override', () => {
    expect(() => txStartBudgetFromEnv({ S1_DIAG_TX_MAX_WAIT_MS: '300000' })).toThrow(/incomplete/);
  });

  it.each(['30000', '600001', 'abc', '-1'])('refuses maxWait %s', (v) => {
    expect(() => txStartBudgetFromEnv({ ...diag, S1_DIAG_TX_MAX_WAIT_MS: v })).toThrow();
  });

  it('refuses a production or unknown production branch', () => {
    expect(() =>
      txStartBudgetFromEnv({ ...diag, S1_DIAG_PRODUCTION_BRANCH_IDS: 'br-test-branch-1' }),
    ).toThrow(/production/);
    expect(() => txStartBudgetFromEnv({ ...diag, S1_DIAG_PRODUCTION_BRANCH_IDS: ',' })).toThrow();
  });
});

describe('diagnostic connection timeout (B2)', () => {
  it.each([undefined, '', '120000', '300000', '310001', 'abc', ' 310000'])(
    'refuses the override with S1_CONNECTION_TIMEOUT_MS %j',
    (v) => {
      expect(() => txStartBudgetFromEnv({ ...diag, S1_CONNECTION_TIMEOUT_MS: v })).toThrow(
        /S1_CONNECTION_TIMEOUT_MS must be 310000/,
      );
    },
  );

  it('an ordinary run ignores S1_CONNECTION_TIMEOUT_MS and stays binding', () => {
    for (const v of [undefined, '10000', '120000', '310000'])
      expect(txStartBudgetFromEnv({ S1_CONNECTION_TIMEOUT_MS: v })).toEqual({
        maxWaitMs: 30_000,
        diagnostic: null,
      });
  });

  it('.env cannot replace the runner-set value', () => {
    const d = mkdtempSync(join(tmpdir(), 'cbr-s1-dotenv-test-'));
    try {
      const f = join(d, '.env');
      writeFileSync(f, 'S1_CONNECTION_TIMEOUT_MS=1000\n');
      const target: Record<string, string | undefined> = { ...diag };
      loadDotenvWithoutDiagnostics(target, f);
      expect(target.S1_CONNECTION_TIMEOUT_MS).toBe('310000');
      expect(txStartBudgetFromEnv(target).diagnostic?.connectionTimeoutMs).toBe(310_000);
      // Without the runner's value, a different one from .env fails closed.
      const fromFile: Record<string, string | undefined> = { ...diag };
      delete fromFile.S1_CONNECTION_TIMEOUT_MS;
      loadDotenvWithoutDiagnostics(fromFile, f);
      expect(() => txStartBudgetFromEnv(fromFile)).toThrow(/must be 310000/);
    } finally {
      rmSync(d, { recursive: true, force: true });
    }
  });
});

describe('assertDiagnosticHosts', () => {
  const target = txStartBudgetFromEnv(diag).diagnostic!;
  const url = (host: string) => `postgresql://u:p@${host}/crm_s1`;

  it('accepts the verified endpoint and its pooler', () => {
    expect(() =>
      assertDiagnosticHosts(target, [
        url('ep-test-endpoint-1.c-6.us-east-2.aws.neon.tech'),
        url('ep-test-endpoint-1-pooler.c-6.us-east-2.aws.neon.tech'),
      ]),
    ).not.toThrow();
  });

  it('refuses any other endpoint, including a local database', () => {
    expect(() =>
      assertDiagnosticHosts(target, [url('ep-production-1.c-6.us-east-2.aws.neon.tech')]),
    ).toThrow(/not on/);
    expect(() => assertDiagnosticHosts(target, [url('localhost:5432')])).toThrow(/not on/);
  });
});

// F4: a .env file (loaded by the s1 project's setup in place of dotenv/config) can never supply
// the override. These tests use synthetic files in a temp directory, never the real .env.
describe('.env loading for the s1 project', () => {
  const dirs: string[] = [];
  afterEach(() => {
    for (const d of dirs.splice(0)) rmSync(d, { recursive: true, force: true });
  });
  const envFile = (body: string) => {
    const d = mkdtempSync(join(tmpdir(), 'cbr-s1-dotenv-test-'));
    dirs.push(d);
    const f = join(d, '.env');
    writeFileSync(f, body);
    return f;
  };

  it('ordinary run: loads ordinary keys, keeps variables already set, stays binding', () => {
    const target: Record<string, string | undefined> = { S1_APP_URL: 'from-runner' };
    loadDotenvWithoutDiagnostics(target, envFile('S1_APP_URL=from-file\nS1_OTHER=x\n'));
    expect(target).toEqual({ S1_APP_URL: 'from-runner', S1_OTHER: 'x' });
    expect(txStartBudgetFromEnv(target).diagnostic).toBeNull();
  });

  it.each([
    'S1_DIAG_TX_MAX_WAIT_MS=300000',
    'S1_DIAG_NEON_BRANCH_ID=br-test-branch-1',
    'MANAGED_DIAG_TX_MAX_WAIT_MS=300000',
    'MANAGED_DIAG_AUTH_NONCE=x',
    'S1_APP_POOLED=1',
  ])('refuses a .env defining %s and copies nothing', (line) => {
    const target: Record<string, string | undefined> = {};
    expect(() => loadDotenvWithoutDiagnostics(target, envFile(`S1_OTHER=x\n${line}\n`))).toThrow(
      /must not define (S1_DIAG_|MANAGED_DIAG_|S1_APP_POOLED)/,
    );
    expect(target).toEqual({});
  });

  it('refuses a complete override in .env even though the values themselves would be valid', () => {
    const body = Object.entries(diag)
      .map(([k, v]) => `${k}=${v}`)
      .join('\n');
    expect(() => loadDotenvWithoutDiagnostics({}, envFile(body))).toThrow(/must not define/);
  });

  it('authorized run: the runner-set S1_DIAG_* survive a clean .env and give the diagnostic budget', () => {
    const target: Record<string, string | undefined> = { ...diag };
    loadDotenvWithoutDiagnostics(target, envFile('S1_OTHER=x\n'));
    expect(txStartBudgetFromEnv(target).maxWaitMs).toBe(300_000);
  });

  it('does not report values in the error', () => {
    expect(() =>
      applyDotenvWithoutDiagnostics({ S1_DIAG_TX_MAX_WAIT_MS: 'secret-looking-value' }, {}),
    ).toThrow(/^(?!.*secret-looking-value)/);
  });

  it('a missing .env is not an error (as with dotenv/config)', () => {
    const target: Record<string, string | undefined> = {};
    loadDotenvWithoutDiagnostics(target, join(tmpdir(), 'cbr-no-such-dir', '.env'));
    expect(target).toEqual({});
  });
});
