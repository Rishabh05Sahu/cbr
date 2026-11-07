// M6: reconciles an import-run.mts "full" result with pilot/synthetic-corpus/manifest.json and
// with the ISOLATED crm_perf database (read-only, as crm_migrator): per file, the job counters
// against the manifest's expectations; per job, one enquiry per created or attached row with
// distinct external ids; no duplicate open-lead phones; leads created = enquiries that are
// first enquiries. Prints a table and exits 1 on any mismatch.
//
//   node scripts/perf/reconcile-corpus.mjs <import-run results.json>
import { readFileSync } from 'node:fs';
import 'dotenv/config';
import pg from 'pg';

const run = JSON.parse(readFileSync(process.argv[2], 'utf8'));
const manifest = JSON.parse(readFileSync('pilot/synthetic-corpus/manifest.json', 'utf8'));
const u = new URL(process.env.TEST_MIGRATOR_URL);
if (u.hostname !== '127.0.0.1' || u.port !== '55432' || u.pathname !== '/crm_test')
  throw new Error('TEST_MIGRATOR_URL is not the local crm_test URL');
u.pathname = '/crm_perf';
const db = new pg.Client({ connectionString: u.toString() });
await db.connect();
const who = (await db.query('SELECT current_database() d, current_user u')).rows[0];
if (who.d !== 'crm_perf' || who.u !== 'crm_migrator') throw new Error('refusing: not crm_perf');

const problems = [];
/** The 250k load-test org (the larger of the two). */
const orgA = async () =>
  (await db.query('SELECT org_id FROM lead GROUP BY org_id ORDER BY count(*) DESC LIMIT 1')).rows[0]
    .org_id;
const rows = [];
for (const r of run.runs) {
  const m = manifest.files.find((f) => f.name === r.file);
  const c = r.counts;
  const exp = m?.expected;
  // Q3 is the multisheet file's other sheet: its expectations are its row count only.
  if (exp && !(r.file === 'corpus_multisheet.xlsx' && r.experiment)) {
    for (const [k, v] of [
      ['total', exp.total],
      ['valid', exp.valid],
      ['invalid', exp.invalid],
      ['empty', exp.empty],
      ['duplicateInFile', exp.duplicateInFile],
    ])
      if (c[k] !== v) problems.push(`${r.file} (${r.org}): ${k} ${c[k]} ≠ manifest ${v}`);
  }
  // The large files' "existing" rows reuse seeded org A phones. A row whose phone belongs to an
  // open lead attaches to it; to a closed (won/lost) lead, it creates a new lead linked as a
  // returning customer (lead-lifecycle §5.3). So attached + returning = existing.
  if (exp?.existing && String(r.org).startsWith('A')) {
    const job = (
      await db.query(
        `SELECT id FROM import_job WHERE org_id = $1 AND rows_total = $2 AND file_type = $3
          ORDER BY created_at DESC LIMIT 1`,
        [run.orgA ?? (await orgA()), c.total, r.file.endsWith('.xlsx') ? 'xlsx' : 'csv'],
      )
    ).rows[0];
    const returning = (
      await db.query(
        `SELECT count(*)::int n FROM lead l JOIN lead_enquiry e ON e.lead_id = l.id
          WHERE e.external_id LIKE $1 AND l.previous_lead_id IS NOT NULL
            AND l.created_at >= (SELECT created_at FROM import_job WHERE id = $2)`,
        [`${job.id}:%`, job.id],
      )
    ).rows[0].n;
    r.returning = returning;
    if (c.attached + returning !== exp.existing)
      problems.push(
        `${r.file} (${r.org}): attached ${c.attached} + returning ${returning} ≠ manifest existing ${exp.existing}`,
      );
  }
  if (c.created + c.attached + c.skipped + c.failed !== c.valid)
    problems.push(`${r.file} (${r.org}): created+attached+skipped+failed ≠ valid`);
  if (r.leadsCreated !== c.created)
    problems.push(`${r.file} (${r.org}): leads created ${r.leadsCreated} ≠ counter ${c.created}`);
  rows.push({
    file: r.file + (r.reupload ? ' (re-upload)' : '') + (r.experiment ? ' (no name index)' : ''),
    org: r.org,
    total: c.total,
    valid: c.valid,
    invalid: c.invalid,
    empty: c.empty,
    dupInFile: c.duplicateInFile,
    created: c.created,
    attached: c.attached,
    returning: r.returning ?? '',
    failed: c.failed,
    crashes: r.crashes,
    importRowsPerSec: r.importRowsPerSec,
    importSeconds: r.seconds.import,
  });
}
// Database-wide checks on crm_perf.
const dupExt = (
  await db.query(`SELECT count(*)::int n FROM (SELECT org_id, source_id, external_id FROM lead_enquiry
     WHERE external_id IS NOT NULL GROUP BY 1, 2, 3 HAVING count(*) > 1) d`)
).rows[0].n;
if (dupExt) problems.push(`${dupExt} duplicate enquiry external ids`);
const dupOpen = (
  await db.query(`SELECT count(*)::int n FROM (SELECT org_id, primary_phone_e164 FROM lead
     WHERE stage NOT IN ('WON','LOST') AND deleted_at IS NULL AND merged_into_lead_id IS NULL
     GROUP BY 1, 2 HAVING count(*) > 1) d`)
).rows[0].n;
if (dupOpen) problems.push(`${dupOpen} duplicate open-lead phones`);
const perJob = (
  await db.query(`SELECT j.id, j.rows_created + j.rows_attached AS expected,
       (SELECT count(*)::int FROM lead_enquiry e WHERE e.channel_ref = 'IMPORT'
          AND e.external_id LIKE j.id::text || ':%') AS enquiries
     FROM import_job j WHERE j.status IN ('COMPLETED', 'COMPLETED_WITH_ERRORS')`)
).rows;
for (const j of perJob)
  if (j.expected !== j.enquiries)
    problems.push(`job ${j.id}: ${j.enquiries} enquiries ≠ created+attached ${j.expected}`);
await db.end();
console.table(rows);
console.log(
  JSON.stringify(
    {
      duplicateExternalIds: dupExt,
      duplicateOpenPhones: dupOpen,
      jobsChecked: perJob.length,
      problems,
    },
    null,
    2,
  ),
);
process.exit(problems.length ? 1 : 0);
