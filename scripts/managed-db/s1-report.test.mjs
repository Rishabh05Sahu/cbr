import { mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, describe, expect, it } from 'vitest';
import {
  buildReport,
  runExitStatus,
  validateMemberships,
  validatePrivilegedReach,
  verdict,
} from './s1-report.mjs';

const ADMIN = 'neondb_owner';
const creator = (role, member = ADMIN) => ({
  role,
  member,
  admin_option: true,
  inherit_option: false,
  set_option: false,
});
const definer = {
  role: 'crm_definer',
  member: 'crm_migrator',
  admin_option: false,
  inherit_option: true,
  set_option: true,
};
const expected = [
  definer,
  ...['crm_app', 'crm_auth', 'crm_definer', 'crm_migrator', 'crm_platform'].map((r) => creator(r)),
];

describe('validateMemberships', () => {
  it('accepts exactly the bootstrap memberships', () => {
    expect(validateMemberships(expected, ADMIN)).toEqual([]);
  });

  it('rejects an ADMIN-only membership held by anyone but the recorded admin', () => {
    const rows = [...expected, creator('crm_auth', 'crm_app')];
    expect(validateMemberships(rows, ADMIN)).toEqual([
      'application role crm_app is a member of crm_auth',
    ]);
    const other = [...expected, creator('crm_auth', 'someone_else')];
    expect(validateMemberships(other, ADMIN)).toEqual([
      'unexpected membership: someone_else in crm_auth',
    ]);
  });

  it('rejects an application role being a member of a provider role (wrong direction)', () => {
    const rows = [...expected, { ...creator('neon_superuser', 'crm_platform') }];
    expect(validateMemberships(rows, ADMIN)).toEqual([
      'application role crm_platform is a member of neon_superuser',
    ]);
  });

  it('rejects wrong flags and missing rows', () => {
    const rows = expected.map((x) =>
      x.role === 'crm_app' && x.member === ADMIN ? { ...x, set_option: true } : x,
    );
    expect(validateMemberships(rows, ADMIN)[0]).toMatch(/neondb_owner in crm_app has/);
    expect(validateMemberships(expected.slice(1), ADMIN)).toEqual([
      'expected membership missing: crm_definer <- crm_migrator',
    ]);
  });

  it('fails closed without a recorded admin', () => {
    expect(validateMemberships(expected, undefined)).toHaveLength(1);
  });
});

describe('validatePrivilegedReach', () => {
  const privileged = [
    { rolname: 'cloud_admin' },
    { rolname: ADMIN },
    { rolname: 'neon_superuser' },
  ];

  it('passes when the admin is discovered and no crm_* role reaches a privileged role', () => {
    expect(validatePrivilegedReach(privileged, [], ADMIN)).toEqual([]);
  });

  it('fails on empty discovery, a missing admin, any reach, or an older run without the check', () => {
    expect(validatePrivilegedReach([], [], ADMIN)).toHaveLength(2);
    expect(validatePrivilegedReach(privileged, [], 'doadmin')).toHaveLength(1);
    expect(
      validatePrivilegedReach(privileged, [{ role: 'crm_app', privileged: ADMIN }], ADMIN),
    ).toEqual(['crm_app can assume privileged role neondb_owner']);
    expect(validatePrivilegedReach(undefined, undefined, ADMIN)).toEqual([
      'privileged-role check not recorded',
    ]);
  });
});

describe('verdict: bindingPass is the only S1 pass signal', () => {
  const totals = (o = {}) => ({ passed: 10, failed: 0, blocked: 0, notRun: 0, ...o });
  const passedChecks = [{ status: 'passed' }, { status: 'passed' }];
  const diagnostic = { txStartMaxWaitMs: 300_000, bindingTxStartMaxWaitMs: 30_000 };

  it('a diagnostic run where every test and check passed is not a binding pass', () => {
    expect(verdict({ totals: totals(), checkList: passedChecks, diagnostic })).toEqual({
      complete: true,
      allPassed: true,
      binding: false,
      bindingPass: false,
    });
  });

  it('a binding run where everything passed is a binding pass', () => {
    expect(verdict({ totals: totals(), checkList: passedChecks, diagnostic: null })).toEqual({
      complete: true,
      allPassed: true,
      binding: true,
      bindingPass: true,
    });
  });

  it('a binding run with a failed test or a failed check is not a pass', () => {
    expect(verdict({ totals: totals({ failed: 1 }), checkList: passedChecks }).bindingPass).toBe(
      false,
    );
    const failedCheck = [{ status: 'passed' }, { status: 'failed' }];
    expect(verdict({ totals: totals(), checkList: failedCheck }).bindingPass).toBe(false);
  });

  it('incomplete or blocked runs are never a pass', () => {
    for (const t of [totals({ notRun: 1 }), totals({ blocked: 1 })]) {
      const v = verdict({ totals: t, checkList: passedChecks });
      expect(v).toMatchObject({ complete: false, allPassed: false, bindingPass: false });
    }
    for (const status of ['not run', 'blocked']) {
      const v = verdict({ totals: totals(), checkList: [{ status: 'passed' }, { status }] });
      expect(v).toMatchObject({ complete: false, allPassed: false, bindingPass: false });
    }
  });
});

describe('buildReport: report.json and report.md carry the binding verdict', () => {
  const dirs = [];
  afterEach(() => {
    for (const d of dirs.splice(0)) rmSync(d, { recursive: true, force: true });
  });

  const ROLES = ['crm_app', 'crm_auth', 'crm_definer', 'crm_migrator', 'crm_platform'];
  const S1_08 = 'spikes/s1-tenant-isolation/tests/s1-08-concurrency.test.ts';

  /** A synthetic run directory in which one S1-08 batch and every check passed. */
  function runDir({
    diagnosticOverride = null,
    testState = 'passed',
    runEnded = true,
    diagnosticSettings = undefined,
  } = {}) {
    const dir = mkdtempSync(join(tmpdir(), 'cbr-s1-report-test-'));
    dirs.push(dir);
    const bootstrap = {
      status: 'done',
      output: [...ROLES.map((r) => `${r}|f|f|t`), 'f'],
    };
    const final = {
      status: 0,
      results: [
        [{ owner: 'crm_migrator', public_can_connect: false, public_can_temp: false }],
        ROLES.map((rolname) => ({ rolname })),
        expected,
        [{ without_forced_rls: 0, org_tables: 3 }],
        [{ mutation_policies_left: 0 }],
        [{ policies: 9, fingerprint: 'x' }],
        [{ rolname: ADMIN }, { rolname: 'neon_superuser' }],
        [],
      ],
    };
    const state = {
      label: diagnosticOverride ? 'neon-diagnostic' : 'neon',
      target: { branchId: 'br-test-branch-1' },
      adminRole: ADMIN,
      diagnosticOverride,
      invocations: [],
      steps: { bootstrap_crm_s1: bootstrap, bootstrap_crm_test: bootstrap },
      batches: {
        's1-08': {
          status: 'done',
          attempts: 1,
          exit: testState === 'passed' ? 0 : 1,
          ...(diagnosticSettings ? { diagnosticSettings } : {}),
        },
      },
      plan: [{ name: 's1-08', kind: 'tests', project: 's1', pooled: false, files: [S1_08] }],
      finalVerification: { crm_s1: final, crm_test: final },
    };
    writeFileSync(join(dir, 'state.json'), JSON.stringify(state));
    const ev = [
      { batch: 's1-08', attempt: 1, type: 'run-start' },
      { batch: 's1-08', attempt: 1, type: 'collected', id: 't1', name: 'S1-08 0 leaks' },
      ...(testState === 'interrupted'
        ? []
        : [{ batch: 's1-08', attempt: 1, type: 'result', id: 't1', state: testState }]),
      ...(runEnded ? [{ batch: 's1-08', attempt: 1, type: 'run-end' }] : []),
    ];
    writeFileSync(join(dir, 'tests.jsonl'), ev.map((e) => JSON.stringify(e)).join('\n'));
    return dir;
  }

  const diag = {
    binding: false,
    purpose: 'test',
    txStartMaxWaitMs: 300_000,
    bindingTxStartMaxWaitMs: 30_000,
    connectionTimeoutMs: 310_000,
    appliesTo: ['s1-08'],
    branchId: 'br-test-branch-1',
    endpointId: 'ep-test-endpoint-1',
    productionBranchIds: ['br-prod-branch-1'],
  };

  it('a binding run with everything passed: bindingPass true', () => {
    const r = buildReport(runDir());
    expect(r).toMatchObject({ complete: true, allPassed: true, binding: true, bindingPass: true });
  });

  it('the same run under the diagnostic override: allPassed true but bindingPass false, labelled', () => {
    const dir = runDir({ diagnosticOverride: diag });
    const r = buildReport(dir);
    expect(r).toMatchObject({
      complete: true,
      allPassed: true,
      binding: false,
      bindingPass: false,
    });
    const json = JSON.parse(readFileSync(join(dir, 'report.json'), 'utf8'));
    expect(json.bindingPass).toBe(false);
    expect(json.headline).toMatch(/^DIAGNOSTIC, NOT A BINDING S1 RESULT/);
    const md = readFileSync(join(dir, 'report.md'), 'utf8');
    expect(md).toContain('Binding S1 pass: **no** (diagnostic run: never binding)');
    expect(md).toContain('## Diagnostic override (non-binding)');
  });

  const applied = {
    kind: 'diagnostic configuration (non-binding), not a test outcome',
    txStartMaxWaitMs: 300_000,
    connectionTimeoutMs: 310_000,
  };

  it('a diagnostic run records the configured and effective settings apart from outcomes', () => {
    const dir = runDir({ diagnosticOverride: diag, diagnosticSettings: applied });
    expect(buildReport(dir).bindingPass).toBe(false);
    const json = JSON.parse(readFileSync(join(dir, 'report.json'), 'utf8'));
    expect(json.diagnosticSettings).toEqual({
      kind: 'diagnostic configuration (non-binding), not test outcomes',
      configured: {
        txStartMaxWaitMs: 300_000,
        bindingTxStartMaxWaitMs: 30_000,
        connectionTimeoutMs: 310_000,
        appliesTo: ['s1-08'],
      },
      effectivePerBatch: { 's1-08': applied },
    });
    const md = readFileSync(join(dir, 'report.md'), 'utf8');
    expect(md).toContain('### Diagnostic settings (configuration, not test outcomes)');
    expect(md).toContain('`S1_CONNECTION_TIMEOUT_MS`) 310000 ms');
    expect(md).toContain('| s1-08 | 300000 | 310000 |');
  });

  it('a diagnostic batch that never received its settings is shown as not applied', () => {
    const dir = runDir({ diagnosticOverride: diag, testState: 'interrupted', runEnded: false });
    const r = buildReport(dir);
    expect(r).toMatchObject({ complete: false, bindingPass: false });
    expect(r.diagnosticSettings.effectivePerBatch['s1-08']).toMatch(/not applied/);
  });

  it('a binding run has no diagnostic settings', () => {
    expect(buildReport(runDir()).diagnosticSettings).toBeNull();
  });

  it('a binding run with a failed test: not a pass', () => {
    const r = buildReport(runDir({ testState: 'failed' }));
    expect(r).toMatchObject({ allPassed: false, bindingPass: false });
    expect(r.totals.failed).toBe(1);
  });

  it('an interrupted test is not run, and the run is incomplete, not a pass', () => {
    const r = buildReport(runDir({ testState: 'interrupted', runEnded: false }));
    expect(r.totals.notRun).toBe(1);
    expect(r).toMatchObject({ complete: false, allPassed: false, bindingPass: false });
  });

  // --- process exit status (s1-managed-run.mjs sets process.exitCode from it) ---
  const statusOf = (dir, change = (st) => st) => {
    const report = buildReport(dir);
    const state = change(JSON.parse(readFileSync(join(dir, 'state.json'), 'utf8')));
    return { report, ...runExitStatus(state, report) };
  };

  it('exit 0 when every selected batch passed (report still the authority)', () => {
    const r = statusOf(runDir());
    expect(r).toMatchObject({ code: 0, problems: [] });
    expect(r.report.bindingPass).toBe(true);
  });

  it('exit 1 when a selected batch has a failed test, and the report is still written', () => {
    const dir = runDir({ testState: 'failed' });
    const r = statusOf(dir);
    expect(r.code).toBe(1);
    expect(r.problems).toContain('s1-08: test process exited 1');
    expect(r.problems).toContain('s1-08: 1 of 1 tests not passed (failed)');
    expect(readFileSync(join(dir, 'report.md'), 'utf8')).toMatch(/0 passed, 1 failed/);
    expect(JSON.parse(readFileSync(join(dir, 'report.json'), 'utf8')).totals.failed).toBe(1);
  });

  it('exit 1 when the test process failed although every recorded test passed', () => {
    const r = statusOf(runDir(), (st) => {
      st.batches['s1-08'].exit = 2;
      return st;
    });
    expect(r).toMatchObject({ code: 1, problems: ['s1-08: test process exited 2'] });
  });

  it('exit 1 when the child died without a status (signal) or never reported', () => {
    for (const exit of [null, undefined]) {
      const r = statusOf(runDir(), (st) => {
        st.batches['s1-08'].exit = exit;
        return st;
      });
      expect(r.code).toBe(1);
    }
  });

  it('exit 1 for an interrupted batch (tests not run) and for one still marked running', () => {
    expect(statusOf(runDir({ testState: 'interrupted', runEnded: false })).problems).toContain(
      's1-08: 1 of 1 tests not passed (not run)',
    );
    const running = statusOf(runDir(), (st) => {
      st.batches['s1-08'] = { status: 'running', attempts: 1 };
      return st;
    });
    expect(running).toMatchObject({ code: 1, problems: ['s1-08: running'] });
  });

  it('exit 1 for a selected batch that was blocked or never started', () => {
    const blocked = statusOf(runDir(), (st) => {
      st.batches['s1-08'] = { status: 'blocked', reason: 'prerequisite not done: migrateS1' };
      return st;
    });
    expect(blocked.problems).toEqual(['s1-08: blocked (prerequisite not done: migrateS1)']);
    const missing = statusOf(runDir(), (st) => {
      delete st.batches['s1-08'];
      return st;
    });
    expect(missing.problems).toEqual(['s1-08: not started']);
  });

  it('unselected batches do not fail the run; selected ones are judged across invocations', () => {
    const r = statusOf(runDir(), (st) => {
      st.plan.push({ name: 'db-roles', kind: 'tests', project: 'integration', files: [] });
      st.batches['db-roles'] = { status: 'not selected' };
      st.invocations = [{ mode: 'fresh', selected: ['s1-08'] }];
      return st;
    });
    expect(r.code).toBe(0);
    // Selected in an earlier invocation and not finished: still a failure on resume.
    const resumed = statusOf(runDir(), (st) => {
      st.plan.push({ name: 'db-roles', kind: 'tests', project: 'integration', files: [] });
      st.batches['db-roles'] = { status: 'running', attempts: 1 };
      st.invocations = [
        { mode: 'fresh', selected: ['s1-08', 'db-roles'] },
        { mode: 'resume', selected: ['s1-08'] },
      ];
      return st;
    });
    expect(resumed.problems).toEqual(['db-roles: running']);
  });

  it('no recorded invocation: every planned batch is judged (fail closed)', () => {
    const r = statusOf(runDir(), (st) => {
      st.plan.push({ name: 'db-roles', kind: 'tests', project: 'integration', files: [] });
      st.invocations = [];
      return st;
    });
    expect(r.problems).toEqual(['db-roles: not started']);
  });

  it('exit 1 for a failed check batch, a failed setup step or a failed final verification', () => {
    const check = statusOf(runDir(), (st) => {
      st.plan.push({ name: 'mutation', kind: 'check', files: [] });
      st.batches.mutation = { status: 'done', ok: false };
      return st;
    });
    expect(check.problems).toEqual(['mutation: check failed']);
    const step = statusOf(runDir(), (st) => {
      st.steps.migrateS1 = { status: 'failed' };
      return st;
    });
    expect(step.problems).toEqual(['setup step migrateS1: failed']);
    const dir = runDir();
    const state = JSON.parse(readFileSync(join(dir, 'state.json'), 'utf8'));
    delete state.finalVerification;
    writeFileSync(join(dir, 'state.json'), JSON.stringify(state));
    expect(statusOf(dir).problems).toEqual([
      'check final verification crm_s1: not run',
      'check final verification crm_test: not run',
    ]);
  });

  it('a diagnostic run whose selected batches passed exits 0 but is never a binding pass', () => {
    const r = statusOf(runDir({ diagnosticOverride: diag }));
    expect(r.code).toBe(0);
    expect(r.report).toMatchObject({ allPassed: true, bindingPass: false, binding: false });
  });
});
