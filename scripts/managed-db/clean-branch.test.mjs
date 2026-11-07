// Unit tests (no database) of the neon-clean.mjs flow: synthetic inventories and a recording
// admin client. A refused cleanup must not open the admin session, grant or drop anything.
import { describe, expect, it } from 'vitest';
import {
  CleanupFailure,
  PHASE,
  cleanBranch,
  describeFailure,
  planCleanup,
} from './clean-branch.mjs';
import { Stop } from './neon-target.mjs';

const ADMIN = 'neondb_owner';
const ROLES = ['crm_app', 'crm_auth', 'crm_definer', 'crm_migrator', 'crm_platform'];
const creator = (role) => ({
  role,
  member: ADMIN,
  admin_option: true,
  inherit_option: false,
  set_option: false,
});
const afterRun = (o = {}) => ({
  databases: [
    { datname: 'crm_s1', owner: 'crm_migrator' },
    { datname: 'crm_test', owner: 'crm_migrator' },
    { datname: 'neondb', owner: ADMIN },
    { datname: 'postgres', owner: 'cloud_admin' },
  ],
  crmRoles: ROLES,
  memberships: [
    { role: 'crm_definer', member: 'crm_migrator', admin_option: false },
    ...ROLES.map(creator),
  ],
  foreignDependencies: [],
  sessions: [],
  ...o,
});
const cleaned = {
  databases: [
    { datname: 'neondb', owner: ADMIN },
    { datname: 'postgres', owner: 'cloud_admin' },
  ],
  crmRoles: [],
  memberships: [],
  foreignDependencies: [],
  sessions: [],
};

/** Runs cleanBranch with the given first inventory; records every admin-session action. */
async function attempt(
  before,
  { dryRun = false, failQuery, failSecondVerify = false, after = cleaned, logs = [] } = {},
) {
  const actions = [];
  const inventories = [before, after];
  let verifications = 0;
  const target = {
    target: { adminRole: ADMIN },
    direct: 'synthetic',
    server: { user_tables_in_db: 0 },
  };
  const run = cleanBranch({
    verify: async () => {
      verifications++;
      if (failSecondVerify && verifications === 2)
        throw new Stop('server-reported Neon identity does not match the control plane');
      return target;
    },
    takeInventory: async () => inventories.shift(),
    connect: () => {
      actions.push('connect');
      return {
        connect: async () => actions.push('session opened'),
        query: async (sql) => {
          if (sql === failQuery)
            throw new Error('database "crm_test" is being accessed by other users');
          actions.push(sql);
        },
        end: async () => actions.push('session closed'),
      };
    },
    roles: ROLES,
    dryRun,
    log: (...a) => logs.push(a.join(' ')),
  });
  return { run, actions };
}

describe('neon-clean: active sessions stop the cleanup before any change', () => {
  const active = [
    { datname: 'crm_s1', usename: 'crm_app', n: 5 },
    { datname: 'crm_test', usename: 'crm_migrator', n: 1 },
  ];

  it('refuses with active sessions: no admin session, no grant, no drop', async () => {
    const { run, actions } = await attempt(afterRun({ sessions: active }));
    await expect(run).rejects.toMatchObject({ phase: PHASE.BEFORE, completed: [] });
    await expect(run).rejects.toSatisfy((e) => e.cause instanceof Stop);
    await expect(run).rejects.toThrow(/cleanup aborted: active sessions.*stop the\s+active run/s);
    expect(actions).toEqual([]);
  });

  it('a single session is enough, and the dry run refuses too', async () => {
    const one = [{ datname: 'crm_s1', usename: 'crm_app', n: 1 }];
    for (const dryRun of [false, true]) {
      const { run, actions } = await attempt(afterRun({ sessions: one }), { dryRun });
      await expect(run).rejects.toThrow(/crm_s1: 1 as crm_app/);
      expect(actions).toEqual([]);
    }
  });

  it('the error names databases, roles and counts only, and says sessions are never ended', () => {
    expect(() => planCleanup(afterRun({ sessions: active }), ROLES, ADMIN)).toThrow(
      /\(crm_s1: 5 as crm_app; crm_test: 1 as crm_migrator\).*never terminated/s,
    );
  });

  it('fails closed when the session inventory is missing', async () => {
    const { run, actions } = await attempt(afterRun({ sessions: undefined }));
    await expect(run).rejects.toThrow(/cannot prove that no run is active/);
    expect(actions).toEqual([]);
  });
});

describe('neon-clean: unchanged checks and exact deletion list', () => {
  it.each([
    [
      'another database',
      { databases: [...afterRun().databases, { datname: 'other', owner: ADMIN }] },
      /unexpected databases: other/,
    ],
    [
      'a test database not owned by crm_migrator',
      { databases: [{ datname: 'crm_s1', owner: ADMIN }] },
      /crm_s1 is owned by neondb_owner/,
    ],
    [
      'another crm_* role',
      { crmRoles: [...ROLES, 'crm_extra'] },
      /unexpected crm_\* roles: crm_extra/,
    ],
    [
      'an unexpected membership',
      { memberships: [{ role: 'crm_app', member: 'crm_auth' }] },
      /unexpected membership/,
    ],
    ['a foreign dependency', { foreignDependencies: [{ db: 'neondb' }] }, /dependencies outside/],
  ])('stops on %s, before any change', async (_, o, err) => {
    const { run, actions } = await attempt(afterRun(o));
    await expect(run).rejects.toThrow(err);
    expect(actions).toEqual([]);
  });

  it('dry run without sessions: reports, changes nothing', async () => {
    const { run, actions } = await attempt(afterRun(), { dryRun: true });
    expect(await run).toBe('dry run');
    expect(actions).toEqual([]);
  });

  it('no sessions: drops exactly the two test databases and five roles, without FORCE', async () => {
    const { run, actions } = await attempt(afterRun());
    expect(await run).toBe('clean');
    expect(actions).toEqual([
      'connect',
      'session opened',
      'GRANT crm_migrator TO CURRENT_USER WITH INHERIT TRUE, SET FALSE',
      'DROP DATABASE "crm_s1"',
      'DROP DATABASE "crm_test"',
      'DROP ROLE "crm_app"',
      'DROP ROLE "crm_auth"',
      'DROP ROLE "crm_definer"',
      'DROP ROLE "crm_migrator"',
      'DROP ROLE "crm_platform"',
      'session closed',
    ]);
  });

  it('already clean: nothing to do, no admin session', async () => {
    const { run, actions } = await attempt(cleaned);
    expect(await run).toBe('already clean');
    expect(actions).toEqual([]);
  });
});

describe('neon-clean: failures say which phase they happened in (P1)', () => {
  const GRANT = 'GRANT crm_migrator TO CURRENT_USER WITH INHERIT TRUE, SET FALSE';
  const NO_CHANGE = /made no changes|nothing changed/i;
  const failure = async (a) => {
    try {
      await a.run;
    } catch (e) {
      return e;
    }
    throw new Error('expected the cleanup to fail');
  };

  it('before any change: STOP, and says this invocation made no changes', async () => {
    const a = await attempt(
      afterRun({ sessions: [{ datname: 'crm_s1', usename: 'crm_app', n: 1 }] }),
    );
    const e = await failure(a);
    expect(e).toBeInstanceOf(CleanupFailure);
    expect(e.phase).toBe(PHASE.BEFORE);
    expect(a.actions).toEqual([]);
    expect(describeFailure(e)).toMatch(
      /^STOP: cleanup aborted before any change; this invocation made no changes\. cleanup aborted: active sessions/,
    );
  });

  it('a non-Stop error before any change (e.g. inventory connection) is ERROR, no changes', async () => {
    const a = await attempt(afterRun({ sessions: undefined }));
    const e = await failure(a);
    expect(describeFailure(e)).toMatch(/^STOP: cleanup aborted before any change/);
    const thrown = new CleanupFailure(PHASE.BEFORE, [], new Error('connect ETIMEDOUT'));
    expect(describeFailure(thrown)).toMatch(
      /^ERROR: cleanup aborted before any change; this invocation made no changes\. connect ETIMEDOUT$/,
    );
  });

  it('after changes started: lists what completed, warns of a partial state, never says nothing changed', async () => {
    const a = await attempt(afterRun(), { failQuery: 'DROP DATABASE "crm_test"' });
    const e = await failure(a);
    expect(e.phase).toBe(PHASE.CHANGES);
    expect(e.completed).toEqual([GRANT, 'DROP DATABASE "crm_s1"']);
    // The admin session is still closed, and nothing after the failing statement ran.
    expect(a.actions).toEqual([
      'connect',
      'session opened',
      GRANT,
      'DROP DATABASE "crm_s1"',
      'session closed',
    ]);
    const msg = describeFailure(e);
    expect(msg).toMatch(/^ERROR: cleanup failed after it started changing the test branch/);
    expect(msg).toMatch(/may now be partly cleaned/);
    expect(msg).toMatch(/temporary crm_migrator membership of the admin may still be granted/);
    expect(msg).toContain(
      `Statements that completed before the failure: ${GRANT}; DROP DATABASE "crm_s1".`,
    );
    expect(msg).toMatch(/Partial cleanup recovery/);
    expect(msg).toMatch(/Cause: database "crm_test" is being accessed by other users$/);
    expect(msg).not.toMatch(NO_CHANGE);
  });

  it('a failure of the very first statement is still uncertain, not "no changes"', async () => {
    const a = await attempt(afterRun(), { failQuery: GRANT });
    const e = await failure(a);
    expect(e.phase).toBe(PHASE.CHANGES);
    expect(e.completed).toEqual([]);
    const msg = describeFailure(e);
    expect(msg).toContain('Statements that completed before the failure: none.');
    expect(msg).toMatch(/may now be partly cleaned/);
    expect(msg).not.toMatch(NO_CHANGE);
  });

  it('final re-verification failure after the drops: state unverified, never "nothing changed"', async () => {
    const a = await attempt(afterRun(), { failSecondVerify: true });
    const e = await failure(a);
    expect(e.phase).toBe(PHASE.FINAL);
    expect(e.completed).toHaveLength(8);
    expect(e.cause).toBeInstanceOf(Stop);
    const msg = describeFailure(e);
    expect(msg).toMatch(/^ERROR: final re-verification failed after the cleanup statements ran/);
    expect(msg).toMatch(/The resulting state is unverified/);
    expect(msg).toMatch(/Partial cleanup recovery/);
    expect(msg).not.toMatch(NO_CHANGE);
    expect(msg).not.toMatch(/^STOP/);
  });

  it('a failure reading the final inventory is also the final-verification phase', async () => {
    const a = await attempt(afterRun(), { after: null }); // the final inventory cannot be read
    const e = await failure(a);
    expect(e.phase).toBe(PHASE.FINAL);
    expect(describeFailure(e)).not.toMatch(NO_CHANGE);
  });

  it('NOT CLEAN after the statements: returns not clean and points to the recovery steps', async () => {
    const logs = [];
    const leftover = { ...cleaned, crmRoles: ['crm_migrator'] };
    const a = await attempt(afterRun(), { after: leftover, logs });
    expect(await a.run).toBe('not clean');
    expect(logs.at(-1)).toMatch(
      /^NOT CLEAN: see above\. The branch may be partly cleaned\. .*Partial cleanup recovery/,
    );
  });

  it('scrubs the underlying error text in every phase', () => {
    const scrub = (s) => String(s).split('s3cret').join('***');
    for (const phase of Object.values(PHASE)) {
      const msg = describeFailure(
        new CleanupFailure(phase, [], new Error('password s3cret')),
        scrub,
      );
      expect(msg).not.toContain('s3cret');
      expect(msg).toContain('password ***');
    }
    expect(describeFailure(new Error('bad s3cret'), scrub)).toMatch(
      /^ERROR: cleanup aborted before it started; .*bad \*\*\*$/,
    );
  });
});
