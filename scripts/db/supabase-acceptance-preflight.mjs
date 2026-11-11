#!/usr/bin/env node
// Stage 1 preflight for the Supabase acceptance project (docs/runbooks/supabase-free-setup.md §4).
// Reads ONLY the ACCEPTANCE_-prefixed variables of .env (acceptance-env.mjs). Prints check names,
// pass/fail, the masked project ref and catalogue facts; never a value, URL, password or hash.
//
//   node scripts/db/supabase-acceptance-preflight.mjs --config
//       Local only, no network: .env is git-ignored and untracked, and every acceptance variable
//       is present and consistent (ref, pooler host, port, database, role names, matching and
//       distinct passwords, no placeholders, no reuse of local passwords, not the older project,
//       sslmode=verify-full and a readable, valid CA file).
//   node scripts/db/supabase-acceptance-preflight.mjs --read-only
//       The same checks, then ONE psql connection as the admin (postgres.<ref>) through
//       acceptance-env.mjs dockerPsql() (verify-full, CA mounted read-only) inside a READ ONLY
//       transaction that is rolled back: version, database, user, extensions, crm_* roles and
//       leftovers of an earlier setup. Stops (exit 1) if anything differs from a fresh project.
//       No CRM role is tried: none exists before the bootstrap.
//   --target qa|prod (either mode) checks .env.supabase-qa / .env.supabase-prod instead of .env.
import { spawnSync } from 'node:child_process';
import { existsSync } from 'node:fs';
import { pathToFileURL } from 'node:url';
import {
  CA_CONTAINER_PATH,
  CA_GUARD_EXIT,
  ENV_FILE,
  dockerPsql,
  loadTargetEnv,
  maskRef,
  takeTarget,
  targetEnvFile,
  validateAcceptance,
} from './acceptance-env.mjs';

const EXTENSIONS = ['citext', 'btree_gist', 'pg_trgm'];
const SETTINGS = [
  'statement_timeout',
  'lock_timeout',
  'idle_in_transaction_session_timeout',
  'search_path',
  'default_transaction_read_only',
  'row_security',
  'session_replication_role',
];
// After bootstrap steps A and B (bootstrap-supabase.sql, bootstrap-supabase-extensions.sql).
const CRM_ROLES = [
  'crm_app',
  'crm_auth',
  'crm_cleanup',
  'crm_definer',
  'crm_migrator',
  'crm_platform',
];
const UUIDV7_ACL = [
  'crm_app',
  'crm_auth',
  'crm_definer',
  'crm_migrator',
  'crm_platform',
  'postgres',
];
const mark = (ok) => (ok ? 'pass' : 'FAIL');

/** envTarget: --target qa|prod (.env.supabase-<target>), or undefined for .env. */
function localChecks(envTarget) {
  const results = [];
  const file = envTarget ? targetEnvFile(envTarget) : ENV_FILE;
  const name = envTarget ? `.env.supabase-${envTarget}` : '.env';
  const exists = existsSync(file);
  results.push([`${name} exists`, exists]);
  if (!exists) return { results, ok: false };
  const git = (args) => spawnSync('git', args, { cwd: process.cwd(), stdio: 'ignore' }).status;
  results.push([`${name} ignored by git`, git(['check-ignore', '-q', file]) === 0]);
  results.push([`${name} not tracked`, git(['ls-files', '--error-unmatch', file]) !== 0]);
  let env;
  try {
    env = loadTargetEnv(envTarget);
  } catch (e) {
    results.push([e.message, false]);
    return { results, ok: false };
  }
  const { errors, checks, target } = validateAcceptance(env, 'all');
  results.push(...checks);
  return { results, ok: results.every(([, ok]) => ok), errors, target };
}

function report(results) {
  for (const [name, ok] of results) console.log(`  ${mark(ok)}  ${name}`);
}

// One READ ONLY transaction, rolled back; every row is "kind|field|field...".
export const READ_ONLY_SQL = `\\set ON_ERROR_STOP on
\\set VERBOSITY terse
\\pset format unaligned
\\pset tuples_only on
\\pset fieldsep '|'
BEGIN TRANSACTION READ ONLY;
SET LOCAL statement_timeout = '15s';
SELECT 'id', current_setting('server_version'), current_setting('server_version_num'),
       current_database(), current_user, current_setting('transaction_read_only'),
       r.rolsuper, r.rolcreaterole, r.rolcreatedb, r.rolbypassrls,
       has_database_privilege(current_database(), 'CREATE'),
       to_regprocedure('pg_catalog.uuidv7()') IS NOT NULL,
       to_regprocedure('public.uuidv7()') IS NOT NULL,
       EXISTS (SELECT 1 FROM pg_namespace WHERE nspname = 'app'),
       to_regclass('public._prisma_migrations') IS NOT NULL,
       (SELECT count(*) FROM pg_tables WHERE schemaname = 'public')
  FROM pg_roles r WHERE r.rolname = current_user;
SELECT 'ext', a.name, a.default_version, coalesce(e.extversion, ''), coalesce(n.nspname, '')
  FROM pg_available_extensions a
  LEFT JOIN pg_extension e ON e.extname = a.name
  LEFT JOIN pg_namespace n ON n.oid = e.extnamespace
 WHERE a.name IN (${EXTENSIONS.map((e) => `'${e}'`).join(', ')});
SELECT 'other', e.extname, n.nspname FROM pg_extension e
  JOIN pg_namespace n ON n.oid = e.extnamespace
 WHERE e.extname NOT IN (${EXTENSIONS.map((e) => `'${e}'`).join(', ')}) ORDER BY 2;
SELECT 'role', rolname, rolsuper, rolbypassrls, rolcreaterole, rolcreatedb, rolreplication,
       rolcanlogin
  FROM pg_roles WHERE rolname LIKE 'crm\\_%' ORDER BY 2;
SELECT 'member', g.rolname, m.rolname, a.admin_option, a.inherit_option, a.set_option
  FROM pg_auth_members a
  JOIN pg_roles g ON g.oid = a.roleid JOIN pg_roles m ON m.oid = a.member
 WHERE g.rolname LIKE 'crm\\_%' OR m.rolname LIKE 'crm\\_%' ORDER BY 2, 3;
SELECT 'priv', r.rolname, has_database_privilege(r.oid, current_database(), 'CONNECT'),
       has_database_privilege(r.oid, current_database(), 'CREATE'),
       has_schema_privilege(r.oid, 'public', 'USAGE'), has_schema_privilege(r.oid, 'public', 'CREATE')
  FROM pg_roles r WHERE r.rolname LIKE 'crm\\_%' ORDER BY 2;
SELECT 'fn', pg_get_userbyid(p.proowner), p.prosecdef, coalesce(array_to_string(p.proconfig, ';'), ''),
       coalesce(array_to_string(p.proacl, ' '), ''),
       coalesce(obj_description(p.oid, 'pg_proc'), '') LIKE 'CRM: RFC 9562 UUIDv7 %'
  FROM pg_proc p WHERE p.oid = to_regprocedure('public.uuidv7()');
SELECT 'marker', to_regclass('public._crm_migration_marker') IS NOT NULL;
-- Settings: values only for an allowlist (database-level settings can hold secrets); other names only.
SELECT 'gset', name, setting, source FROM pg_settings
 WHERE name IN (${SETTINGS.map((s) => `'${s}'`).join(', ')}) ORDER BY 2;
SELECT 'dbrs', CASE WHEN s.setrole = 0 THEN '*' ELSE pg_get_userbyid(s.setrole) END,
       CASE WHEN s.setdatabase = 0 THEN '*' ELSE current_database() END,
       split_part(c, '=', 1),
       CASE WHEN split_part(c, '=', 1) IN (${SETTINGS.map((s) => `'${s}'`).join(', ')})
            THEN substr(c, length(split_part(c, '=', 1)) + 2) ELSE '<hidden>' END
  FROM pg_db_role_setting s, unnest(s.setconfig) c
 WHERE (s.setdatabase = 0 OR s.setdatabase = (SELECT oid FROM pg_database WHERE datname = current_database()))
   AND (s.setrole = 0 OR pg_get_userbyid(s.setrole) LIKE 'crm\\_%')
 ORDER BY 2, 3, 4;
SELECT 'evt', evtname, evtevent, evtenabled, pg_get_userbyid(evtowner), evtfoid::regproc::text,
       coalesce(array_to_string(evttags, ','), 'all')
  FROM pg_event_trigger ORDER BY 2;
ROLLBACK;
`;

function readOnly(t, { bootstrapped = false } = {}) {
  // Error text from libpq, the pooler or the server can name the user (postgres.<ref>) or host.
  const clean = (s) =>
    [
      [t.admin.password, '<redacted>'],
      [t.ref, '<ref>'],
      [t.admin.host, '<pooler-host>'],
    ].reduce((out, [secret, mask]) => (secret ? out.split(secret).join(mask) : out), String(s));
  const { command, args, env } = dockerPsql(t, ['-X', '-q', '-f', '-']);
  console.log(
    `  TLS         sslmode=verify-full, CA file mounted read-only (${CA_CONTAINER_PATH})`,
  );
  const r = spawnSync(command, args, {
    input: READ_ONLY_SQL,
    env,
    encoding: 'utf8',
    stdio: ['pipe', 'pipe', 'pipe'],
    timeout: 120000,
  });
  const err = clean((r.stderr ?? '').trim());
  if (r.error) {
    console.log(`  FAIL  could not start docker (${r.error.code ?? 'error'})`);
    return false;
  }
  if (r.status === CA_GUARD_EXIT) {
    console.log('  FAIL  CA file not mounted read-only inside the container; not connected');
    return false;
  }
  if (r.status !== 0) {
    console.log(`  FAIL  psql exited with ${r.status}: ${err || 'no message'}`);
    console.log('  result: no usable connection; stop and review (nothing was changed)');
    return false;
  }
  const rows = r.stdout
    .split(/\r?\n/)
    .filter(Boolean)
    .map((l) => l.split('|'));
  const { lines, stops } = evaluate(rows, { bootstrapped });
  console.log(`  target      acceptance project ${maskRef(t.ref)} via the shared session pooler`);
  for (const l of lines) console.log(l);
  if (err) console.log(`  psql notes  ${err}`);
  for (const s of stops) console.log(`  STOP  ${s}`);
  const what = bootstrapped
    ? 'the expected state after bootstrap steps A and B, before any migration'
    : 'a fresh acceptance project';
  console.log(
    stops.length ? `  result: NOT ${what}; stop and review` : `  result: consistent with ${what}`,
  );
  return stops.length === 0;
}

/**
 * Pure: the read-only rows -> report lines and stop reasons. `bootstrapped` expects the state
 * after bootstrap steps A and B (six CRM roles, grants, extensions and public.uuidv7() in place,
 * nothing from the migrations); otherwise a fresh project.
 */
export function evaluate(rows, { bootstrapped = false } = {}) {
  const lines = [];
  const stops = [];
  const b = (v) => v === 't';
  const of = (kind) => rows.filter((x) => x[0] === kind);
  const idRow = rows.find((x) => x[0] === 'id');
  if (!idRow) return { lines, stops: ['unexpected psql output'] };
  const [
    ,
    version,
    num,
    db,
    usr,
    ro,
    su,
    crole,
    cdb,
    bypass,
    dbCreate,
    builtin,
    pubUuid,
    app,
    prisma,
    tables,
  ] = idRow;
  const id = {
    num: Number(num),
    rolcreaterole: b(crole),
    db_create: b(dbCreate),
    public_uuidv7: b(pubUuid),
    app_schema: b(app),
    prisma_table: b(prisma),
    public_tables: Number(tables),
  };
  lines.push(`  server      PostgreSQL ${version}`);
  lines.push(`  session     database=${db} user=${usr} read_only=${ro}`);
  lines.push(
    `  admin       superuser=${b(su)} createrole=${b(crole)} createdb=${b(cdb)} bypassrls=${b(bypass)} create_on_db=${b(dbCreate)}`,
  );
  if (id.num < 170000) stops.push('PostgreSQL is older than 17');
  if (db !== 'postgres') stops.push('not connected to database postgres');
  if (usr !== 'postgres') stops.push('not connected as postgres');
  if (ro !== 'on') stops.push('the session is not read-only');
  if (!bootstrapped && !id.rolcreaterole)
    stops.push('postgres lacks CREATEROLE (the bootstrap creates roles)');
  if (!bootstrapped && !id.db_create) stops.push('postgres lacks CREATE on the database');

  const ext = of('ext').map(([, name, def, installed, schema]) => ({
    name,
    def,
    installed,
    schema,
  }));
  for (const name of EXTENSIONS) {
    const row = ext.find((x) => x.name === name);
    if (!row) {
      lines.push(`  extension   ${name}: NOT AVAILABLE`);
      stops.push(`extension ${name} is not available`);
    } else if (!row.installed) {
      lines.push(`  extension   ${name}: available (${row.def}), not installed`);
      if (bootstrapped) stops.push(`extension ${name} is not installed (bootstrap step B)`);
    } else {
      lines.push(`  extension   ${name}: installed ${row.installed} in schema ${row.schema}`);
      if (row.schema !== 'public')
        stops.push(`extension ${name} is installed in ${row.schema}, not public`);
    }
  }
  lines.push(
    `  other ext.  ${
      of('other')
        .map(([, e, n]) => `${e} (${n})`)
        .join(', ') || 'none'
    }`,
  );

  const roles = of('role').map(([, rolname, s, by, cr, cd, rep, login]) => ({
    rolname,
    elevated: [
      b(s) && 'superuser',
      b(by) && 'bypassrls',
      b(cr) && 'createrole',
      b(cd) && 'createdb',
      b(rep) && 'replication',
    ].filter(Boolean),
    login: b(login),
  }));
  if (!roles.length) lines.push('  crm roles   none');
  for (const r of roles)
    lines.push(
      `  crm role    ${r.rolname}: login=${r.login} elevated=${r.elevated.join(',') || 'none'}`,
    );
  // CRM roles' own memberships are checked. The admin's grants on roles it created (automatic
  // since PostgreSQL 16 for a CREATEROLE non-superuser) are reported, not stopped on.
  const memberRows = of('member');
  const members = memberRows
    .filter(([, , member]) => member.startsWith('crm_'))
    .map(([, group, member]) => `${member} in ${group}`);
  lines.push(`  membership  ${members.join(', ') || 'none'}`);
  const adminGrants = memberRows.filter(([, , member]) => !member.startsWith('crm_'));
  for (const [, group, member, adm, inh, set] of adminGrants)
    lines.push(
      `  admin grant ${member} on ${group}: admin=${b(adm)} inherit=${b(inh)} set=${b(set)}`,
    );
  const privs = of('priv').map(([, rolname, connect, create, usage, pcreate]) => ({
    rolname,
    connect: b(connect),
    create: b(create),
    usage: b(usage),
    pcreate: b(pcreate),
  }));
  for (const p of privs)
    lines.push(
      `  privileges  ${p.rolname}: connect=${p.connect} create_on_db=${p.create} public_usage=${p.usage} public_create=${p.pcreate}`,
    );
  const fn = of('fn')[0];
  if (fn)
    lines.push(
      `  uuidv7      owner=${fn[1]} security_definer=${fn[2]} config=${fn[3] || 'none'} acl=${fn[4] || 'default'} crm_comment=${fn[5]}`,
    );
  const marker = b(of('marker')[0]?.[1]);

  if (!bootstrapped) {
    if (roles.length)
      stops.push(`crm_* roles already exist (${roles.map((r) => r.rolname).join(', ')})`);
    if (id.public_uuidv7) stops.push('public.uuidv7() already exists');
  } else {
    const names = roles.map((r) => r.rolname).sort();
    if (JSON.stringify(names) !== JSON.stringify(CRM_ROLES))
      stops.push(`crm_* roles are not exactly the six CRM roles (${names.join(', ') || 'none'})`);
    for (const r of roles) {
      if (r.elevated.length) stops.push(`${r.rolname} has ${r.elevated.join(', ')}`);
      if (r.login !== (r.rolname !== 'crm_definer'))
        stops.push(`${r.rolname}: unexpected login=${r.login}`);
    }
    if (JSON.stringify(members) !== JSON.stringify(['crm_migrator in crm_definer']))
      stops.push(
        `CRM memberships are not exactly crm_migrator in crm_definer (${members.join(', ') || 'none'})`,
      );
    const p = Object.fromEntries(privs.map((x) => [x.rolname, x]));
    if (!(p.crm_migrator?.create && p.crm_migrator?.pcreate))
      stops.push('crm_migrator lacks CREATE on the database or on schema public');
    for (const r of ['crm_migrator', 'crm_app', 'crm_auth', 'crm_platform', 'crm_cleanup'])
      if (!p[r]?.connect) stops.push(`${r} lacks CONNECT`);
    for (const r of ['crm_app', 'crm_auth', 'crm_platform', 'crm_cleanup', 'crm_definer'])
      if (p[r]?.pcreate || p[r]?.create) stops.push(`${r} has CREATE it should not have`);
    if (!fn) stops.push('public.uuidv7() is missing (bootstrap step B)');
    else {
      const grantees = (fn[4] || '')
        .split(' ')
        .filter(Boolean)
        .map((a) => a.split('=')[0] || 'PUBLIC')
        .sort();
      if (fn[1] !== 'postgres' || fn[2] !== 'f' || fn[5] !== 't')
        stops.push('public.uuidv7() is not the function bootstrap step B creates');
      if (JSON.stringify(grantees) !== JSON.stringify(UUIDV7_ACL))
        stops.push(`public.uuidv7() EXECUTE list is unexpected (${grantees.join(', ')})`);
    }
  }
  lines.push(
    `  leftovers   schema app=${id.app_schema} _prisma_migrations=${id.prisma_table} _crm_migration_marker=${marker} public tables=${id.public_tables} public.uuidv7=${id.public_uuidv7} built-in uuidv7=${b(builtin)}`,
  );
  if (id.app_schema) stops.push('schema app already exists');
  if (id.prisma_table) stops.push('_prisma_migrations already exists');
  if (marker) stops.push('_crm_migration_marker already exists');
  if (id.public_tables > 0) stops.push(`schema public already has ${id.public_tables} table(s)`);

  for (const [, name, setting, source] of of('gset'))
    lines.push(`  setting     ${name}=${setting || "''"} (admin session; source ${source})`);
  const dbrs = of('dbrs');
  if (!dbrs.length) lines.push('  db/role     no database-wide or crm_* role settings');
  for (const [, role, database, name, value] of dbrs) {
    lines.push(`  db/role     role=${role} database=${database}: ${name}=${value}`);
    const appliesToMigrator = role === '*' || role === 'crm_migrator';
    if (appliesToMigrator && name === 'search_path' && !/(^|[\s,"])public([\s,"]|$)/.test(value))
      stops.push(
        `a search_path setting for crm_migrator does not include public (${role}/${database})`,
      );
    if (appliesToMigrator && name === 'default_transaction_read_only' && /on|true/i.test(value))
      stops.push('default_transaction_read_only is on for crm_migrator');
  }
  const evt = of('evt');
  if (!evt.length) lines.push('  event trig. none');
  for (const [, name, event, enabled, owner, fnName, tags] of evt)
    lines.push(
      `  event trig. ${name}: ${event} enabled=${enabled} owner=${owner} function=${fnName} tags=${tags}`,
    );
  return { lines, stops };
}

const isMain = process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href;
if (isMain) {
  let parsed;
  try {
    parsed = takeTarget(process.argv.slice(2));
  } catch (e) {
    console.error(e.message);
    process.exit(2);
  }
  const envTarget = parsed.target;
  const [mode, ...flags] = parsed.rest;
  const bootstrapped = flags.includes('--bootstrapped');
  if (
    (mode !== '--config' && mode !== '--read-only') ||
    flags.some((f) => f !== '--bootstrapped') ||
    (bootstrapped && mode !== '--read-only')
  ) {
    console.error('usage: [--target qa|prod] --config | --read-only [--bootstrapped]');
    process.exit(2);
  }
  console.log(
    `Local configuration (${envTarget ? `.env.supabase-${envTarget}` : '.env'}, ACCEPTANCE_* only):`,
  );
  const local = localChecks(envTarget);
  report(local.results);
  console.log(`  project ref ${maskRef(local.target?.ref)}`);
  if (!local.ok) {
    console.log('  result: configuration NOT valid; no connection attempted');
    process.exit(1);
  }
  console.log('  result: configuration valid');
  if (mode === '--read-only') {
    console.log('Read-only connection (admin, READ ONLY transaction, rolled back):');
    process.exit(readOnly(local.target, { bootstrapped }) ? 0 : 1);
  }
}
