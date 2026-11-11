// The Supabase acceptance target (docs/runbooks/supabase-free-setup.md §4), read from the
// ACCEPTANCE_-prefixed variables of the project's .env file ONLY. The file is parsed directly:
// neither the process environment nor any unprefixed variable (DATABASE_URL, SUPABASE_URL, the
// service key, the local CRM_*_PASSWORD) is ever used, so the local development settings and the
// older Supabase project can never become the target. Validation is local (no network) and every
// message names a variable and a rule, never a value.
//
// TLS: every acceptance connection is psql (libpq) in a throwaway postgres:17-alpine container
// with sslmode=verify-full against Supabase's root CA (ACCEPTANCE_PGSSLROOTCERT, a local file).
// The file is checked before anything starts, bind-mounted READ-ONLY at a fixed container path,
// and re-checked inside the container before psql runs. There is no unverified fallback.
//
// Targets (owner, 2026-11-11): `--target qa` or `--target prod` reads the same ACCEPTANCE_*
// names from a separate git-ignored file per environment, .env.supabase-qa or
// .env.supabase-prod, so the two projects can never share one set of variables. Without
// --target, .env is read as before. Writes to prod need a typed confirmation
// (confirmProduction).
import { spawnSync } from 'node:child_process';
import { X509Certificate } from 'node:crypto';
import { accessSync, constants, existsSync, readFileSync, statSync } from 'node:fs';
import { dirname, isAbsolute, join, resolve } from 'node:path';
import { createInterface } from 'node:readline/promises';
import { fileURLToPath } from 'node:url';
import { parse } from 'dotenv';

const REPO = join(dirname(fileURLToPath(import.meta.url)), '..', '..');
export const ENV_FILE = join(REPO, '.env');
export const PSQL_IMAGE = 'postgres:17-alpine';
/** Where the CA file appears inside the psql container (never the host path). */
export const CA_CONTAINER_PATH = '/run/crm-acceptance/supabase-root.crt';
/** Exit status of the in-container CA guard (psql itself uses 1-3). */
export const CA_GUARD_EXIT = 90;

export const ROLES = ['migrator', 'app', 'auth', 'platform', 'cleanup'];
const URL_VARS = {
  migrator: 'ACCEPTANCE_DATABASE_MIGRATOR_URL',
  app: 'ACCEPTANCE_DATABASE_URL',
  auth: 'ACCEPTANCE_AUTH_DATABASE_URL',
  platform: 'ACCEPTANCE_PLATFORM_DATABASE_URL',
  cleanup: 'ACCEPTANCE_CLEANUP_DATABASE_URL',
};
export const passwordVar = (role) => `ACCEPTANCE_CRM_${role.toUpperCase()}_PASSWORD`;
const POOLER_HOST = /^[a-z0-9-]+\.pooler\.supabase\.com$/;
// Certificate and host name verified (libpq verify-full); nothing weaker is accepted.
const SSL_MODES = ['verify-full'];
const PLACEHOLDER = /^local-[a-z]+-pw$|^<.*>$|^(changeme|password|replace)/i;

/** decodeURIComponent that reports malformed percent-encoding instead of throwing. */
function decoded(s) {
  try {
    return decodeURIComponent(s);
  } catch {
    return null;
  }
}

/**
 * Checks the CA file: an existing, readable, regular file of PEM certificates (no private key),
 * each parseable, currently valid and a CA. Returns { checks: [name, ok, message][], path }.
 */
export function caFileChecks(value, now = new Date()) {
  const v = 'ACCEPTANCE_PGSSLROOTCERT';
  const checks = [];
  const add = (name, ok, message) => checks.push([`${v} ${name}`, ok, `${v} ${message}`]);
  if (!value) {
    add('set', false, "is not set (path to Supabase's root CA file)");
    return { checks, path: '' };
  }
  const path = isAbsolute(value) ? value : resolve(REPO, value);
  // docker's --mount value is comma-separated; these characters would change its meaning.
  add('path usable', !/[,"\n\r]/.test(path), 'must not contain commas, quotes or newlines');
  let st;
  try {
    st = statSync(path);
  } catch {
    add('exists', false, 'does not point at an existing file');
    return { checks, path };
  }
  add(
    'is a file',
    st.isFile() && st.size > 0 && st.size < 65536,
    'must be a non-empty file under 64 KB',
  );
  let pem;
  try {
    accessSync(path, constants.R_OK);
    pem = readFileSync(path, 'utf8');
  } catch {
    add('readable', false, 'is not readable');
    return { checks, path };
  }
  add('readable', true, '');
  add(
    'has no private key',
    !/PRIVATE KEY/.test(pem),
    'contains a private key; use the CA certificate only',
  );
  const blocks = pem.match(/-----BEGIN CERTIFICATE-----[\s\S]+?-----END CERTIFICATE-----/g) ?? [];
  add('contains PEM certificates', blocks.length > 0, 'contains no PEM certificate');
  blocks.forEach((block, i) => {
    let cert;
    try {
      cert = new X509Certificate(block);
    } catch {
      add(`certificate ${i + 1} parses`, false, `certificate ${i + 1} cannot be parsed`);
      return;
    }
    const valid = new Date(cert.validFrom) <= now && now <= new Date(cert.validTo);
    add(
      `certificate ${i + 1} currently valid`,
      valid,
      `certificate ${i + 1} is expired or not yet valid`,
    );
    add(`certificate ${i + 1} is a CA`, cert.ca, `certificate ${i + 1} is not a CA certificate`);
  });
  return { checks, path };
}

/** Parses .env without touching process.env. */
export function readEnvFile(path = ENV_FILE) {
  return parse(readFileSync(path));
}

export const TARGETS = ['qa', 'prod'];
export const targetEnvFile = (target, dir = REPO) => join(dir, `.env.supabase-${target}`);

/**
 * Splits `--target qa|prod` out of the arguments: { target, rest }. target is undefined when the
 * option is absent (the acceptance project in .env). Throws on a missing or unknown value or a
 * repeated option.
 */
export function takeTarget(args) {
  const rest = [];
  let target;
  for (let i = 0; i < args.length; i++) {
    if (args[i] !== '--target') {
      rest.push(args[i]);
      continue;
    }
    const v = args[++i];
    if (target !== undefined) throw new Error('--target given twice');
    if (!TARGETS.includes(v)) throw new Error(`--target must be one of ${TARGETS.join(', ')}`);
    target = v;
  }
  return { target, rest };
}

/**
 * The variables to validate. Without a target: .env, unchanged. With one: .env's unprefixed
 * variables (so the local-reuse and older-project checks still apply) plus ONLY the ACCEPTANCE_*
 * variables of .env.supabase-<target>, plus the other target's values as OTHER_TARGET_* so no
 * password can be shared between QA and production. Throws (naming files and variables, never
 * values) if the target file is missing, not git-ignored, tracked, holds anything but ACCEPTANCE_*
 * variables, or names the same project as the other target.
 */
export function loadTargetEnv(target, { dir = REPO, checkGit = true } = {}) {
  const base = existsSync(join(dir, '.env')) ? readEnvFile(join(dir, '.env')) : {};
  if (target === undefined) return base;
  if (!TARGETS.includes(target)) throw new Error(`unknown target ${target}`);
  const file = targetEnvFile(target, dir);
  const name = `.env.supabase-${target}`;
  if (!existsSync(file)) throw new Error(`${name} does not exist (see docs/runbooks)`);
  if (checkGit) {
    const git = (args) => spawnSync('git', args, { cwd: dir, stdio: 'ignore' }).status;
    if (git(['check-ignore', '-q', file]) !== 0) throw new Error(`${name} is not git-ignored`);
    if (git(['ls-files', '--error-unmatch', file]) === 0)
      throw new Error(`${name} is tracked by git; remove it from the index`);
  }
  const own = readEnvFile(file);
  const foreign = Object.keys(own).filter((k) => !k.startsWith('ACCEPTANCE_'));
  if (foreign.length)
    throw new Error(`${name} may hold only ACCEPTANCE_* variables (found ${foreign.join(', ')})`);
  const env = Object.fromEntries(
    Object.entries(base).filter(([k]) => !k.startsWith('ACCEPTANCE_')),
  );
  const other = TARGETS.find((t) => t !== target);
  const otherFile = targetEnvFile(other, dir);
  if (existsSync(otherFile)) {
    const theirs = readEnvFile(otherFile);
    const ref = (own.ACCEPTANCE_PROJECT_REF ?? '').trim();
    if (ref && ref === (theirs.ACCEPTANCE_PROJECT_REF ?? '').trim())
      throw new Error(`${name} and .env.supabase-${other} name the same Supabase project`);
    for (const [k, v] of Object.entries(theirs)) env[`OTHER_TARGET_${k}`] = v;
  }
  return { ...env, ...own };
}

/**
 * Production writes only after the operator confirms a fresh backup and types the first four
 * characters of the production project ref. Resolves true only on an exact answer; refuses
 * without an interactive terminal. Never prints more than the masked ref.
 */
export async function confirmProduction(
  ref,
  action,
  io = { input: process.stdin, output: process.stderr },
) {
  if (!io.input.isTTY) {
    io.output.write('refusing: production writes need an interactive terminal\n');
    return false;
  }
  const rl = createInterface(io);
  try {
    io.output.write(`\nPRODUCTION (${maskRef(ref)}): ${action}\n`);
    const backup = await rl.question(
      'Has the production database been backed up (supabase-free-setup.md section 8) and the dump checked? (yes/no) ',
    );
    if (backup.trim() !== 'yes') return false;
    const typed = await rl.question('Type the first 4 characters of the production project ref: ');
    return typed.trim() === ref.slice(0, 4);
  } finally {
    rl.close();
  }
}

/** Every password-like value in the file that is NOT an acceptance variable (for reuse checks). */
function localSecrets(env) {
  const out = new Set();
  for (const [k, v] of Object.entries(env)) {
    if (k.startsWith('ACCEPTANCE_') || !v) continue;
    if (/PASSWORD|SECRET|KEY$/.test(k)) out.add(v);
    try {
      const u = new URL(v);
      if (u.password) out.add(decoded(u.password) ?? u.password);
    } catch {
      // not a URL
    }
  }
  return out;
}

/**
 * Validates the acceptance configuration. `need` is 'roles' (the role passwords, enough for
 * --emit-sql) or 'all' (also the role URLs and the admin connection). Returns
 * { errors: string[], checks: [name, ok][], target } where target holds the values for the caller
 * and must never be printed.
 */
export function validateAcceptance(env, need = 'all') {
  const errors = [];
  const checks = [];
  const check = (name, ok, message) => {
    checks.push([name, ok]);
    if (!ok) errors.push(message);
  };
  const get = (k) => (env[k] ?? '').trim();

  const ref = get('ACCEPTANCE_PROJECT_REF');
  check(
    'project ref',
    /^[a-z0-9]{20}$/.test(ref),
    'ACCEPTANCE_PROJECT_REF must be the 20-character project ref (lower-case letters and digits)',
  );
  let oldRef = '';
  try {
    oldRef = new URL(get('SUPABASE_URL')).hostname.split('.')[0];
  } catch {
    // no older project configured
  }
  // Reusing that project is an explicit opt-in (exactly "true"); every other check still applies,
  // and the read-only preflight still stops on any existing CRM roles, schema or tables.
  if (ref && ref === oldRef && get('ACCEPTANCE_ALLOW_EXISTING_PROJECT') === 'true')
    check('same project as SUPABASE_URL, allowed by ACCEPTANCE_ALLOW_EXISTING_PROJECT', true, '');
  else
    check(
      'not the older Supabase project',
      !ref || ref !== oldRef,
      'ACCEPTANCE_PROJECT_REF is the project in SUPABASE_URL (the older project); set ACCEPTANCE_ALLOW_EXISTING_PROJECT=true to use it deliberately',
    );

  const passwords = ROLES.map((r) => get(passwordVar(r)));
  ROLES.forEach((r, i) => {
    const v = passwordVar(r);
    const pw = passwords[i];
    check(`${v} set`, !!pw, `${v} is not set`);
    if (!pw) return;
    check(
      `${v} strength`,
      /^[\x21-\x7e]{24,128}$/.test(pw),
      `${v} must be 24-128 printable ASCII characters without spaces`,
    );
    check(`${v} not a placeholder`, !PLACEHOLDER.test(pw), `${v} is a placeholder`);
  });
  const given = passwords.filter(Boolean);
  check(
    'role passwords all different',
    new Set(given).size === given.length,
    'the five ACCEPTANCE_CRM_*_PASSWORD values must all be different',
  );
  const local = localSecrets(env);
  check(
    'role passwords not reused from local settings',
    given.every((p) => !local.has(p)),
    'an ACCEPTANCE_CRM_*_PASSWORD value is also used by a local (unprefixed) setting or by the other target; generate new ones',
  );

  const target = { ref, passwords: Object.fromEntries(ROLES.map((r, i) => [r, passwords[i]])) };
  if (need === 'roles') return { errors, checks, target };

  const hosts = new Set();
  for (const r of ROLES) {
    const v = URL_VARS[r];
    const raw = get(v);
    let u;
    try {
      u = new URL(raw);
    } catch {
      check(`${v} parses`, false, `${v} is not set or is not a URL`);
      continue;
    }
    hosts.add(u.hostname);
    check(
      `${v} scheme`,
      u.protocol === 'postgresql:' || u.protocol === 'postgres:',
      `${v} must start with postgresql://`,
    );
    check(
      `${v} user`,
      decoded(u.username) === `crm_${r}.${ref}`,
      `${v} must log in as crm_${r}.<ACCEPTANCE_PROJECT_REF>`,
    );
    check(
      `${v} host`,
      POOLER_HOST.test(u.hostname),
      `${v} must use the shared pooler (*.pooler.supabase.com)`,
    );
    check(`${v} port`, u.port === '5432', `${v} must use port 5432 (session pooler)`);
    check(`${v} database`, u.pathname === '/postgres', `${v} must use database postgres`);
    check(
      `${v} no extra parameters`,
      [...u.searchParams.keys()].every((k) => k === 'sslmode'),
      `${v} may carry only the sslmode parameter`,
    );
    check(
      `${v} sslmode not weaker than verify-full`,
      !u.searchParams.has('sslmode') || u.searchParams.get('sslmode') === 'verify-full',
      `${v} may set sslmode only to verify-full`,
    );
    // The URL carries the password percent-encoded (RFC 3986 userinfo): unencoded reserved
    // characters such as @ : / ? # % [ ] would move where the host, path or query starts. WHATWG
    // URL and pg-connection-string decode it the same way, so the decoded value is compared.
    const pwDecoded = decoded(u.password);
    check(
      `${v} password percent-encoding`,
      pwDecoded !== null,
      `the password in ${v} is not correctly percent-encoded (encode it with encodeURIComponent)`,
    );
    check(
      `${v} password matches ${passwordVar(r)}`,
      !!u.password && pwDecoded === target.passwords[r],
      `the password in ${v} differs from ${passwordVar(r)} (reserved characters must be percent-encoded)`,
    );
  }

  const admin = {
    host: get('ACCEPTANCE_PGHOST'),
    port: get('ACCEPTANCE_PGPORT'),
    database: get('ACCEPTANCE_PGDATABASE'),
    user: get('ACCEPTANCE_PGUSER'),
    password: get('ACCEPTANCE_PGPASSWORD'),
    sslmode: get('ACCEPTANCE_PGSSLMODE'),
  };
  hosts.add(admin.host);
  check(
    'ACCEPTANCE_PGHOST',
    POOLER_HOST.test(admin.host),
    'ACCEPTANCE_PGHOST must be the shared pooler host (*.pooler.supabase.com)',
  );
  check(
    'one pooler host everywhere',
    hosts.size === 1,
    'the role URLs and ACCEPTANCE_PGHOST must all use the same pooler host',
  );
  check('ACCEPTANCE_PGPORT', admin.port === '5432', 'ACCEPTANCE_PGPORT must be 5432');
  check(
    'ACCEPTANCE_PGDATABASE',
    admin.database === 'postgres',
    'ACCEPTANCE_PGDATABASE must be postgres',
  );
  check(
    'ACCEPTANCE_PGUSER',
    admin.user === `postgres.${ref}`,
    'ACCEPTANCE_PGUSER must be postgres.<ACCEPTANCE_PROJECT_REF>',
  );
  check(
    'ACCEPTANCE_PGPASSWORD',
    /^[^\s]{8,}$/.test(admin.password) && !/^<.*>$/.test(admin.password),
    'ACCEPTANCE_PGPASSWORD must be set (the database password, no spaces)',
  );
  check(
    'ACCEPTANCE_PGPASSWORD not a placeholder',
    !PLACEHOLDER.test(admin.password),
    'ACCEPTANCE_PGPASSWORD is a placeholder; set the real database password in .env',
  );
  check(
    'ACCEPTANCE_PGPASSWORD differs from the role passwords',
    !given.includes(admin.password),
    'ACCEPTANCE_PGPASSWORD must differ from every ACCEPTANCE_CRM_*_PASSWORD',
  );
  check(
    'ACCEPTANCE_PGSSLMODE',
    SSL_MODES.includes(admin.sslmode),
    `ACCEPTANCE_PGSSLMODE must be one of ${SSL_MODES.join(', ')}`,
  );
  const ca = caFileChecks(get('ACCEPTANCE_PGSSLROOTCERT'));
  for (const [name, ok, message] of ca.checks) check(name, ok, message);
  admin.caPath = ca.path;
  return { errors, checks, target: { ...target, admin } };
}

/**
 * The docker command for psql against the acceptance project, for a VALIDATED target only.
 * - The CA file is bind-mounted read-only at CA_CONTAINER_PATH; the host path appears only in the
 *   --mount option, never in the container's environment.
 * - The admin login goes into the child process's environment under libpq's names, with every
 *   other database-related variable removed; docker receives only the names (-e NAME).
 * - Inside the container, before psql starts, the CA file must be readable, be its own mount with
 *   the `ro` option (read from /proc/mounts: BusyBox's `test -w` is always true for root), and
 *   sslmode must be verify-full; otherwise it exits CA_GUARD_EXIT without connecting.
 * - `network` (offline tests only: a throwaway TLS server on a local docker network) adds
 *   `--network <name>`; it changes nothing about TLS.
 */
export function dockerPsql(t, psqlArgs, baseEnv = process.env, { network } = {}) {
  if (!t?.admin?.caPath || t.admin.sslmode !== 'verify-full')
    throw new Error('refusing to build a connection without verify-full and a checked CA file');
  if (network !== undefined && !/^[a-z0-9][a-z0-9_.-]{0,62}$/.test(network))
    throw new Error('invalid docker network name');
  const env = Object.fromEntries(
    Object.entries(baseEnv).filter(
      ([k]) => !/^(PG|ACCEPTANCE_|DATABASE_|SUPABASE_|CRM_|TEST_)|_DATABASE_URL$/.test(k),
    ),
  );
  const pgEnv = {
    PGHOST: t.admin.host,
    PGPORT: t.admin.port,
    PGDATABASE: t.admin.database,
    PGUSER: t.admin.user,
    PGPASSWORD: t.admin.password,
    PGSSLMODE: 'verify-full',
    PGSSLROOTCERT: CA_CONTAINER_PATH,
  };
  const guard =
    'test -r "$PGSSLROOTCERT" && test "$PGSSLMODE" = verify-full &&' +
    ` awk -v p="$PGSSLROOTCERT" '$2 == p && $4 ~ /^ro(,|$)/ { f = 1 } END { exit !f }' /proc/mounts` +
    ' || { echo "CA file not mounted read-only, or sslmode is not verify-full; not connecting" >&2;' +
    ` exit ${CA_GUARD_EXIT}; }; exec "$@"`;
  const args = [
    'run',
    '--rm',
    '-i',
    ...(network ? ['--network', network] : []),
    '--mount',
    `type=bind,source=${t.admin.caPath},target=${CA_CONTAINER_PATH},readonly`,
    ...Object.keys(pgEnv).flatMap((k) => ['-e', k]),
    PSQL_IMAGE,
    'sh',
    '-c',
    guard,
    'sh',
    'psql',
    ...psqlArgs,
  ];
  return { command: 'docker', args, env: { ...env, ...pgEnv } };
}

/** "abcd…" (first four characters of the ref only). */
export const maskRef = (ref) => (ref ? `${ref.slice(0, 4)}…` : '(none)');
