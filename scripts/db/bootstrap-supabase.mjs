#!/usr/bin/env node
// Supabase bootstrap without ever sending or printing a plaintext role password
// (docs/runbooks/supabase-free-setup.md §4), in two separately approved steps. Reads the
// acceptance target ONLY from the ACCEPTANCE_-prefixed variables of .env (acceptance-env.mjs: no
// process environment, no unprefixed variable, no older Supabase project unless explicitly
// allowed).
//
// Step A, roles and grants (bootstrap-supabase.sql + provision-cleanup-role.sql, one transaction):
//   node scripts/db/bootstrap-supabase.mjs --run
//       Computes a SCRAM-SHA-256 verifier for each role on the client (scram.mjs). The
//       transaction first switches statement logging and pg_stat_statements utility tracking off
//       for itself only (quiet_ddl) and stops, before any verifier is sent, if it cannot.
//       Creates no extension, function, schema or table.
// Step B, extensions and public.uuidv7() (bootstrap-supabase-extensions.sql, one transaction):
//   node scripts/db/bootstrap-supabase.mjs --run-extensions
//       Sends no password or verifier, creates no role; stops if step A has not run.
//
// Both validate the whole acceptance configuration, including the CA file (no network before
// that), then run psql 17 in a throwaway container with the script on stdin, using
// acceptance-env.mjs dockerPsql(): sslmode=verify-full against the CA file mounted read-only;
// the admin login in the child process's environment only (docker gets just the variable NAMES,
// never a value); no unverified fallback. Migrations are a separate step again.
//
// Local rehearsal (writes the script to a pipe; refuses a terminal; never redirect to a file):
//   node scripts/db/bootstrap-supabase.mjs --emit-sql [--allow-ddl-logging] | <psql on stdin>
//   node scripts/db/bootstrap-supabase.mjs --emit-extensions-sql | <psql on stdin>
//   --allow-ddl-logging drops the quiet_ddl guard, for a local admin that may not SET the
//   logging parameters (a plain non-superuser); never use it against Supabase.
//
// Errors name variables, never values.
import { spawnSync } from 'node:child_process';
import { readFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';
import {
  CA_GUARD_EXIT,
  PSQL_IMAGE,
  ROLES,
  dockerPsql,
  maskRef,
  readEnvFile,
  validateAcceptance,
} from './acceptance-env.mjs';
import { scramVerifier } from './scram.mjs';

const here = dirname(fileURLToPath(import.meta.url));
const sqlFile = (name) => readFileSync(join(here, name), 'utf8');
const PREAMBLE = [
  '\\set ON_ERROR_STOP on',
  '\\set ECHO none',
  '\\set VERBOSITY terse',
  '\\set SHOW_CONTEXT never',
];

function fail(message) {
  console.error(`bootstrap-supabase: ${message}`);
  process.exit(1);
}

function target(need) {
  const { errors, target } = validateAcceptance(readEnvFile(), need);
  if (errors.length)
    fail(`acceptance configuration in .env is not valid:\n  - ${errors.join('\n  - ')}`);
  return target;
}

/** Step A: roles and grants. The verifiers are psql variables, set client-side. */
export function rolesScript(passwords, { quietDdl = true } = {}) {
  const sets = ROLES.map(
    (role) => `\\set ${role}_verifier '${scramVerifier(passwords[role])}'`,
  ).join('\n');
  return [
    ...PREAMBLE,
    `\\set quiet_ddl ${quietDdl ? 'true' : 'false'}`,
    sets,
    'BEGIN;',
    sqlFile('bootstrap-supabase.sql'),
    sqlFile('provision-cleanup-role.sql'),
    'COMMIT;',
    '',
  ].join('\n');
}

/** Step B: extensions and uuidv7(). No verifier, no role. */
export function extensionsScript() {
  return [...PREAMBLE, 'BEGIN;', sqlFile('bootstrap-supabase-extensions.sql'), 'COMMIT;', ''].join(
    '\n',
  );
}

function run(step, input) {
  const t = target('all'); // includes the CA file checks; nothing starts if any fails
  const { command, args, env } = dockerPsql(t, [
    '-X',
    '-q',
    '-v',
    'ON_ERROR_STOP=1',
    '-v',
    'db=postgres',
    '-f',
    '-',
  ]);
  console.error(
    `bootstrap-supabase: ${step} on acceptance project ${maskRef(t.ref)}; psql (${PSQL_IMAGE}), sslmode=verify-full`,
  );
  const r = spawnSync(command, args, {
    input: input(t),
    env,
    stdio: ['pipe', 'inherit', 'inherit'],
  });
  if (r.error) fail(`could not start docker (${r.error.code ?? 'error'})`);
  if (r.status === CA_GUARD_EXIT) fail('the CA file was not mounted read-only; not connected');
  if (r.status === 2)
    fail('connection failed (certificate verification, network or login); nothing was applied');
  if (r.status !== 0) fail(`psql exited with ${r.status}; the transaction was rolled back`);
  console.error(`bootstrap-supabase: ${step} done`);
}

function emit(sql) {
  if (process.stdout.isTTY)
    fail('refusing to write the script to a terminal; pipe the output into psql (see header)');
  process.stdout.on('error', () => process.exit(1)); // e.g. psql exited early; print nothing
  process.stdout.write(sql());
}

const isMain = process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href;
if (isMain) {
  const [mode, ...flags] = process.argv.slice(2);
  const allowLogging = flags.includes('--allow-ddl-logging');
  if (flags.some((f) => f !== '--allow-ddl-logging') || (allowLogging && mode !== '--emit-sql'))
    fail('unknown or misplaced option (see the header)');
  if (mode === '--run') run('step A (roles and grants)', (t) => rolesScript(t.passwords));
  else if (mode === '--run-extensions')
    run('step B (extensions and uuidv7)', () => extensionsScript());
  else if (mode === '--emit-sql')
    emit(() => rolesScript(target('roles').passwords, { quietDdl: !allowLogging }));
  else if (mode === '--emit-extensions-sql') emit(() => extensionsScript());
  else
    fail(
      'usage: --run | --run-extensions | --emit-sql [--allow-ddl-logging] | --emit-extensions-sql',
    );
}
