// Phase 2 M4 migration 0005: import_job / import_row_result tenant isolation, restrictive
// policies, column grants and the status state machine, exercised as crm_app the way
// withTenant() connects (transaction-local app.org_id / app.user_id). Synthetic data only.
import { randomBytes, randomUUID } from 'node:crypto';
import { beforeAll, describe, expect, it } from 'vitest';
import { migrator, withRole } from '../support/db';
import { seedOrg } from '../support/factory';

const APP = process.env.TEST_DATABASE_URL!;

type Org = Awaited<ReturnType<typeof seedOrg>>;
let A: Org;
let B: Org;

interface DbError {
  code?: string;
  message: string;
}

/** One statement as crm_app inside a tenant transaction (committed on success). */
async function asApp(org: Org, userId: string, sql: string, params: unknown[] = []) {
  return withRole(APP, async (c) => {
    await c.query('BEGIN');
    try {
      await c.query(
        `SELECT set_config('app.org_id', $1, true), set_config('app.user_id', $2, true)`,
        [org.orgId, userId],
      );
      const r = await c.query(sql, params);
      await c.query('COMMIT');
      return r;
    } catch (e) {
      await c.query('ROLLBACK');
      throw e;
    }
  });
}

/** SQLSTATE and message of a failure, or 'OK'. */
async function outcome(p: Promise<unknown>): Promise<string> {
  try {
    await p;
    return 'OK';
  } catch (e) {
    const err = e as DbError;
    return `${err.code}: ${err.message}`;
  }
}

const key = (org: Org, id: string) =>
  `orgs/${org.orgId}/imports/${id}/${randomBytes(16).toString('hex')}.csv`;

const INSERT = `INSERT INTO import_job (id, org_id, created_by, file_type, content_type, original_filename, byte_size, storage_key)
  VALUES ($1, $2, $3, 'csv', 'text/csv', 'synthetic.csv', 100, $4)`;

/** A new job created through the policies, as the org's owner. */
async function newJob(org: Org): Promise<string> {
  const id = randomUUID();
  await asApp(org, org.users.owner.id, INSERT, [id, org.orgId, org.users.owner.id, key(org, id)]);
  return id;
}

const setStatus = (org: Org, id: string, status: string, extra = '') =>
  asApp(
    org,
    org.users.owner.id,
    `UPDATE import_job SET status = '${status}'${extra ? `, ${extra}` : ''} WHERE id = $1`,
    [id],
  );

/** Walks a job through the allowed path to READY. */
async function readyJob(org: Org, dryRun = false): Promise<string> {
  const id = await newJob(org);
  for (const s of ['UPLOADED', 'ANALYSING', 'NEEDS_MAPPING', 'VALIDATING'])
    await setStatus(org, id, s);
  await setStatus(org, id, 'READY', `dry_run = ${dryRun}`);
  return id;
}

const startImport = (org: Org, id: string) =>
  setStatus(org, id, 'IMPORTING', `attested_at = now(), attestation_version = 'v1'`);

beforeAll(async () => {
  A = await seedOrg('JobsA');
  B = await seedOrg('JobsB');
});

describe('import_job: creation policy and integrity', () => {
  it('the session user creates a job in its org, with database deadlines', async () => {
    const id = await newJob(A);
    const row = await migrator().importJob.findUniqueOrThrow({ where: { id } });
    expect(row).toMatchObject({ status: 'AWAITING_UPLOAD', createdBy: A.users.owner.id });
    const h = (d: Date) => (d.getTime() - row.createdAt.getTime()) / 3_600_000;
    expect(h(row.uploadExpiresAt)).toBeCloseTo(2, 5);
    expect(h(row.purgeFileAfter)).toBeCloseTo(3, 5);
  });

  it.each([
    ['created_by another member', (id: string) => [id, A.orgId, A.users.admin.id, key(A, id)]],
    ['another org', (id: string) => [id, B.orgId, A.users.owner.id, key(B, id)]],
  ])('refuses a job for %s', async (_, params) => {
    expect(await outcome(asApp(A, A.users.owner.id, INSERT, params(randomUUID())))).toMatch(
      /^42501: new row violates row-level security policy/,
    );
  });

  it.each([
    ['a later status', `status = 'READY'`],
    ['an attestation', `attested_at = now()`],
    ['a later cleanup time', `purge_file_after = now() + interval '5 hours'`],
    ['a later upload deadline', `upload_expires_at = now() + interval '3 hours'`],
    ['a backdated creation time', `created_at = now() - interval '1 day'`],
  ])('refuses an insert with %s', async (_, set) => {
    const id = randomUUID();
    const [col, val] = set.split(' = ');
    const sql = INSERT.replace('storage_key)', `storage_key, ${col})`).replace(
      '$4)',
      `$4, ${val})`,
    );
    expect(
      await outcome(asApp(A, A.users.owner.id, sql, [id, A.orgId, A.users.owner.id, key(A, id)])),
    ).toMatch(/^42501: new row violates row-level security policy/);
  });

  it('the storage key must be namespaced by the row’s own org and id', async () => {
    const id = randomUUID();
    const other = randomUUID();
    for (const k of [key(B, id), key(A, other), `orgs/${A.orgId}/imports/${id}/../x.csv`])
      expect(
        await outcome(asApp(A, A.users.owner.id, INSERT, [id, A.orgId, A.users.owner.id, k])),
      ).toMatch(/^23514: .*import_job_storage_key/);
  });
});

describe('import_job: tenant isolation and column grants', () => {
  it('another org neither sees nor updates the job', async () => {
    const id = await newJob(A);
    const seen = await asApp(B, B.users.owner.id, 'SELECT id FROM import_job WHERE id = $1', [id]);
    expect(seen.rows).toEqual([]);
    const upd = await asApp(
      B,
      B.users.owner.id,
      `UPDATE import_job SET error_code = 'X' WHERE id = $1`,
      [id],
    );
    expect(upd.rowCount).toBe(0);
  });

  it('identity, tenant, uploader and storage key are not updatable; nothing is deletable', async () => {
    const id = await newJob(A);
    for (const set of [
      `storage_key = 'x'`,
      `created_by = '${A.users.admin.id}'`,
      `org_id = '${B.orgId}'`,
      `original_filename = 'y.csv'`,
      `upload_expires_at = now()`,
    ])
      expect(
        await outcome(
          asApp(A, A.users.owner.id, `UPDATE import_job SET ${set} WHERE id = $1`, [id]),
        ),
        set,
      ).toMatch(/^42501: permission denied for table import_job/);
    expect(
      await outcome(asApp(A, A.users.owner.id, 'DELETE FROM import_job WHERE id = $1', [id])),
    ).toMatch(/^42501: permission denied/);
  });

  it('a stored file cannot be kept more than 24 h ahead', async () => {
    const id = await newJob(A);
    const sql = `UPDATE import_job SET purge_file_after = now() + $2::interval WHERE id = $1`;
    expect(await outcome(asApp(A, A.users.owner.id, sql, [id, '23 hours']))).toBe('OK');
    expect(await outcome(asApp(A, A.users.owner.id, sql, [id, '25 hours']))).toMatch(
      /^42501: new row violates row-level security policy/,
    );
  });
});

describe('import_job: state machine', () => {
  it('follows the allowed path to a finished import', async () => {
    const id = await readyJob(A);
    expect(await outcome(setStatus(A, id, 'IMPORTING'))).toMatch(/^23514: .*import_job_attested/);
    await startImport(A, id);
    expect(await outcome(setStatus(A, id, 'COMPLETED'))).toMatch(
      /^23514: .*import_job_terminal_finished/,
    );
    expect(await outcome(setStatus(A, id, 'COMPLETED', 'finished_at = now()'))).toBe('OK');
  });

  it.each([
    ['AWAITING_UPLOAD', 'IMPORTING'],
    ['AWAITING_UPLOAD', 'READY'],
    ['AWAITING_UPLOAD', 'COMPLETED'],
  ])('refuses %s -> %s', async (_, to) => {
    const id = await newJob(A);
    expect(await outcome(setStatus(A, id, to, `finished_at = now(), attested_at = now()`))).toMatch(
      /^23514: import job .* cannot go from AWAITING_UPLOAD to /,
    );
  });

  it('finished jobs are frozen except the cleanup marker', async () => {
    const id = await newJob(A);
    await setStatus(A, id, 'CANCELLED', 'finished_at = now()');
    for (const [s, extra] of [
      ['AWAITING_UPLOAD', ''],
      ['CANCELLED', 'rows_created = 5'],
      ['CANCELLED', `error_code = 'X'`],
    ] as const)
      expect(await outcome(setStatus(A, id, s, extra))).toMatch(
        /^23514: import job .* is finished/,
      );
    expect(
      await outcome(
        asApp(A, A.users.owner.id, 'UPDATE import_job SET file_deleted_at = now() WHERE id = $1', [
          id,
        ]),
      ),
    ).toBe('OK');
  });

  it('settings are fixed while importing and the cursor never moves back', async () => {
    const id = await readyJob(A);
    await startImport(A, id);
    const upd = (set: string) =>
      outcome(asApp(A, A.users.owner.id, `UPDATE import_job SET ${set} WHERE id = $1`, [id]));
    for (const set of [
      `mapping = '{"fullName":0}'`,
      `duplicate_policy = 'SKIP'`,
      `assignment = '{"mode":"round_robin"}'`,
      `attested_at = now() - interval '1 minute'`,
    ])
      expect(await upd(set), set).toMatch(
        /^23514: import job .* settings are fixed while importing/,
      );
    expect(await upd('rows_total = 10, next_row = 5')).toBe('OK');
    expect(await upd('next_row = 4')).toMatch(/^23514: import job .* cursor cannot move back/);
    // Pause keeps the settings fixed too; resuming is allowed.
    expect(
      await outcome(setStatus(A, id, 'PAUSED', `error_code = 'UPLOADER_NOT_AUTHORIZED'`)),
    ).toBe('OK');
    expect(await upd(`duplicate_policy = 'SKIP'`)).toMatch(/settings are fixed while importing/);
    expect(await outcome(setStatus(A, id, 'IMPORTING', 'error_code = NULL'))).toBe('OK');
    await setStatus(A, id, 'CANCELLED', 'finished_at = now()');
  });

  it('one import writing per org: a running or paused job holds the slot', async () => {
    const first = await readyJob(B);
    const second = await readyJob(B);
    await startImport(B, first);
    expect(await outcome(startImport(B, second))).toMatch(/^23505: .*import_job_one_running_uq/);
    await setStatus(B, first, 'PAUSED');
    expect(await outcome(startImport(B, second))).toMatch(/^23505: .*import_job_one_running_uq/);
    await setStatus(B, first, 'CANCELLED', 'finished_at = now()');
    expect(await outcome(startImport(B, second))).toBe('OK');
    // Another org is unaffected.
    const inA = await readyJob(A);
    expect(await outcome(startImport(A, inA))).toBe('OK');
    await setStatus(B, second, 'FAILED', `finished_at = now(), error_code = 'TEST'`);
    await setStatus(A, inA, 'FAILED', `finished_at = now(), error_code = 'TEST'`);
  });

  it('a dry run finishes from READY, writes nothing and never imports', async () => {
    const dry = await readyJob(A, true);
    expect(await outcome(startImport(A, dry))).toMatch(/^23514: .*import_job_attested/);
    expect(await outcome(setStatus(A, dry, 'READY', 'rows_created = 1'))).toMatch(
      /^23514: .*import_job_dry_run_writes_nothing/,
    );
    expect(await outcome(setStatus(A, dry, 'COMPLETED', 'finished_at = now()'))).toBe('OK');
    const real = await readyJob(A, false);
    expect(await outcome(setStatus(A, real, 'COMPLETED', 'finished_at = now()'))).toMatch(
      /^23514: import job .* has not imported its rows/,
    );
  });

  it('FAILED and CANCELLED are reachable from unfinished states', async () => {
    for (const s of ['FAILED', 'CANCELLED']) {
      const id = await newJob(A);
      await setStatus(A, id, 'UPLOADED');
      expect(await outcome(setStatus(A, id, s, 'finished_at = now()'))).toBe('OK');
    }
  });
});

describe('import_row_result', () => {
  const INSERT_RESULT = `INSERT INTO import_row_result (org_id, import_job_id, phase, attempt, row_number, outcome, field, code)
    VALUES ($1, $2, 'VALIDATE', $3, $4, 'INVALID', 'primaryPhone', 'PHONE_INVALID')`;

  it('results are written only while the job is validating, for its current pass, once', async () => {
    const id = await newJob(A);
    const write = (attempt: number, row: number) =>
      outcome(asApp(A, A.users.owner.id, INSERT_RESULT, [A.orgId, id, attempt, row]));
    expect(await write(0, 2)).toMatch(/^42501: new row violates row-level security policy/);
    for (const s of ['UPLOADED', 'ANALYSING', 'NEEDS_MAPPING']) await setStatus(A, id, s);
    await setStatus(A, id, 'VALIDATING', 'validation_attempt = 1');
    expect(await write(1, 2)).toBe('OK');
    expect(await write(0, 3)).toMatch(/^42501: new row violates row-level security policy/);
    expect(await write(1, 2)).toMatch(/^23505: .*import_row_result_uq/);
    await setStatus(A, id, 'READY');
    expect(await write(1, 4)).toMatch(/^42501: new row violates row-level security policy/);
  });

  it('another org cannot write results for, or read results of, this job', async () => {
    const id = await newJob(A);
    for (const s of ['UPLOADED', 'ANALYSING', 'NEEDS_MAPPING', 'VALIDATING'])
      await setStatus(A, id, s);
    await asApp(A, A.users.owner.id, INSERT_RESULT, [A.orgId, id, 0, 7]);
    expect(await outcome(asApp(B, B.users.owner.id, INSERT_RESULT, [B.orgId, id, 0, 8]))).toMatch(
      /^42501: new row violates row-level security policy|^23503: /,
    );
    const seen = await asApp(
      B,
      B.users.owner.id,
      'SELECT id FROM import_row_result WHERE import_job_id = $1',
      [id],
    );
    expect(seen.rows).toEqual([]);
    expect(
      await outcome(
        asApp(A, A.users.owner.id, 'DELETE FROM import_row_result WHERE import_job_id = $1', [id]),
      ),
    ).toMatch(/^42501: permission denied/);
  });
});
