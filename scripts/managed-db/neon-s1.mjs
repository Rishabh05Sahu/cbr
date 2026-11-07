// S1 managed-PostgreSQL run against a Neon TEST branch (owner instruction 2026-10-21).
// Synthetic data only. Never prints the env file, URLs or passwords.
//
//   node scripts/managed-db/neon-s1.mjs --branch-id br-… [--env-file .env.s1-managed]
//        [--check-only] [--batches s1-01-02,s1-03-07] [--resume <run directory>]
//        [--diagnostic-tx-max-wait-ms <ms> --batches s1-08,pooled-s1-08[,db-roles]]
//
// Before anything is created it proves the connection target (neon-target.mjs): the Neon
// control plane and the server itself must both name --branch-id, which must not be the
// production branch. A fresh run also requires the branch to be clean (no crm_s1/crm_test, no
// crm_* roles; scripts/managed-db/neon-clean.mjs gets it there). --resume continues an
// interrupted run on the same branch. Then it hands over to s1-managed-run.mjs with:
//   MANAGED_ADMIN_URL = DATABASE_URL_UNPOOLED (owner role; roles, databases and migrations need
//                       a direct session), MANAGED_POOL_HOST = the host of DATABASE_URL (Neon's
//                       PgBouncer, transaction mode) for the pooled S1-03…08 re-run,
//   MANAGED_CA_FILE   = ISRG Root X1 from Node's bundled root store (Neon's chain ends there),
//                       so TLS stays verify-full for node-postgres, psql and Prisma.
//
// --diagnostic-tx-max-wait-ms: NON-BINDING WAN diagnostic of S1-08 only
// (docs/NEON-S1-FAILURE-TRIAGE.md §1d). Accepted only after the target checks above, for a
// branch that is not a production branch, with an explicit --batches list limited to s1-08,
// pooled-s1-08 and db-roles (diagnostic-override.mjs). The run directory is
// neon-diagnostic-<time>, and the runner re-checks the server identity before S1-08. The runner
// accepts the override only with the one-time authorization issued here, bound to this process,
// the verified target, the timeout, the batches and the endpoint hosts.
import { spawnSync } from 'node:child_process';
import { X509Certificate } from 'node:crypto';
import { existsSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { rootCertificates } from 'node:tls';
import { parseArgs } from 'node:util';
import {
  assertNoDirectDiagnosticEnv,
  assertNoManagedDiagnosticEnv,
  issueDiagnosticAuthorization,
  validateDiagnosticRequest,
} from './diagnostic-override.mjs';
import {
  Stop,
  TEST_DATABASES,
  expectedRoles,
  inventory,
  verifyNeonTarget,
} from './neon-target.mjs';

const { values: args } = parseArgs({
  options: {
    'branch-id': { type: 'string' },
    'env-file': { type: 'string', default: '.env.s1-managed' },
    'project-id': { type: 'string' },
    'check-only': { type: 'boolean', default: false },
    batches: { type: 'string' },
    resume: { type: 'string' },
    'diagnostic-tx-max-wait-ms': { type: 'string' },
  },
});

let t;
let diagnostic = null;
try {
  // The override comes only from the flag, never from the shell environment.
  try {
    assertNoDirectDiagnosticEnv(process.env);
    assertNoManagedDiagnosticEnv(process.env);
  } catch (e) {
    throw new Stop(e.message);
  }
  t = await verifyNeonTarget({
    branchId: args['branch-id'],
    envFile: args['env-file'],
    projectId: args['project-id'],
  });
  const inv = await inventory(t.direct);
  const leftovers = {
    databases: inv.databases.map((d) => d.datname).filter((d) => TEST_DATABASES.includes(d)),
    roles: inv.crmRoles,
  };
  console.log(
    'Target verified:',
    JSON.stringify({ ...t.target, preRunState: t.server, leftovers }, null, 2),
  );
  if (args.resume) {
    const state = JSON.parse(readFileSync(join(args.resume, 'state.json'), 'utf8'));
    if (state.target?.branchId !== t.target.branchId)
      throw new Stop('the run being resumed was made against a different branch');
    const roles = expectedRoles();
    if (JSON.stringify(inv.crmRoles) !== JSON.stringify(roles) || leftovers.databases.length !== 2)
      throw new Stop('the test databases/roles to resume on are missing or unexpected');
  } else if (leftovers.databases.length || leftovers.roles.length) {
    throw new Stop(
      'the branch is not clean: run scripts/managed-db/neon-clean.mjs, or --resume <run directory>',
    );
  }
  if (args['diagnostic-tx-max-wait-ms'] !== undefined) {
    try {
      diagnostic = validateDiagnosticRequest({
        maxWaitMs: args['diagnostic-tx-max-wait-ms'],
        batches: args.batches,
        target: t.target,
      });
    } catch (e) {
      throw new Stop(e.message);
    }
    console.log(
      'DIAGNOSTIC OVERRIDE (non-binding):',
      JSON.stringify({ ...diagnostic, productionBranchIds: undefined }),
    );
  }
} catch (e) {
  console.error(
    e instanceof Stop ? `STOP: ${e.message}` : `ERROR: ${t?.scrub(e.message) ?? 'see above'}`,
  );
  process.exit(1);
}
if (args['check-only']) process.exit(0);
if (args.resume && !existsSync(join(args.resume, 'state.json'))) process.exit(1);

// ISRG Root X1: public root certificate, written to a temporary file for psql and Prisma.
const root = rootCertificates.find((p) =>
  new X509Certificate(p).subject.includes('CN=ISRG Root X1'),
);
if (!root) throw new Error('ISRG Root X1 not in the Node root store');
const ca = join(tmpdir(), `cbr-neon-ca-${process.pid}.crt`);
writeFileSync(ca, root);

const adminUrl = new URL(t.direct);
adminUrl.search = '';
const targetJson = JSON.stringify(t.target);
// One-time authorization for the runner (diagnostic only): its parent must be this process.
const auth = diagnostic
  ? issueDiagnosticAuthorization({
      diag: diagnostic,
      targetJson,
      batches: args.batches,
      adminHost: adminUrl.hostname,
      poolHost: t.pooled.hostname,
    })
  : null;
// process.execPath, not 'node': the runner must be this process's direct child.
const r = spawnSync(process.execPath, ['scripts/managed-db/s1-managed-run.mjs'], {
  stdio: 'inherit',
  env: {
    ...process.env,
    MANAGED_ADMIN_URL: adminUrl.toString(),
    MANAGED_CA_FILE: ca,
    MANAGED_POOL_HOST: t.pooled.hostname,
    MANAGED_LABEL: diagnostic ? 'neon-diagnostic' : 'neon',
    MANAGED_DIAG_TX_MAX_WAIT_MS: diagnostic ? String(diagnostic.txStartMaxWaitMs) : '',
    ...(auth?.env ?? {}),
    MANAGED_TARGET: targetJson,
    MANAGED_MUTATION_CHECK: '1',
    MANAGED_SERVER_TIMING: '1',
    ...(args.batches ? { MANAGED_BATCHES: args.batches } : {}),
    ...(args.resume ? { MANAGED_RESUME_DIR: args.resume } : {}),
    // Round trips from the test machine (≈250 ms to us-east-2): wall-clock limits only.
    MANAGED_TEST_TIMEOUT_MS: process.env.MANAGED_TEST_TIMEOUT_MS ?? '3600000',
    S1_LONG_TEST_TIMEOUT_MS: process.env.S1_LONG_TEST_TIMEOUT_MS ?? '28800000',
    S1_CONNECTION_TIMEOUT_MS: process.env.S1_CONNECTION_TIMEOUT_MS ?? '120000',
  },
});
rmSync(ca, { force: true });
if (auth) rmSync(auth.dir, { recursive: true, force: true });
process.exit(r.status ?? 1);
