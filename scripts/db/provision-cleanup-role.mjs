#!/usr/bin/env node
// Provision crm_cleanup without ever sending or printing its plaintext password.
// Reads CRM_CLEANUP_PASSWORD (from the environment or .env), computes a SCRAM-SHA-256 verifier
// locally (RFC 5802 / RFC 7677, as PostgreSQL stores it), and feeds it to
// scripts/db/provision-cleanup-role.sql on stdin (never argv). The SQL creates the role or
// aligns an existing role's password to it.
//
//   node scripts/db/provision-cleanup-role.mjs --local crm_test
//       Runs against the local Docker Compose postgres as `postgres`, then proves the configured
//       URL (TEST_CLEANUP_DATABASE_URL for crm_test, CLEANUP_DATABASE_URL for crm_dev) matches
//       the password and logs in as crm_cleanup to that local database.
//   node scripts/db/provision-cleanup-role.mjs --emit-sql | psql "$ADMIN_URL" -v ON_ERROR_STOP=1 -v db=crm -f -
//       Managed hosting: prints the SQL with the verifier (not the password) for piping.
//
// Output never contains the password or a connection string. (A psql error excerpt could show
// the salted verifier, never the password.)
import { spawnSync } from 'node:child_process';
import { readFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import 'dotenv/config';
import pg from 'pg';
import { scramVerifier } from './scram.mjs';

const here = dirname(fileURLToPath(import.meta.url));
const LOCAL_DBS = { crm_test: 'TEST_CLEANUP_DATABASE_URL', crm_dev: 'CLEANUP_DATABASE_URL' };
const LOCAL_HOSTS = new Set(['127.0.0.1', 'localhost', '[::1]']);

function fail(message) {
  console.error(`provision-cleanup-role: ${message}`);
  process.exit(1);
}

function scriptWithVerifier() {
  const password = process.env.CRM_CLEANUP_PASSWORD;
  if (!password) fail('CRM_CLEANUP_PASSWORD is not set (see .env.example)');
  if (!/^[\x21-\x7e]{16,128}$/.test(password))
    fail('CRM_CLEANUP_PASSWORD must be 16-128 printable ASCII characters without spaces');
  const sql = readFileSync(join(here, 'provision-cleanup-role.sql'), 'utf8');
  return `\\set cleanup_verifier '${scramVerifier(password)}'\n${sql}`;
}

async function local(db) {
  const urlVar = LOCAL_DBS[db];
  if (!urlVar) fail(`--local accepts only ${Object.keys(LOCAL_DBS).join(', ')}`);
  const raw = process.env[urlVar];
  if (!raw) fail(`${urlVar} is not set (see .env.example)`);
  const url = new URL(raw);
  if (url.username !== 'crm_cleanup') fail(`${urlVar} must connect as crm_cleanup`);
  if (!LOCAL_HOSTS.has(url.hostname)) fail(`${urlVar} must point at the local database host`);
  if (url.pathname !== `/${db}`) fail(`${urlVar} must point at database ${db}`);
  if (decodeURIComponent(url.password) !== process.env.CRM_CLEANUP_PASSWORD)
    fail(`the password in ${urlVar} differs from CRM_CLEANUP_PASSWORD; make them equal in .env`);

  const run = spawnSync(
    'docker',
    [
      'compose',
      'exec',
      '-T',
      'postgres',
      'psql',
      '-U',
      'postgres',
      '-d',
      db,
      '-X',
      '-q',
      '-v',
      'ON_ERROR_STOP=1',
      '-v',
      `db=${db}`,
      '-f',
      '-',
    ],
    { input: scriptWithVerifier(), encoding: 'utf8' },
  );
  process.stdout.write(run.stdout ?? '');
  process.stderr.write(run.stderr ?? '');
  if (run.status !== 0) fail(`psql exited with ${run.status}; nothing after the error was applied`);

  // Prove the configured URL logs in as crm_cleanup to exactly this database.
  const c = new pg.Client({ connectionString: raw });
  try {
    await c.connect();
    const { rows } = await c.query('SELECT current_user AS u, current_database() AS d');
    if (rows[0].u !== 'crm_cleanup' || rows[0].d !== db)
      fail('connected as the wrong role or database');
    console.log(`provision-cleanup-role: ${urlVar} logs in as crm_cleanup to ${db}`);
  } catch (e) {
    fail(`login with ${urlVar} failed (${e.code ?? 'no code'}); the password was not aligned`);
  } finally {
    await c.end().catch(() => {});
  }
}

const [mode, arg] = process.argv.slice(2);
if (mode === '--local') await local(arg);
else if (mode === '--emit-sql') process.stdout.write(scriptWithVerifier());
else fail('usage: --local <crm_test|crm_dev> | --emit-sql');
