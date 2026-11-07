// Unit tests (no database) of the db-roles SET ROLE probe with a fake connection: only
// PostgreSQL's refusal with current_user unchanged counts as a denial.
import { describe, expect, it } from 'vitest';
import {
  DENIED,
  NEON_PROTECTED_ROLES,
  NEON_REFUSED,
  PERMISSION_DENIED,
  attemptSetRole,
  isAcceptedRefusal,
  type SqlClient,
} from './set-role';

const pgError = (message: string, code?: string) => Object.assign(new Error(message), { code });

/** A session as `crm_app`; `setRole` decides what SET ROLE does. */
function fakeClient(
  setRole: (target: string) => 'switch' | Error,
  opts: { breakAfter?: boolean } = {},
) {
  let current = 'crm_app';
  const log: string[] = [];
  const c: SqlClient = {
    escapeIdentifier: (s) => `"${s}"`,
    async query(sql) {
      log.push(sql);
      if (sql === 'SELECT current_user AS u') {
        if (opts.breakAfter && log.filter((l) => l.startsWith('SET ROLE')).length > 0)
          throw new Error('Connection terminated unexpectedly');
        return { rows: [{ u: current }] };
      }
      if (sql === 'RESET ROLE') {
        current = 'crm_app';
        return { rows: [] };
      }
      const target = /^SET ROLE "(.+)"$/.exec(sql)?.[1];
      if (target === undefined) throw new Error(`unexpected SQL ${sql}`);
      const r = setRole(target);
      if (r instanceof Error) throw r;
      current = target;
      return { rows: [] };
    },
  };
  return { c, log, current: () => current };
}

describe('attemptSetRole', () => {
  it("PostgreSQL's refusal (42501, permission denied, role unchanged) is a denial", async () => {
    const { c } = fakeClient(() =>
      pgError('permission denied to set role "crm_migrator"', '42501'),
    );
    expect(await attemptSetRole(c, 'crm_migrator')).toEqual(DENIED);
  });

  it('a successful SET ROLE is ALLOWED, reported as a role change, and is reset', async () => {
    const f = fakeClient(() => 'switch');
    const r = await attemptSetRole(f.c, 'pg_read_all_data');
    expect(r).toEqual({ outcome: 'ALLOWED', sqlstate: null, currentUserUnchanged: false });
    expect(r).not.toEqual(DENIED);
    expect(f.current()).toBe('crm_app');
    expect(f.log).toContain('RESET ROLE');
  });

  it('a provider-specific refusal is unexpected (SQLSTATE recorded, not interpreted)', async () => {
    const { c } = fakeClient(() =>
      pgError('It is not allowed to change role to neon_superuser', '22023'),
    );
    expect(await attemptSetRole(c, 'neon_superuser')).toEqual({
      outcome: 'unexpected: It is not allowed to change role to neon_superuser',
      sqlstate: '22023',
      currentUserUnchanged: true,
    });
  });

  it('a "permission denied" message without SQLSTATE 42501 is not a denial', async () => {
    for (const code of [undefined, '22023', 'ECONNRESET']) {
      const { c } = fakeClient(() => pgError('permission denied to set role "x"', code));
      const r = await attemptSetRole(c, 'x');
      expect(r.outcome).toMatch(/^unexpected: /);
      expect(r).not.toEqual(DENIED);
    }
  });

  it('42501 with another message is not a denial either', async () => {
    const { c } = fakeClient(() => pgError('must be owner of role x', '42501'));
    expect((await attemptSetRole(c, 'x')).outcome).toBe('unexpected: must be owner of role x');
  });

  it('unrelated failures are unexpected, never a denial', async () => {
    const { c } = fakeClient(() => new Error('Connection terminated unexpectedly'));
    const r = await attemptSetRole(c, 'x');
    expect(r).toEqual({
      outcome: 'unexpected: Connection terminated unexpectedly',
      sqlstate: null,
      currentUserUnchanged: true,
    });
  });

  it('if current_user cannot be read afterwards, the result is unexpected and not unchanged', async () => {
    const { c } = fakeClient(() => pgError('permission denied to set role "x"', '42501'), {
      breakAfter: true,
    });
    expect(await attemptSetRole(c, 'x')).toEqual({
      outcome:
        'unexpected: current_user unreadable after SET ROLE: Connection terminated unexpectedly',
      sqlstate: '42501',
      currentUserUnchanged: false,
    });
  });

  it('a role change despite an error is reported, not hidden', async () => {
    let current = 'crm_app';
    const c: SqlClient = {
      escapeIdentifier: (s) => `"${s}"`,
      async query(sql) {
        if (sql === 'SELECT current_user AS u') return { rows: [{ u: current }] };
        current = 'pg_write_all_data'; // the change happened…
        throw pgError('permission denied to set role "pg_write_all_data"', '42501'); // …yet errored
      },
    };
    const r = await attemptSetRole(c, 'pg_write_all_data');
    expect(r.currentUserUnchanged).toBe(false);
    expect(r.outcome).toBe(
      'unexpected: current_user changed to pg_write_all_data although SET ROLE failed',
    );
    expect(r.outcome).not.toBe(PERMISSION_DENIED);
  });
});

// Neon's observed refusal (run neon-2026-10-22T14-15-42-148Z), e.g. for pg_read_all_data.
const neonRefusal = (target: string) =>
  pgError(`It is not allowed to change role to ${target}`, 'XX000');

/** A crm_app session on Neon: SET ROLE fails as given; pg_has_role answers `member`. */
function neonClient(err: (target: string) => Error, member: unknown = false) {
  const log: string[] = [];
  const c: SqlClient = {
    escapeIdentifier: (s) => `"${s}"`,
    async query(sql, values) {
      log.push(sql);
      if (sql === 'SELECT current_user AS u') return { rows: [{ u: 'crm_app' }] };
      if (sql.includes('pg_has_role')) {
        if (member instanceof Error) throw member;
        return { rows: [{ member, target: values?.[0] }] };
      }
      const target = /^SET ROLE "(.+)"$/.exec(sql)?.[1];
      if (target === undefined) throw new Error(`unexpected SQL ${sql}`);
      throw err(target);
    },
  };
  return { c, log };
}

describe('the narrow Neon refusal rule', () => {
  const NEON = { neonContext: true };

  it('the allowlist holds exactly the 15 observed roles and none of the native-refusal roles', () => {
    expect(NEON_PROTECTED_ROLES.size).toBe(15);
    for (const r of ['neondb_owner', 'cloud_admin', 'neon_service', 'crm_migrator', 'crm_app'])
      expect(NEON_PROTECTED_ROLES.has(r)).toBe(false);
  });

  it('accepts the exact observed behaviour for every allowlisted role in a Neon context', async () => {
    for (const target of NEON_PROTECTED_ROLES) {
      const { c, log } = neonClient(neonRefusal);
      const r = await attemptSetRole(c, target, NEON);
      expect(r).toEqual(NEON_REFUSED);
      expect(isAcceptedRefusal(target, r, true)).toBe(true);
      expect(log.some((l) => l.includes('pg_has_role'))).toBe(true); // membership confirmed
    }
  });

  it('without a confirmed Neon context the same refusal is unexpected', async () => {
    const { c } = neonClient(neonRefusal);
    const r = await attemptSetRole(c, 'pg_read_all_data');
    expect(r.outcome).toBe('unexpected: It is not allowed to change role to pg_read_all_data');
    expect(isAcceptedRefusal('pg_read_all_data', r, false)).toBe(false);
    // Even a forged NEON_REFUSED outcome is not accepted outside the context.
    expect(isAcceptedRefusal('pg_read_all_data', NEON_REFUSED, false)).toBe(false);
  });

  it('the provider admin and other native-refusal roles never get the Neon rule', async () => {
    for (const target of ['neondb_owner', 'cloud_admin', 'neon_service', 'crm_migrator']) {
      const { c } = neonClient(neonRefusal);
      const r = await attemptSetRole(c, target, NEON);
      expect(r.outcome).toMatch(/^unexpected: /);
      expect(isAcceptedRefusal(target, r, true)).toBe(false);
      expect(isAcceptedRefusal(target, NEON_REFUSED, true)).toBe(false);
    }
  });

  it('an unknown role is not accepted even with the exact message and XX000', async () => {
    const { c } = neonClient(neonRefusal);
    expect((await attemptSetRole(c, 'pg_some_future_role', NEON)).outcome).toMatch(/^unexpected/);
  });

  it('XX000 alone, other messages, loose matches or another code are not accepted', async () => {
    const t = 'pg_write_all_data';
    for (const e of [
      pgError('internal error', 'XX000'),
      pgError(`It is not allowed to change role to ${t}.`, 'XX000'),
      pgError(`ERROR: It is not allowed to change role to ${t}`, 'XX000'),
      pgError(`It is not allowed to change role to pg_read_all_data`, 'XX000'), // other role
      pgError(`it is not allowed to change role to ${t}`, 'XX000'),
      pgError(`It is not allowed to change role to ${t}`, '42501'),
      pgError(`It is not allowed to change role to ${t}`, undefined),
    ]) {
      const { c } = neonClient(() => e);
      const r = await attemptSetRole(c, t, NEON);
      expect(r).not.toEqual(NEON_REFUSED);
      expect(isAcceptedRefusal(t, r, true)).toBe(false);
    }
  });

  it('membership in the target, or a failed membership check, is never a refusal', async () => {
    for (const member of [true, null, new Error('connection lost')]) {
      const { c } = neonClient(neonRefusal, member);
      const r = await attemptSetRole(c, 'pg_monitor', NEON);
      expect(r.outcome).toMatch(/^unexpected: /);
      expect(isAcceptedRefusal('pg_monitor', r, true)).toBe(false);
    }
  });

  it('an unreadable or changed current_user is never a refusal under the Neon rule', async () => {
    let calls = 0;
    const unreadable: SqlClient = {
      escapeIdentifier: (s) => `"${s}"`,
      async query(sql) {
        if (sql === 'SELECT current_user AS u') {
          if (calls++ > 0) throw new Error('Connection terminated unexpectedly');
          return { rows: [{ u: 'crm_app' }] };
        }
        throw neonRefusal('pg_monitor');
      },
    };
    expect((await attemptSetRole(unreadable, 'pg_monitor', NEON)).outcome).toMatch(
      /current_user unreadable/,
    );
    let current = 'crm_app';
    const changed: SqlClient = {
      escapeIdentifier: (s) => `"${s}"`,
      async query(sql) {
        if (sql === 'SELECT current_user AS u') return { rows: [{ u: current }] };
        if (sql.includes('pg_has_role')) return { rows: [{ member: false }] };
        current = 'pg_monitor';
        throw neonRefusal('pg_monitor');
      },
    };
    const r = await attemptSetRole(changed, 'pg_monitor', NEON);
    expect(r.outcome).toBe(
      'unexpected: current_user changed to pg_monitor although SET ROLE failed',
    );
  });

  it("PostgreSQL's own refusal stays accepted for allowlisted roles too", async () => {
    const { c } = neonClient(() => pgError('permission denied to set role "pg_monitor"', '42501'));
    const r = await attemptSetRole(c, 'pg_monitor', NEON);
    expect(r).toEqual(DENIED);
    expect(isAcceptedRefusal('pg_monitor', r, true)).toBe(true);
    expect(isAcceptedRefusal('pg_monitor', r, false)).toBe(true);
  });
});
