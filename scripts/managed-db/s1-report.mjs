// Builds report.json + report.md for a managed S1 run directory from its checkpoints only
// (state.json, tests.jsonl, plan-*.json), so it also works after an interruption.
//
//   node scripts/managed-db/s1-report.mjs [run directory]   (default: the newest run)
//
// Every test gets exactly one status:
//   passed   finished and passed
//   failed   finished and failed
//   blocked  could not run because something it depends on failed (setup step, a failed
//            beforeAll, or a batch whose test file could not even load)
//   not run  never finished: interrupted, not selected, or not reached yet
// A test without a recorded result is never counted as passed.
import { existsSync, readdirSync, readFileSync, statSync, writeFileSync } from 'node:fs';
import { basename, join } from 'node:path';
import { pathToFileURL } from 'node:url';

function readJsonl(path) {
  if (!existsSync(path)) return [];
  return readFileSync(path, 'utf8')
    .split('\n')
    .flatMap((l) => {
      try {
        return l ? [JSON.parse(l)] : [];
      } catch {
        return []; // a line cut off by the interruption
      }
    });
}

function plannedTests(dir, batch) {
  const file = batch.project === 'integration' ? 'plan-db-roles.json' : 'plan-s1.json';
  const path = join(dir, file);
  if (!existsSync(path)) return [];
  const want = new Set(batch.files.map((f) => basename(f)));
  return JSON.parse(readFileSync(path, 'utf8'))
    .filter((t) => want.has(basename(t.file)))
    .map((t) => ({ name: t.name, fromStaticListing: true }));
}

/** Per-test statuses for one vitest batch name at its latest attempt. */
function batchTests(dir, events, batch, name, info) {
  const attempt = info?.attempts ?? 0;
  const ev = events.filter((e) => e.batch === name && e.attempt === attempt);
  const collected = new Map();
  for (const e of ev) if (e.type === 'collected') collected.set(e.id, e.name);
  const results = new Map();
  for (const e of ev) if (e.type === 'result') results.set(e.id, e);
  const moduleErrors = ev.filter((e) => e.type === 'module-end').flatMap((e) => e.errors);
  const runEnded = ev.some((e) => e.type === 'run-end');
  const interrupted = info?.status === 'running' || (attempt > 0 && !runEnded);

  if (collected.size === 0) {
    // Nothing collected: the batch never started, was blocked, or its file failed to load.
    const status =
      info?.status === 'blocked' || (info?.status === 'done' && info.exit !== 0)
        ? 'blocked'
        : 'not run';
    const why =
      info?.status === 'blocked'
        ? info.reason
        : info?.status === 'done'
          ? `test file did not load (exit ${info.exit}) ${moduleErrors.join(' | ')}`.trim()
          : (info?.status ?? 'not started');
    return plannedTests(dir, batch).map((t) => ({ ...t, status, why }));
  }
  return [...collected].map(([id, testName]) => {
    const r = results.get(id);
    if (!r)
      return { name: testName, status: 'not run', why: interrupted ? 'interrupted' : 'no result' };
    if (r.state === 'passed') return { name: testName, status: 'passed', ms: r.durationMs };
    if (r.state === 'failed')
      return { name: testName, status: 'failed', ms: r.durationMs, errors: r.errors };
    return moduleErrors.length
      ? { name: testName, status: 'blocked', why: moduleErrors.join(' | ') }
      : { name: testName, status: 'not run', why: `skipped (${r.state})` };
  });
}

const parseRows = (output) => (output ?? []).map((l) => l.split('|'));

const CRM_ROLES = ['crm_app', 'crm_auth', 'crm_definer', 'crm_migrator', 'crm_platform'];
const APP_ROLES = ['crm_app', 'crm_auth', 'crm_platform'];

/**
 * The exact memberships the bootstrap leaves (scripts/db/bootstrap-managed-roles.sql), as
 * "granted role <- member": crm_definer <- crm_migrator (INHERIT, SET; no ADMIN), and, because
 * a non-superuser CREATEROLE admin creates the roles (PostgreSQL 16+), each crm_* role <- that
 * admin with ADMIN OPTION only (no INHERIT, no SET). Anything else is a problem, including a
 * crm_* role being a member of any other role.
 */
export function validateMemberships(memberships, adminRole) {
  const problems = [];
  if (!adminRole) return ['admin role not recorded: creator memberships cannot be attributed'];
  const key = (x) => `${x.role}<-${x.member}`;
  const expected = new Map([
    ['crm_definer<-crm_migrator', { admin_option: false, inherit_option: true, set_option: true }],
    ...CRM_ROLES.map((r) => [
      `${r}<-${adminRole}`,
      { admin_option: true, inherit_option: false, set_option: false },
    ]),
  ]);
  const seen = new Set();
  for (const x of memberships) {
    const k = key(x);
    const want = expected.get(k);
    if (APP_ROLES.includes(x.member))
      problems.push(`application role ${x.member} is a member of ${x.role}`);
    else if (!want) problems.push(`unexpected membership: ${x.member} in ${x.role}`);
    else if (seen.has(k)) problems.push(`duplicate membership: ${x.member} in ${x.role}`);
    else if (Object.entries(want).some(([f, v]) => x[f] !== v))
      problems.push(
        `membership ${x.member} in ${x.role} has admin/inherit/set ` +
          `${x.admin_option}/${x.inherit_option}/${x.set_option}, expected ` +
          `${want.admin_option}/${want.inherit_option}/${want.set_option}`,
      );
    seen.add(k);
  }
  for (const k of expected.keys())
    if (!seen.has(k)) problems.push(`expected membership missing: ${k.replace('<-', ' <- ')}`);
  return problems;
}

/** Privileged roles present must include the admin; no crm_* role may reach any of them. */
export function validatePrivilegedReach(privileged, reach, adminRole) {
  if (!privileged || !reach) return ['privileged-role check not recorded'];
  const problems = [];
  const names = privileged.map((r) => r.rolname);
  if (names.length === 0) problems.push('privileged-role discovery returned nothing');
  if (!names.includes(adminRole))
    problems.push(`privileged-role discovery does not include the admin ${adminRole}`);
  for (const x of reach) problems.push(`${x.role} can assume privileged role ${x.privileged}`);
  return problems;
}

function checks(state) {
  const out = [];
  // Bootstrap: every crm_* role row is "name|rolsuper|rolbypassrls|rolcanlogin"; PUBLIC CONNECT off.
  for (const db of ['crm_s1', 'crm_test']) {
    const s = state.steps[`bootstrap_${db}`];
    if (!s) {
      out.push({ name: `bootstrap ${db}`, status: 'not run' });
      continue;
    }
    const rows = parseRows(s.output);
    const roles = rows.filter((r) => r[0]?.startsWith('crm_') && r.length === 4);
    const publicConnect = rows.find((r) => r.length === 1 && (r[0] === 't' || r[0] === 'f'));
    const ok =
      s.status === 'done' &&
      roles.length === 5 &&
      roles.every((r) => r[1] === 'f' && r[2] === 'f') &&
      publicConnect?.[0] === 'f';
    out.push({
      name: `bootstrap ${db}: 5 roles, no superuser/BYPASSRLS, PUBLIC cannot connect`,
      status: s.status !== 'done' ? 'failed' : ok ? 'passed' : 'failed',
    });
  }
  const m = state.batches.mutation;
  if (m)
    out.push({
      name: 'negative control: permissive policy detected, removed, policies identical, S1-03…07 pass again',
      status:
        m.status === 'done'
          ? m.ok
            ? 'passed'
            : 'failed'
          : m.status === 'blocked'
            ? 'blocked'
            : 'not run',
      detail:
        m.status === 'done'
          ? {
              detected: m.detected,
              failedUnderMutation: m.mutated?.failed,
              restored: m.restored,
              reverified: m.reverified,
            }
          : m.status === 'running'
            ? 'interrupted; the next invocation removes any leftover policy first'
            : m.status,
    });
  const fv = state.finalVerification;
  for (const db of ['crm_s1', 'crm_test']) {
    const r = fv?.[db];
    if (!r || r.status !== 0 || !r.results) {
      out.push({ name: `final verification ${db}`, status: r ? 'failed' : 'not run' });
      continue;
    }
    const [[dbRow], roles, memberships, [rls], [mut], [fp], privileged, reach] = r.results;
    const adminRole = state.adminRole ?? state.target?.adminRole;
    const problems = [];
    if (dbRow.owner !== 'crm_migrator') problems.push(`owner ${dbRow.owner}`);
    if (dbRow.public_can_connect || dbRow.public_can_temp) problems.push('PUBLIC can connect/temp');
    if (roles.length !== 5) problems.push(`${roles.length} crm_* roles`);
    for (const x of roles)
      if (x.rolsuper || x.rolbypassrls || x.rolcreaterole || x.rolcreatedb || x.rolreplication)
        problems.push(`${x.rolname} has elevated attributes`);
    problems.push(...validateMemberships(memberships, adminRole));
    // Runs made before this check existed record nothing here: reported as a problem, not passed.
    problems.push(...validatePrivilegedReach(privileged, reach, adminRole));
    if (rls.without_forced_rls !== 0)
      problems.push(`${rls.without_forced_rls} org tables without forced RLS`);
    if (mut.mutation_policies_left !== 0) problems.push('mutation policy left');
    if (db === 'crm_s1' && m?.before?.fingerprint && fp.fingerprint !== m.before.fingerprint)
      problems.push('policy set differs from before the mutation check');
    out.push({
      name: `final verification ${db}: roles, exact memberships, no app role reaches a privileged role, forced RLS, no leftover mutation`,
      status: problems.length ? 'failed' : 'passed',
      detail: {
        problems,
        adminRole,
        orgTables: rls.org_tables,
        policies: fp.policies,
        memberships,
        privilegedRoles: privileged?.map((x) => x.rolname) ?? null,
      },
    });
  }
  return out;
}

/**
 * The run's verdict. `allPassed` means every test and check of this run passed; `bindingPass`
 * is the only field that means "S1 passed": it also requires a binding run (no diagnostic
 * override). A diagnostic run is never a binding pass, whatever its outcome.
 */
export function verdict({ totals, checkList, diagnostic }) {
  const complete =
    totals.notRun === 0 &&
    totals.blocked === 0 &&
    checkList.every((c) => c.status !== 'not run' && c.status !== 'blocked');
  const allPassed =
    complete && totals.failed === 0 && checkList.every((c) => c.status === 'passed');
  const binding = !diagnostic;
  return { complete, allPassed, binding, bindingPass: binding && allPassed };
}

/**
 * The runner's process exit status (s1-managed-run.mjs; neon-s1.mjs passes it on). 0 only when
 * every batch selected in any invocation finished, its test process exited 0 and all its tests
 * passed (a check batch: ok), every setup step is done, and the bootstrap and final-verification
 * checks passed. Unselected batches do not count. The exit status says nothing about S1
 * acceptance: that is `bindingPass` in report.json, never true for a diagnostic or partial run.
 */
export function runExitStatus(state, report) {
  const problems = [];
  // No recorded invocation: judge everything (fail closed).
  const selections = state.invocations?.length
    ? state.invocations.map((i) => i.selected ?? 'all')
    : ['all'];
  const isSelected = (name) => selections.some((s) => s === 'all' || s.includes(name));
  for (const [name, s] of Object.entries(state.steps ?? {}))
    if (s.status !== 'done') problems.push(`setup step ${name}: ${s.status}`);
  const testsByBatch = new Map((report.batches ?? []).map((b) => [b.name, b.tests]));
  for (const p of state.plan ?? []) {
    if (!isSelected(p.name)) continue;
    const info = state.batches?.[p.name];
    if (info?.status !== 'done') {
      problems.push(
        `${p.name}: ${info?.status ?? 'not started'}${info?.reason ? ` (${info.reason})` : ''}`,
      );
      continue;
    }
    if (p.kind === 'check') {
      if (info.ok !== true) problems.push(`${p.name}: check failed`);
      continue;
    }
    if (info.exit !== 0) problems.push(`${p.name}: test process exited ${info.exit}`);
    const tests = testsByBatch.get(p.name) ?? [];
    if (tests.length === 0) problems.push(`${p.name}: no test results`);
    const notPassed = tests.filter((t) => t.status !== 'passed');
    if (notPassed.length)
      problems.push(
        `${p.name}: ${notPassed.length} of ${tests.length} tests not passed (${[...new Set(notPassed.map((t) => t.status))].join(', ')})`,
      );
  }
  for (const c of report.checks ?? [])
    if (/^(bootstrap|final verification)/.test(c.name) && c.status !== 'passed')
      problems.push(`check ${c.name.split(':')[0]}: ${c.status}`);
  return { code: problems.length ? 1 : 0, problems };
}

export function buildReport(dir) {
  const state = JSON.parse(readFileSync(join(dir, 'state.json'), 'utf8'));
  const events = readJsonl(join(dir, 'tests.jsonl'));
  const batches = [];
  for (const b of state.plan.filter((p) => p.kind === 'tests')) {
    const info = state.batches[b.name];
    const tests = batchTests(dir, events, b, b.name, info);
    batches.push({
      name: b.name,
      pooled: b.pooled,
      batchStatus: info?.status ?? 'not started',
      tests,
    });
  }
  // The mutation check's own test runs are reported inside the check, not in the totals.
  const timing = state.batches['server-timing'];
  const all = batches.flatMap((b) => b.tests);
  const count = (s) => all.filter((t) => t.status === s).length;
  const totals = {
    passed: count('passed'),
    failed: count('failed'),
    blocked: count('blocked'),
    notRun: count('not run'),
  };
  const checkList = checks(state);
  const s117 = batches
    .find((b) => b.name === 's1-17')
    ?.tests.filter((t) => /p95 <= 500 ms/.test(t.name));
  // A diagnostic-override run is never a binding S1 result, whatever its outcome.
  const diag = state.diagnosticOverride ?? null;
  // Configuration, not outcomes: what each S1-08 batch was given (recorded before it started).
  const diagnosticSettings = diag
    ? {
        kind: 'diagnostic configuration (non-binding), not test outcomes',
        configured: {
          txStartMaxWaitMs: diag.txStartMaxWaitMs,
          bindingTxStartMaxWaitMs: diag.bindingTxStartMaxWaitMs,
          connectionTimeoutMs: diag.connectionTimeoutMs ?? 'not recorded',
          appliesTo: diag.appliesTo,
        },
        effectivePerBatch: Object.fromEntries(
          diag.appliesTo.map((name) => [
            name,
            state.batches[name]?.diagnosticSettings ?? 'not applied (batch did not start)',
          ]),
        ),
      }
    : null;
  const { complete, allPassed, binding, bindingPass } = verdict({
    totals,
    checkList,
    diagnostic: diag,
  });
  const headline =
    (diag
      ? `DIAGNOSTIC, NOT A BINDING S1 RESULT (S1-08 transaction-start maxWait ${diag.txStartMaxWaitMs} ms ` +
        `instead of the binding ${diag.bindingTxStartMaxWaitMs} ms). `
      : '') +
    `S1 managed run ${state.label} (${state.target?.branchId ?? state.host}): ` +
    `${totals.passed} passed, ${totals.failed} failed, ${totals.blocked} blocked, ${totals.notRun} not run; ` +
    `checks ${checkList.filter((c) => c.status === 'passed').length}/${checkList.length} passed; ` +
    (complete ? (allPassed ? 'COMPLETE, ALL PASSED' : 'COMPLETE, NOT ALL PASSED') : 'INCOMPLETE');
  const report = {
    generatedAt: new Date().toISOString(),
    dir,
    target: state.target,
    invocations: state.invocations,
    steps: Object.fromEntries(
      Object.entries(state.steps).map(([k, v]) => [
        k,
        { status: v.status, at: v.endedAt ?? v.startedAt },
      ]),
    ),
    totals,
    complete,
    allPassed,
    binding,
    // Automated readers: this, not allPassed, is the S1 verdict.
    bindingPass,
    diagnosticOverride: diag
      ? { ...diag, serverCheck: state.diagnosticServerCheck ?? 'not run' }
      : null,
    diagnosticSettings,
    headline,
    s1_17_threshold: { limitMs: 500, results: s117 ?? [] },
    serverSideTiming:
      timing?.status === 'done'
        ? { rls: timing.rls, baseline: timing.baseline }
        : (timing?.status ?? null),
    checks: checkList,
    batches,
  };
  writeFileSync(join(dir, 'report.json'), `${JSON.stringify(report, null, 2)}\n`);

  const md = [
    `# S1 managed run: ${state.label}`,
    '',
    `Generated ${report.generatedAt} from checkpoints in \`${dir}\`.`,
    '',
    `**${headline}**`,
    '',
    `Binding S1 pass: **${bindingPass ? 'yes' : 'no'}**${diag ? ' (diagnostic run: never binding)' : ''}`,
    '',
    ...(diag
      ? [
          '## Diagnostic override (non-binding)',
          '',
          `- Purpose: ${diag.purpose}.`,
          `- S1-08 transaction-start budget (Prisma \`maxWait\`): **${diag.txStartMaxWaitMs} ms**; the binding value is ${diag.bindingTxStartMaxWaitMs} ms. Transaction \`timeout\`, workload (50 × 1,000 over a pool of 5) and every assertion are unchanged.`,
          `- Applied to: ${diag.appliesTo.join(', ')}. Other batches use the binding value.`,
          '',
          '### Diagnostic settings (configuration, not test outcomes)',
          '',
          `Configured: transaction-start \`maxWait\` ${diag.txStartMaxWaitMs} ms (binding ${diag.bindingTxStartMaxWaitMs} ms); spike pool connection / pool-wait timeout (\`S1_CONNECTION_TIMEOUT_MS\`) ${diag.connectionTimeoutMs ?? 'not recorded'} ms. The test outcomes are in the batch table below.`,
          '',
          '| Batch | Effective maxWait (ms) | Effective connection timeout (ms) |',
          '|---|---|---|',
          ...diag.appliesTo.map((name) => {
            const e = state.batches[name]?.diagnosticSettings;
            return e
              ? `| ${name} | ${e.txStartMaxWaitMs} | ${e.connectionTimeoutMs} |`
              : `| ${name} | not applied (batch did not start) | not applied (batch did not start) |`;
          }),
          '',
          `- Target: Neon branch ${diag.branchId}, endpoint ${diag.endpointId} (production branches excluded: ${diag.productionBranchIds.join(', ')}).`,
          `- Server check before S1-08 (admin, direct and pooled): \`${JSON.stringify(state.diagnosticServerCheck ?? 'not run')}\``,
          '- A pass here is **not** an S1-08 pass. S1-08 still needs the binding 30 s run in the same region.',
          '',
        ]
      : []),
    `Target: ${state.target ? `${state.target.provider} project ${state.target.projectId}, branch ${state.target.branchName} (${state.target.branchId}), endpoint ${state.target.endpointId}, ${state.target.region}, PostgreSQL ${state.target.serverVersion}` : state.host}`,
    '',
    '| Invocation | Mode | Started | Ended | Round trip (ms) |',
    '|---|---|---|---|---|',
    ...state.invocations.map(
      (i, n) =>
        `| ${n + 1} | ${i.mode} | ${i.startedAt} | ${i.endedAt ?? (i.interruptedAt ? `interrupted ${i.interruptedAt}` : 'did not finish')} | ${i.roundTripMs ?? ''} |`,
    ),
    '',
    '## Batches',
    '',
    '| Batch | Batch status | Passed | Failed | Blocked | Not run |',
    '|---|---|---|---|---|---|',
    ...batches.map((b) => {
      const c = (s) => b.tests.filter((t) => t.status === s).length;
      return `| ${b.name}${b.pooled ? ' (pooled)' : ''} | ${b.batchStatus} | ${c('passed')} | ${c('failed')} | ${c('blocked')} | ${c('not run')} |`;
    }),
    '',
    '## Checks',
    '',
    ...checkList.map(
      (c) => `- **${c.status}**: ${c.name}${c.detail ? ` — \`${JSON.stringify(c.detail)}\`` : ''}`,
    ),
    '',
    '## S1-17 (limit 500 ms p95, measured from the test machine, unchanged)',
    '',
    ...(s117?.length
      ? s117.map(
          (t) =>
            `- **${t.status}**: ${t.name}${t.errors?.length ? ` — ${t.errors[0].split('\n')[0]}` : ''}`,
        )
      : ['- not run']),
    '',
    `Server-side timings (supplementary, not a substitute): \`${JSON.stringify(report.serverSideTiming)}\``,
    '',
    '## Tests not passed',
    '',
    ...(all.some((t) => t.status !== 'passed')
      ? batches.flatMap((b) =>
          b.tests
            .filter((t) => t.status !== 'passed')
            .map(
              (t) =>
                `- ${b.name}: **${t.status}** ${t.name}${t.why ? ` (${t.why})` : ''}${t.errors?.length ? ` — ${t.errors[0].split('\n')[0]}` : ''}${t.fromStaticListing ? ' [static listing]' : ''}`,
            ),
        )
      : ['- none']),
    '',
  ].join('\n');
  writeFileSync(join(dir, 'report.md'), md);
  return report;
}

if (import.meta.url === pathToFileURL(process.argv[1] ?? '').href) {
  let dir = process.argv[2];
  if (!dir) {
    const base = 'spikes/results/managed-runs';
    dir = readdirSync(base)
      .map((d) => join(base, d))
      .filter((d) => existsSync(join(d, 'state.json')))
      .sort((a, b) => statSync(b).mtimeMs - statSync(a).mtimeMs)[0];
    if (!dir) throw new Error(`no run directory under ${base}`);
  }
  const r = buildReport(dir);
  console.log(r.headline);
  console.log(`report: ${join(dir, 'report.md')}`);
}
