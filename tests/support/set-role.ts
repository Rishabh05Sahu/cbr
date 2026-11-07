// Role-escalation probe for the db-roles tests: attempts SET ROLE and reports what happened,
// without ever turning an unexplained error into a denial.
//
// - 'permission denied': PostgreSQL's own refusal, i.e. SQLSTATE 42501 (insufficient_privilege)
//   AND a "permission denied" message, AND current_user unchanged afterwards.
// - NEON_REFUSED_OUTCOME: Neon's own refusal, accepted only when the caller enables the Neon rule
//   (a confirmed Neon test context, ./neon-context.ts) AND the target is on NEON_PROTECTED_ROLES
//   AND the SQLSTATE is exactly XX000 AND the message is exactly
//   "It is not allowed to change role to <target>" (string equality) AND current_user is unchanged
//   AND the session is not a member of the target (pg_has_role). XX000 is PostgreSQL's generic
//   internal_error code, so it is never enough on its own.
// - 'ALLOWED': SET ROLE succeeded (the role is reset before returning).
// - 'unexpected: …': anything else, with its SQLSTATE recorded but not interpreted.
// current_user is read again after every attempt, in autocommit (no transaction to abort), so a
// role change that happened despite an error is reported, not hidden.

export interface SqlClient {
  query(sql: string, values?: unknown[]): Promise<{ rows: Record<string, unknown>[] }>;
  escapeIdentifier(s: string): string;
}

export interface SetRoleOutcome {
  readonly outcome: string;
  /** SQLSTATE of the error, when the driver provides one; null otherwise. */
  readonly sqlstate: string | null;
  readonly currentUserUnchanged: boolean;
}

export const PERMISSION_DENIED = 'permission denied';
export const NEON_REFUSED_OUTCOME = 'refused by Neon (XX000, exact message)';
const INSUFFICIENT_PRIVILEGE = '42501';
const INTERNAL_ERROR = 'XX000';

/**
 * Roles for which Neon's own refusal was observed on the verified test branch (run
 * neon-2026-10-22T14-15-42-148Z, for crm_app, crm_auth and crm_platform alike: SQLSTATE XX000,
 * exact message, current_user unchanged, no membership). Reviewed list; never a pattern. The
 * provider admin (neondb_owner), cloud_admin and neon_service are deliberately absent: they must
 * keep PostgreSQL's 42501 refusal.
 */
export const NEON_PROTECTED_ROLES: ReadonlySet<string> = new Set([
  'neon_superuser',
  'pg_checkpoint',
  'pg_create_subscription',
  'pg_execute_server_program',
  'pg_maintain',
  'pg_monitor',
  'pg_read_all_data',
  'pg_read_all_settings',
  'pg_read_all_stats',
  'pg_read_server_files',
  'pg_signal_autovacuum_worker',
  'pg_signal_backend',
  'pg_use_reserved_connections',
  'pg_write_all_data',
  'pg_write_server_files',
]);

function sqlstateOf(e: unknown): string | null {
  const code = typeof e === 'object' && e !== null ? (e as { code?: unknown }).code : undefined;
  return typeof code === 'string' && /^[0-9A-Z]{5}$/.test(code) ? code : null;
}

const messageOf = (e: unknown) => (e instanceof Error ? e.message : String(e));

async function currentUser(c: SqlClient): Promise<string> {
  const { rows } = await c.query('SELECT current_user AS u');
  return String(rows[0]?.u);
}

export interface SetRoleOptions {
  /** Enable the Neon rule: pass only for a confirmed Neon test context. */
  readonly neonContext?: boolean;
}

export async function attemptSetRole(
  c: SqlClient,
  target: string,
  { neonContext = false }: SetRoleOptions = {},
): Promise<SetRoleOutcome> {
  const before = await currentUser(c);
  let outcome: string;
  let sqlstate: string | null = null;
  let neonCandidate = false;
  try {
    await c.query(`SET ROLE ${c.escapeIdentifier(target)}`);
    outcome = 'ALLOWED';
  } catch (e) {
    sqlstate = sqlstateOf(e);
    const message = messageOf(e);
    neonCandidate =
      neonContext &&
      NEON_PROTECTED_ROLES.has(target) &&
      sqlstate === INTERNAL_ERROR &&
      message === `It is not allowed to change role to ${target}`;
    outcome =
      sqlstate === INSUFFICIENT_PRIVILEGE && /permission denied/.test(message)
        ? PERMISSION_DENIED
        : `unexpected: ${message}`;
  }
  let after: string | null;
  try {
    after = await currentUser(c);
  } catch (e) {
    return {
      outcome: `unexpected: current_user unreadable after SET ROLE: ${messageOf(e)}`,
      sqlstate,
      currentUserUnchanged: false,
    };
  }
  if (outcome === 'ALLOWED') await c.query('RESET ROLE');
  const currentUserUnchanged = after === before;
  if (!currentUserUnchanged && outcome !== 'ALLOWED')
    return {
      outcome: `unexpected: current_user changed to ${after} although SET ROLE failed`,
      sqlstate,
      currentUserUnchanged,
    };
  if (neonCandidate) {
    // The session must not be able to reach the target as a member either.
    try {
      const { rows } = await c.query(
        `SELECT pg_has_role(current_user, $1::name, 'MEMBER') AS member`,
        [target],
      );
      if (rows[0]?.member !== false)
        return {
          outcome: `unexpected: ${target} is reachable as a member despite Neon's refusal`,
          sqlstate,
          currentUserUnchanged,
        };
    } catch (e) {
      return {
        outcome: `unexpected: membership check failed after Neon's refusal: ${messageOf(e)}`,
        sqlstate,
        currentUserUnchanged,
      };
    }
    outcome = NEON_REFUSED_OUTCOME;
  }
  return { outcome, sqlstate, currentUserUnchanged };
}

/** PostgreSQL's refusal: what every escalation attempt must produce (outside the Neon rule). */
export const DENIED: SetRoleOutcome = Object.freeze({
  outcome: PERMISSION_DENIED,
  sqlstate: INSUFFICIENT_PRIVILEGE,
  currentUserUnchanged: true,
});

/** Neon's refusal, valid only for NEON_PROTECTED_ROLES in a confirmed Neon test context. */
export const NEON_REFUSED: SetRoleOutcome = Object.freeze({
  outcome: NEON_REFUSED_OUTCOME,
  sqlstate: INTERNAL_ERROR,
  currentUserUnchanged: true,
});

const same = (a: SetRoleOutcome, b: SetRoleOutcome) =>
  a.outcome === b.outcome &&
  a.sqlstate === b.sqlstate &&
  a.currentUserUnchanged === b.currentUserUnchanged;

/**
 * Whether an outcome is an acceptable refusal for `target`: PostgreSQL's refusal always; Neon's
 * only for a protected role in a confirmed Neon context.
 */
export function isAcceptedRefusal(
  target: string,
  o: SetRoleOutcome,
  neonContext: boolean,
): boolean {
  if (same(o, DENIED)) return true;
  return neonContext && NEON_PROTECTED_ROLES.has(target) && same(o, NEON_REFUSED);
}
