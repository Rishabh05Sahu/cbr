// Local logical backup/restore drill on the production schema (NFR-021/022, approval §1).
// Seeds synthetic data, takes `pg_dump -Fc`, restores into a fresh database, verifies row counts,
// checksums and the security layer (RLS forced, policies, grants, definer functions), and
// records timings. Synthetic data only. Usage: node scripts/recovery/logical-restore-drill.mjs
import { writeFileSync } from 'node:fs';
import { spawnSync } from 'node:child_process';
import { docker, psql, seconds } from './lib.mjs';

const C = process.env.DRILL_CONTAINER ?? 'cbr-crm-postgres-1';
const SRC = 'crm_drill';
const DST = 'crm_drill_restore';
const ORGS = Number(process.env.DRILL_ORGS ?? 40);
const USERS_PER_ORG = Number(process.env.DRILL_USERS ?? 60);
const AUDIT_ROWS = Number(process.env.DRILL_AUDIT ?? 400_000);

const migratorUrl = (db) =>
  `postgresql://crm_migrator:${process.env.CRM_MIGRATOR_PASSWORD ?? 'local-migrator-pw'}@127.0.0.1:55432/${db}`;

function freshDb(db) {
  psql(C, 'postgres', `DROP DATABASE IF EXISTS ${db} WITH (FORCE)`);
  psql(C, 'postgres', `CREATE DATABASE ${db} OWNER crm_migrator`);
  psql(
    C,
    db,
    `REVOKE ALL ON DATABASE ${db} FROM PUBLIC; GRANT CONNECT ON DATABASE ${db} TO crm_app, crm_platform, crm_auth;
    CREATE EXTENSION IF NOT EXISTS citext; CREATE EXTENSION IF NOT EXISTS btree_gist; CREATE EXTENSION IF NOT EXISTS pg_trgm;
    ALTER SCHEMA public OWNER TO crm_migrator; REVOKE CREATE ON SCHEMA public FROM PUBLIC;
    GRANT USAGE ON SCHEMA public TO crm_app, crm_platform, crm_auth, crm_definer;`,
  );
}

function migrate(db) {
  const r = spawnSync('pnpm exec prisma migrate deploy', {
    shell: true,
    encoding: 'utf8',
    env: { ...process.env, DATABASE_MIGRATOR_URL: migratorUrl(db) },
  });
  if (r.status !== 0) throw new Error(`migrate failed: ${r.stderr || r.stdout}`);
}

const TABLES = [
  'organization',
  'user',
  'account',
  'organization_membership',
  'team',
  'team_membership',
  'audit_log',
  'outbox_event',
  'support_access_grant',
];

function fingerprint(db) {
  const out = {};
  for (const t of TABLES) {
    out[t] = psql(
      C,
      db,
      `SELECT count(*) || ':' || coalesce(md5(string_agg(id::text, ',' ORDER BY id)), '-') FROM "${t}"`,
    );
  }
  out._security = psql(
    C,
    db,
    `SELECT (SELECT count(*) FROM pg_class WHERE relnamespace='public'::regnamespace AND relkind='r' AND relname<>'_prisma_migrations' AND NOT (relrowsecurity AND relforcerowsecurity))
       || '/' || (SELECT count(*) FROM pg_policies WHERE schemaname='public')
       || '/' || (SELECT count(*) FROM information_schema.role_table_grants WHERE grantee IN ('crm_app','crm_auth','crm_platform','crm_definer'))
       || '/' || (SELECT string_agg(p.proname || '@' || r.rolname, ',' ORDER BY p.proname) FROM pg_proc p JOIN pg_roles r ON r.oid=p.proowner WHERE p.pronamespace='app'::regnamespace)`,
  );
  return out;
}

const t0 = Date.now();
console.log(`[drill] fresh source database ${SRC}`);
freshDb(SRC);
migrate(SRC);

console.log(
  `[drill] seeding ${ORGS} orgs x ${USERS_PER_ORG} users, ${AUDIT_ROWS} audit rows (synthetic)`,
);
psql(
  C,
  SRC,
  `
  INSERT INTO organization (id, name, slug) SELECT uuidv7(), 'Drill Org ' || g, 'drill-' || g FROM generate_series(1, ${ORGS}) g;
  INSERT INTO "user" (id, name, email, email_verified) SELECT uuidv7(), 'Drill User ' || g, 'drill' || g || '@example.test', true FROM generate_series(1, ${ORGS * USERS_PER_ORG}) g;
  INSERT INTO account (id, account_id, provider_id, user_id, password, updated_at) SELECT uuidv7(), u.id::text, 'credential', u.id, 'scrypt$synthetic', now() FROM "user" u;
  WITH o AS (SELECT id, row_number() OVER (ORDER BY id) - 1 AS n FROM organization),
       u AS (SELECT id, row_number() OVER (ORDER BY id) - 1 AS n FROM "user")
  INSERT INTO organization_membership (id, org_id, user_id, role)
  SELECT uuidv7(), o.id, u.id, CASE WHEN u.n % ${USERS_PER_ORG} = 0 THEN 'owner' WHEN u.n % 10 = 1 THEN 'sales_manager' ELSE 'sales_executive' END
  FROM u JOIN o ON o.n = u.n / ${USERS_PER_ORG};
  INSERT INTO team (org_id, name) SELECT o.id, 'Team ' || g FROM organization o, generate_series(1, 4) g;
  INSERT INTO team_membership (org_id, team_id, membership_id)
  SELECT m.org_id, (SELECT t.id FROM team t WHERE t.org_id = m.org_id ORDER BY t.id LIMIT 1), m.id FROM organization_membership m;
  INSERT INTO audit_log (org_id, actor_user_id, action, entity_type, metadata, occurred_at)
  SELECT m.org_id, m.user_id, 'drill.event', 'organization_membership', jsonb_build_object('n', g), now() - (g || ' seconds')::interval
  FROM generate_series(1, ${AUDIT_ROWS}) g JOIN LATERAL (SELECT org_id, user_id FROM organization_membership OFFSET (g % ${ORGS * USERS_PER_ORG}) LIMIT 1) m ON true;
  INSERT INTO outbox_event (org_id, type, payload, published_at) SELECT org_id, 'drill', '{}'::jsonb, now() FROM audit_log LIMIT 50000;
  ANALYZE;`,
  'crm_migrator',
);
const sizeMb = Number(psql(C, SRC, `SELECT round(pg_database_size('${SRC}') / 1048576.0)`));
const before = fingerprint(SRC);

console.log('[drill] pg_dump -Fc');
let t = Date.now();
docker('exec', C, 'pg_dump', '-U', 'postgres', '-Fc', '-Z', '6', '-f', '/tmp/drill.dump', SRC);
const dumpMs = Date.now() - t;
const dumpBytes = Number(docker('exec', C, 'stat', '-c', '%s', '/tmp/drill.dump'));

console.log('[drill] restore into a fresh database');
psql(C, 'postgres', `DROP DATABASE IF EXISTS ${DST} WITH (FORCE)`);
psql(C, 'postgres', `CREATE DATABASE ${DST} OWNER crm_migrator`);
t = Date.now();
docker(
  'exec',
  C,
  'pg_restore',
  '-U',
  'postgres',
  '-d',
  DST,
  '--exit-on-error',
  '-j',
  '4',
  '/tmp/drill.dump',
);
const restoreMs = Date.now() - t;
psql(
  C,
  DST,
  `REVOKE ALL ON DATABASE ${DST} FROM PUBLIC; GRANT CONNECT ON DATABASE ${DST} TO crm_app, crm_platform, crm_auth; ANALYZE;`,
);
const after = fingerprint(DST);

const mismatches = Object.keys(before).filter((k) => before[k] !== after[k]);
// Restored DB must still fail closed for the runtime role.
const appSees = psql(C, DST, `SET ROLE crm_app; SELECT count(*) FROM organization_membership`);

const result = {
  drill: 'logical-restore',
  ranAt: new Date().toISOString(),
  environment:
    'local Docker postgres:18.6 (Windows 11 laptop) — NOT representative of managed hosting',
  dataset: {
    orgs: ORGS,
    users: ORGS * USERS_PER_ORG,
    auditRows: AUDIT_ROWS,
    databaseSizeMb: sizeMb,
  },
  dumpSeconds: seconds(dumpMs),
  dumpSizeMb: Math.round(dumpBytes / 1048576),
  restoreSeconds: seconds(restoreMs),
  verification: {
    tablesCompared: TABLES.length,
    mismatches,
    securityLayer: after._security,
    runtimeRoleSeesWithoutContext: Number(appSees),
  },
  passed: mismatches.length === 0 && Number(appSees) === 0,
  totalSeconds: seconds(Date.now() - t0),
};
docker('exec', C, 'rm', '-f', '/tmp/drill.dump');
writeFileSync(
  'scripts/recovery/results/logical-restore.json',
  `${JSON.stringify(result, null, 2)}\n`,
);
console.log(JSON.stringify(result, null, 2));
if (!result.passed) process.exit(1);
