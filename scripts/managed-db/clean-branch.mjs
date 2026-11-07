// The cleanup flow of neon-clean.mjs, with its connections passed in so that the checks can be
// tested without a database. neon-clean.mjs wires it to verifyNeonTarget(), inventory() and pg.
//
// Every failure is reported with the phase it happened in (describeFailure), because what the
// operator may assume differs:
//   before changes      only reads so far (Neon API GETs, SELECTs): this invocation changed nothing;
//   changes             GRANT/DROP statements had started: the branch may be partly cleaned
//                       (some objects removed, others remaining, the temporary membership left);
//   final verification  the statements completed, but the resulting state is unverified.
// Recovery after a partial cleanup: docs/runbooks/staging-preparation.md, "Partial cleanup recovery".
import pg from 'pg';
import { BASE_DATABASES, Stop, TEST_DATABASES } from './neon-target.mjs';

export const PHASE = Object.freeze({
  BEFORE: 'before changes',
  CHANGES: 'changes',
  FINAL: 'final verification',
});
const RECOVERY =
  'Do not rerun cleanup blindly: follow "Partial cleanup recovery" in ' +
  'docs/runbooks/staging-preparation.md and inspect the live state first.';

/** A cleanup failure and the phase it happened in; `completed` lists statements that succeeded. */
export class CleanupFailure extends Error {
  constructor(phase, completed, cause) {
    super(cause?.message ?? String(cause));
    this.name = 'CleanupFailure';
    this.phase = phase;
    this.completed = [...completed];
    this.cause = cause;
  }
}

/**
 * The operator message for any error thrown by neon-clean.mjs. `scrub` removes secrets from the
 * underlying error text. Only the before-changes phase says that nothing was changed.
 */
export function describeFailure(e, scrub = String) {
  if (!(e instanceof CleanupFailure))
    // Thrown before cleanBranch() started (arguments, bootstrap SQL): nothing was read or changed.
    return `ERROR: cleanup aborted before it started; this invocation made no changes. ${scrub(e?.message ?? e)}`;
  const cause = scrub(e.message);
  const done = e.completed.length ? e.completed.join('; ') : 'none';
  if (e.phase === PHASE.BEFORE)
    return `${e.cause instanceof Stop ? 'STOP' : 'ERROR'}: cleanup aborted before any change; this invocation made no changes. ${cause}`;
  if (e.phase === PHASE.CHANGES)
    return (
      'ERROR: cleanup failed after it started changing the test branch. The branch may now be ' +
      'partly cleaned: some databases or roles may be removed while others remain, and the ' +
      'temporary crm_migrator membership of the admin may still be granted. ' +
      `Statements that completed before the failure: ${done}. ${RECOVERY} Cause: ${cause}`
    );
  return (
    `ERROR: final re-verification failed after the cleanup statements ran (completed: ${done}). ` +
    `The resulting state is unverified. ${RECOVERY} Cause: ${cause}`
  );
}

/**
 * Every check before any change. Returns the exact test objects present (a subset of
 * TEST_DATABASES and `roles`), or throws Stop. Nothing is changed here.
 */
export function planCleanup(before, roles, admin) {
  const dbNames = before.databases.map((d) => d.datname);
  const unexpectedDbs = dbNames.filter((d) => ![...BASE_DATABASES, ...TEST_DATABASES].includes(d));
  if (unexpectedDbs.length) throw new Stop(`unexpected databases: ${unexpectedDbs.join(', ')}`);
  for (const d of before.databases)
    if (TEST_DATABASES.includes(d.datname) && d.owner !== 'crm_migrator')
      throw new Stop(`${d.datname} is owned by ${d.owner}, expected crm_migrator`);
  const unexpectedRoles = before.crmRoles.filter((r) => !roles.includes(r));
  if (unexpectedRoles.length)
    throw new Stop(`unexpected crm_* roles: ${unexpectedRoles.join(', ')}`);
  // Expected memberships only: crm_migrator in crm_definer, and the admin's automatic ADMIN
  // membership in each role it created (PostgreSQL 16+ CREATEROLE), without INHERIT or SET.
  for (const m of before.memberships) {
    const definer = m.role === 'crm_definer' && m.member === 'crm_migrator';
    const creator =
      roles.includes(m.role) &&
      m.member === admin &&
      m.admin_option &&
      !m.inherit_option &&
      !m.set_option;
    if (!definer && !creator) throw new Stop(`unexpected membership: ${JSON.stringify(m)}`);
  }
  if (before.foreignDependencies.length)
    throw new Stop(`crm_* roles have dependencies outside the test databases`);
  // A session on a test database means a run (or something else) is still using it. Sessions
  // are never terminated here: the operator stops the run and retries.
  if (!Array.isArray(before.sessions))
    throw new Stop('session inventory missing: cannot prove that no run is active');
  if (before.sessions.length) {
    const who = before.sessions.map((s) => `${s.datname}: ${s.n} as ${s.usename}`).join('; ');
    throw new Stop(
      `cleanup aborted: active sessions on the test databases (${who}). Identify and stop the ` +
        'active run (or wait for idle pooled connections to close), then retry. Sessions are ' +
        'never terminated by this script.',
    );
  }
  return {
    databases: TEST_DATABASES.filter((d) => dbNames.includes(d)),
    roles: roles.filter((r) => before.crmRoles.includes(r)),
  };
}

/**
 * verify(): verifyNeonTarget result; takeInventory(direct): inventory(); connect(direct): an
 * unconnected pg.Client-like admin session. Returns 'already clean' | 'dry run' | 'clean' |
 * 'not clean'; throws Stop before any change when a check fails.
 */
export async function cleanBranch(options) {
  const progress = { phase: PHASE.BEFORE, completed: [] };
  try {
    return await cleanBranchPhases(options, progress);
  } catch (e) {
    throw new CleanupFailure(progress.phase, progress.completed, e);
  }
}

async function cleanBranchPhases(
  { verify, takeInventory, connect, roles, dryRun, log = console.log },
  progress,
) {
  const t = await verify();
  log('Target verified:', JSON.stringify(t.target));
  const admin = t.target.adminRole;

  const before = await takeInventory(t.direct);
  log('Before:', JSON.stringify(before, null, 2));

  // --- every check before any change ---
  const present = planCleanup(before, roles, admin);
  if (!present.databases.length && !present.roles.length) {
    log('Already clean: nothing to remove.');
    return 'already clean';
  }
  log('Will remove:', JSON.stringify(present));
  if (dryRun) {
    log('Dry run: nothing changed.');
    return 'dry run';
  }

  // --- changes (admin session on neondb) ---
  const c = connect(t.direct);
  await c.connect();
  // From the first statement on, a failure may leave the branch partly cleaned.
  const exec = async (sql) => {
    progress.phase = PHASE.CHANGES;
    await c.query(sql);
    progress.completed.push(sql);
  };
  try {
    // Dropping a database needs its owner's privileges: a temporary INHERIT-only membership of
    // the admin in crm_migrator. It goes away only when DROP ROLE crm_migrator below succeeds;
    // if the cleanup fails before that, the membership remains (see describeFailure).
    if (present.databases.length && before.crmRoles.includes('crm_migrator'))
      await exec('GRANT crm_migrator TO CURRENT_USER WITH INHERIT TRUE, SET FALSE');
    for (const db of present.databases) {
      // No FORCE: a session that appeared after the check makes the drop fail, never ends it.
      await exec(`DROP DATABASE ${pg.escapeIdentifier(db)}`);
      log(`dropped database ${db}`);
    }
    for (const role of present.roles) {
      await exec(`DROP ROLE ${pg.escapeIdentifier(role)}`);
      log(`dropped role ${role}`);
    }
  } finally {
    await c.end();
  }

  // --- verify ---
  progress.phase = PHASE.FINAL;
  const after = await takeInventory(t.direct);
  const again = await verify();
  const clean =
    after.crmRoles.length === 0 &&
    JSON.stringify(after.databases.map((d) => d.datname)) === JSON.stringify(BASE_DATABASES) &&
    after.memberships.length === 0 &&
    again.server.user_tables_in_db === 0;
  log(
    'After:',
    JSON.stringify({ ...after, neondbUserTables: again.server.user_tables_in_db }, null, 2),
  );
  log(
    clean
      ? 'CLEAN: test branch is back to its pre-S1 state.'
      : `NOT CLEAN: see above. The branch may be partly cleaned. ${RECOVERY}`,
  );
  return clean ? 'clean' : 'not clean';
}
