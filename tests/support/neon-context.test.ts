// Unit tests (no database): the Neon test context must be claimed by the runner's verified
// target AND confirmed by the server's own identity on the test's endpoint.
import { describe, expect, it } from 'vitest';
import { neonContextFor, type ParamClient } from './neon-context';

const env = {
  TEST_NEON_BRANCH_ID: 'br-test-branch-1',
  TEST_NEON_ENDPOINT_ID: 'ep-test-endpoint-1',
  TEST_NEON_PRODUCTION_BRANCH_IDS: 'br-prod-branch-1',
};
const url = 'postgresql://crm_app:x@ep-test-endpoint-1.example.invalid/crm_test';
const server = (branch: unknown, endpoint: unknown): ParamClient => ({
  async query() {
    return { rows: [{ branch, endpoint }] };
  },
});
const verified = server('br-test-branch-1', 'ep-test-endpoint-1');

describe('neonContextFor', () => {
  it('no Neon variables: null (PostgreSQL rules only), without querying', async () => {
    const never: ParamClient = {
      query: () => Promise.reject(new Error('must not query')),
    };
    expect(await neonContextFor(never, {}, url)).toBeNull();
    expect(await neonContextFor(never, { TEST_NEON_BRANCH_ID: '' }, url)).toBeNull();
  });

  it('established only when the server reports the verified branch and endpoint', async () => {
    expect(await neonContextFor(verified, env, url)).toEqual({
      branchId: 'br-test-branch-1',
      endpointId: 'ep-test-endpoint-1',
    });
    const pooler = 'postgresql://crm_app:x@ep-test-endpoint-1-pooler.example.invalid/crm_test';
    expect(await neonContextFor(verified, env, pooler)).not.toBeNull();
  });

  it('variables alone are not enough: a server that does not confirm them fails', async () => {
    for (const s of [
      server(null, null), // not Neon (e.g. local PostgreSQL)
      server('br-other', 'ep-test-endpoint-1'),
      server('br-test-branch-1', 'ep-other'),
    ])
      await expect(neonContextFor(s, env, url)).rejects.toThrow(/server does not report/);
  });

  it('refuses an incomplete, malformed or production target, and another endpoint', async () => {
    await expect(
      neonContextFor(verified, { TEST_NEON_BRANCH_ID: 'br-test-branch-1' }, url),
    ).rejects.toThrow(/only TEST_NEON_BRANCH_ID set/);
    await expect(
      neonContextFor(verified, { ...env, TEST_NEON_BRANCH_ID: 'main' }, url),
    ).rejects.toThrow(/malformed/);
    await expect(
      neonContextFor(
        verified,
        { ...env, TEST_NEON_PRODUCTION_BRANCH_IDS: 'br-test-branch-1' },
        url,
      ),
    ).rejects.toThrow(/production branch/);
    await expect(
      neonContextFor(verified, { ...env, TEST_NEON_PRODUCTION_BRANCH_IDS: ',' }, url),
    ).rejects.toThrow(/production branch ids unknown/);
    await expect(
      neonContextFor(verified, env, 'postgresql://u:p@127.0.0.1:55432/crm_test'),
    ).rejects.toThrow(/not to the verified endpoint/);
  });
});
