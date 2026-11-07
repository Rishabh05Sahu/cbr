// M6: per-stage profile of the import commit on the ISOLATED crm_perf database. Sets
// log_min_duration_statement = 0 on crm_perf ONLY (ALTER DATABASE, reset afterwards), runs one
// import sample (scripts/perf/import-run.mts sample mode) with the given strategy, then reads the
// server log for that window and attributes every statement's server time (parse + bind +
// execute) to a stage of docs/PHASE-2-M6-SET-BASED-IMPORT.md §3. Client wall time per batch comes
// from the sample itself. Prints no credentials.
//
//   node scripts/perf/stage-profile.mjs <accounts.json> <results.json> <row|set> [offset]
import { spawnSync } from 'node:child_process';
import { readFileSync, writeFileSync } from 'node:fs';
import 'dotenv/config';
import pg from 'pg';

/** The crm_perf URL of a role, from its local crm_test URL (same check as perf-db.mjs). */
function perfUrl(testVar) {
  const u = new URL(process.env[testVar]);
  if (u.hostname !== '127.0.0.1' || u.port !== '55432' || u.pathname !== '/crm_test')
    throw new Error(`${testVar} is not the local crm_test URL`);
  u.pathname = '/crm_perf';
  return u.toString();
}

const [accounts, out, strategy = 'set', offset = '0'] = process.argv.slice(2);
if (!accounts || !out || !['row', 'set'].includes(strategy))
  throw new Error('usage: stage-profile.mjs <accounts.json> <results.json> <row|set> [offset]');
const C = 'cbr-crm-postgres-1';

const mig = new pg.Client({ connectionString: perfUrl('TEST_MIGRATOR_URL') });
await mig.connect();
const who = (await mig.query('SELECT current_database() d, current_user u')).rows[0];
if (who.d !== 'crm_perf' || who.u !== 'crm_migrator') throw new Error('refusing: not crm_perf');
await mig.end();
const psql = (sql) =>
  spawnSync('docker', ['exec', C, 'psql', '-U', 'postgres', '-d', 'crm_perf', '-qtAc', sql], {
    encoding: 'utf8',
    env: { ...process.env, MSYS_NO_PATHCONV: '1' },
  });

const since = new Date(Date.now() - 1000).toISOString();
psql('ALTER DATABASE crm_perf SET log_min_duration_statement = 0');
let run;
try {
  run = spawnSync(
    'pnpm',
    [
      'exec',
      'tsx',
      'scripts/perf/import-run.mts',
      accounts,
      `${out}.sample.json`,
      'sample',
      '1000',
      `profile ${strategy}`,
    ],
    {
      shell: true,
      encoding: 'utf8',
      env: { ...process.env, PERF_COMMIT_STRATEGY: strategy, PERF_SAMPLE_OFFSET: offset },
    },
  );
} finally {
  psql('ALTER DATABASE crm_perf RESET log_min_duration_statement');
}
if (run.status !== 0) throw new Error(`sample failed (${run.status}): ${run.stderr.slice(-500)}`);
const sample = JSON.parse(readFileSync(`${out}.sample.json`, 'utf8'));

const log = spawnSync('docker', ['logs', '--since', since, C], {
  encoding: 'utf8',
  maxBuffer: 1 << 30,
});
const text = `${log.stdout}\n${log.stderr}`;
const STAGES = [
  ['job lock / progress', /import_job/],
  ['row results', /import_row_result/],
  ['locks (phones, e-mails)', /pg_advisory_xact_lock/],
  ['done check', /FROM lead_enquiry|"lead_enquiry"\."external_id"|external_id" = /],
  [
    'open match',
    /alternate_phone_e164 = p\.phone|alternate_phone_e164 = ANY|"alternate_phone_e164" IN/,
  ],
  [
    'returning lookup',
    /DISTINCT ON \(primary_phone_e164\)|stage" IN \(CAST|stage IN \('WON', 'LOST'\)/,
  ],
  ['custom fields', /custom_field_definition/],
  ['insert leads', /INSERT INTO lead \(|INSERT INTO "public"\."lead" \(/],
  ['e-mail candidates', /email_normalized = lower/],
  ['e-mail cases', /lead_duplicate_match/],
  ['insert enquiries', /INSERT INTO (lead_enquiry|"public"\."lead_enquiry")/],
  ['stage history', /lead_stage_history/],
  ['assignment spells', /lead_assignment_history/],
  ['notes', /lead_note/],
  ['activities', /lead_activity/],
  ['outbox', /outbox_event/],
  ['sources / assigner', /lead_source|team_assignment_state|team_membership|"member"/],
  ['transaction / context', /^(BEGIN|COMMIT|ROLLBACK|SELECT set_config|SET )/i],
];
const stages = Object.fromEntries(STAGES.map(([k]) => [k, { ms: 0, statements: 0 }]));
stages.other = { ms: 0, statements: 0 };
let total = 0;
// One entry per log record: a record starts with the log_line_prefix timestamp ("%m [%p] ");
// continuation lines (multi-line SQL) belong to the record before them.
const records = text.split(/\n(?=\d{4}-\d{2}-\d{2} \d{2}:\d{2}:\d{2})/);
const unclassified = new Map();
for (const rec of records) {
  const m = /duration: ([\d.]+) ms\s+(parse|bind|execute|statement)[^:]*:\s*([\s\S]*)/.exec(rec);
  if (!m) continue;
  const ms = Number(m[1]);
  const sql = m[3].replace(/\s+/g, ' ').trim();
  const [k] = STAGES.find(([, re]) => re.test(sql)) ?? ['other'];
  stages[k].ms += ms;
  if (m[2] === 'execute' || m[2] === 'statement') stages[k].statements += 1;
  if (k === 'other')
    unclassified.set(sql.slice(0, 90), (unclassified.get(sql.slice(0, 90)) ?? 0) + 1);
  total += ms;
}
const run0 = sample.runs[0];
const batches = Math.ceil(run0.counts.valid / 200);
const perBatch = Object.fromEntries(
  Object.entries(stages)
    .filter(([, v]) => v.statements || v.ms)
    .map(([k, v]) => [
      k,
      {
        serverMsPerBatch: +(v.ms / batches).toFixed(2),
        statementsPerBatch: +(v.statements / batches).toFixed(1),
      },
    ]),
);
const result = {
  generatedAt: new Date().toISOString(),
  strategy,
  rows: run0.counts.valid,
  batches,
  importSeconds: run0.seconds.import,
  rowsPerSecond: run0.importRowsPerSec,
  clientMsPerBatch: +((run0.seconds.import * 1000) / batches).toFixed(1),
  serverMsPerBatch: +(total / batches).toFixed(1),
  statementsPerBatch: +(
    Object.values(stages).reduce((a, v) => a + v.statements, 0) / batches
  ).toFixed(1),
  perBatch,
  unclassified: Object.fromEntries([...unclassified].sort((x, y) => y[1] - x[1]).slice(0, 15)),
  counts: run0.counts,
  resources: sample.resources,
};
writeFileSync(out, JSON.stringify(result, null, 2));
console.log(JSON.stringify(result, null, 2));
