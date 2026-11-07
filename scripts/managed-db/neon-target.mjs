// Shared by neon-s1.mjs and neon-clean.mjs: proves which Neon branch the env file connects to,
// and inventories the S1 test objects on it. Never prints the env file, URLs or passwords.
import { spawnSync } from 'node:child_process';
import { readFileSync } from 'node:fs';
import pg from 'pg';

/** Databases the S1 runner creates (scripts/managed-db/s1-managed-run.mjs). */
export const TEST_DATABASES = ['crm_s1', 'crm_test'];
/** Databases a Neon branch has before the runner touches it. */
export const BASE_DATABASES = ['neondb', 'postgres'];

export class Stop extends Error {}
const stop = (msg) => {
  throw new Stop(msg);
};

/** The exact role names scripts/db/bootstrap-managed-roles.sql creates (no wildcard). */
export function expectedRoles() {
  const sql = readFileSync('scripts/db/bootstrap-managed-roles.sql', 'utf8');
  const roles = [...sql.matchAll(/^CREATE ROLE (\w+)/gm)].map((m) => m[1]).sort();
  const want = ['crm_app', 'crm_auth', 'crm_definer', 'crm_migrator', 'crm_platform'];
  if (JSON.stringify(roles) !== JSON.stringify(want))
    stop(`bootstrap SQL creates ${roles.join(', ')}, expected ${want.join(', ')}`);
  return roles;
}

/** Parse the env file into memory only (nothing reaches process.env or the output). */
function readEnvFile(path) {
  const env = {};
  for (const line of readFileSync(path, 'utf8').split(/\r?\n/)) {
    const m = line.match(/^\s*([A-Za-z_][A-Za-z0-9_]*)\s*=\s*(.*?)\s*$/);
    if (m) env[m[1]] = m[2].replace(/^(["'])(.*)\1$/, '$2');
  }
  for (const k of ['DATABASE_URL', 'DATABASE_URL_UNPOOLED', 'NEON_BRANCH'])
    if (!env[k]) stop(`${k} missing from ${path}`);
  return env;
}

/** node-postgres URL with full certificate verification (Node's bundled roots). */
export function verifiedUrl(url, db) {
  const u = new URL(url);
  u.searchParams.set('sslmode', 'verify-full');
  u.searchParams.delete('channel_binding');
  if (db) u.pathname = `/${db}`;
  return u.toString();
}

/**
 * Proves the target two independent ways and returns the connection details:
 *  1. Neon control plane (authenticated `neon` CLI; NEON_CLI = its path if not on PATH): the
 *     endpoint in the env file belongs to `branchId`, which is not the default/primary/protected
 *     branch, and whose name equals NEON_BRANCH;
 *  2. the server: neon.project_id / neon.branch_id / neon.endpoint_id on the direct and the
 *     pooled connection.
 */
export async function verifyNeonTarget({ branchId, envFile, projectId }) {
  if (!branchId) stop('--branch-id is required (the Neon test branch id, br-…)');
  const fileEnv = readEnvFile(envFile);
  const direct = new URL(fileEnv.DATABASE_URL_UNPOOLED);
  const pooled = new URL(fileEnv.DATABASE_URL);
  const secrets = [direct.password, pooled.password].filter(Boolean);
  const scrub = (s) => secrets.reduce((a, x) => a.split(x).join('***'), String(s ?? ''));

  const endpointId = direct.hostname.split('.')[0];
  if (!/^ep-[a-z0-9-]+$/.test(endpointId)) stop('direct host is not a Neon endpoint host');
  if (pooled.hostname !== direct.hostname.replace(`${endpointId}.`, `${endpointId}-pooler.`))
    stop('DATABASE_URL is not the pooler of the DATABASE_URL_UNPOOLED endpoint');
  const project = projectId ?? JSON.parse(readFileSync('.neon', 'utf8')).projectId;
  if (!project) stop('no Neon project id (.neon or --project-id)');

  const neonApi = (path) => {
    const r = spawnSync(`"${process.env.NEON_CLI ?? 'neon'}"`, ['api', path], {
      encoding: 'utf8',
      shell: true,
      env: { ...process.env, MSYS_NO_PATHCONV: '1' },
    });
    if (r.status !== 0) stop(`neon api ${path} failed: ${scrub(r.stderr).slice(0, 300)}`);
    return JSON.parse(r.stdout);
  };
  const { branches } = neonApi(`/projects/${project}/branches`);
  const { endpoints } = neonApi(`/projects/${project}/endpoints`);
  const branch = branches.find((b) => b.id === branchId);
  const prod = branches.filter((b) => b.default || b.primary).map((b) => b.id);
  const endpoint = endpoints.find((e) => e.id === endpointId);
  if (!branch) stop(`branch ${branchId} not in project ${project}`);
  if (branch.default || branch.primary || branch.protected)
    stop('target branch is the default/primary/protected branch');
  if (branch.name !== fileEnv.NEON_BRANCH) stop('NEON_BRANCH does not match the branch name');
  if (!endpoint || endpoint.branch_id !== branch.id) stop('endpoint does not belong to the branch');
  if (prod.includes(endpoint.branch_id)) stop('endpoint belongs to the production branch');

  const server = [];
  for (const url of [direct, pooled]) {
    const c = new pg.Client({ connectionString: verifiedUrl(url) });
    try {
      await c.connect();
      const { rows } = await c.query(`SELECT current_setting('neon.project_id') AS project,
        current_setting('neon.branch_id') AS branch, current_setting('neon.endpoint_id') AS endpoint,
        current_setting('server_version') AS version, current_user AS "user",
        current_database() AS db, (SELECT count(*)::int FROM pg_stat_user_tables) AS user_tables_in_db`);
      server.push(rows[0]);
    } catch (e) {
      stop(`could not connect: ${scrub(e.message)}`);
    } finally {
      await c.end().catch(() => {});
    }
  }
  for (const id of server)
    if (id.project !== project || id.branch !== branch.id || id.endpoint !== endpointId)
      stop('server-reported Neon identity does not match the control plane');

  return {
    direct,
    pooled,
    scrub,
    neonApi,
    server: server[0],
    target: {
      provider: 'Neon',
      projectId: project,
      branchId: branch.id,
      branchName: branch.name,
      branchParent: branch.parent_id,
      productionBranchIds: prod,
      endpointId,
      region: endpoint.region_id,
      serverVersion: server[0].version,
      adminRole: server[0].user,
      verifiedBy: ['neon api: endpoint.branch_id', 'server: neon.branch_id on direct + pooled'],
    },
  };
}

/** Databases, crm_* roles, their memberships and their dependencies, as seen by the admin. */
export async function inventory(direct) {
  const c = new pg.Client({ connectionString: verifiedUrl(direct) });
  await c.connect();
  try {
    const q = async (sql, params) => (await c.query(sql, params)).rows;
    return {
      databases: await q(`SELECT datname, pg_get_userbyid(datdba) AS owner FROM pg_database
        WHERE NOT datistemplate ORDER BY 1`),
      // LIKE only to *detect* unexpected roles; nothing is ever dropped by pattern.
      crmRoles: (
        await q(`SELECT rolname FROM pg_roles WHERE rolname LIKE 'crm\\_%' ORDER BY 1`)
      ).map((r) => r.rolname),
      memberships: await q(`SELECT r.rolname AS role, m.rolname AS member, a.admin_option,
          a.inherit_option, a.set_option
        FROM pg_auth_members a JOIN pg_roles r ON r.oid = a.roleid JOIN pg_roles m ON m.oid = a.member
        WHERE r.rolname LIKE 'crm\\_%' OR m.rolname LIKE 'crm\\_%' ORDER BY 1, 2`),
      // Shared dependencies of crm_* roles outside the two test databases: anything here means
      // the roles own or hold privileges on something else, and nothing may be dropped.
      foreignDependencies: await q(
        `SELECT coalesce(d.datname, '(shared)') AS db,
          d2.classid::regclass::text AS catalog, d2.objid, a.rolname, d2.deptype
        FROM pg_shdepend d2 JOIN pg_roles a ON a.oid = d2.refobjid
        LEFT JOIN pg_database d ON d.oid = d2.dbid
        WHERE d2.refclassid = 'pg_authid'::regclass AND a.rolname LIKE 'crm\\_%'
          AND NOT (coalesce(d.datname, '') = ANY($1))
          AND NOT (d2.dbid = 0 AND d2.classid = 'pg_database'::regclass
                   AND d2.objid IN (SELECT oid FROM pg_database WHERE datname = ANY($1)))
          AND NOT (d2.dbid = 0 AND d2.classid IN ('pg_authid'::regclass, 'pg_auth_members'::regclass))`,
        [TEST_DATABASES],
      ),
      sessions: await q(
        `SELECT datname, usename, count(*)::int AS n FROM pg_stat_activity
        WHERE datname = ANY($1) AND pid <> pg_backend_pid() GROUP BY 1, 2 ORDER BY 1, 2`,
        [TEST_DATABASES],
      ),
    };
  } finally {
    await c.end();
  }
}
