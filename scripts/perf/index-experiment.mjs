// EXPERIMENT ONLY, on the throwaway crm_perf database: measures candidate indexes for the M6
// performance proposal (docs/PHASE-2-M6-LOAD-TEST-PLAN.md §6). This is not a migration and is
// never run against crm_dev, crm_test or any managed database. `drop` removes every experimental
// index again and `verify` checks that crm_perf's lead indexes equal the migrations' set.
//
//   node scripts/perf/index-experiment.mjs apply | drop | verify
import { psql } from '../recovery/lib.mjs';

const C = process.env.DRILL_CONTAINER ?? 'cbr-crm-postgres-1';
const DB = 'crm_perf';
const EXPERIMENT = {
  perf_exp_lead_name_trgm:
    'CREATE INDEX perf_exp_lead_name_trgm ON lead USING gin (full_name gin_trgm_ops)',
  perf_exp_lead_email_trgm:
    'CREATE INDEX perf_exp_lead_email_trgm ON lead USING gin ((email::text) gin_trgm_ops)',
  perf_exp_lead_phone_trgm:
    'CREATE INDEX perf_exp_lead_phone_trgm ON lead USING gin (primary_phone_e164 gin_trgm_ops)',
  perf_exp_lead_alt_phone_trgm:
    'CREATE INDEX perf_exp_lead_alt_phone_trgm ON lead USING gin (alternate_phone_e164 gin_trgm_ops)',
  perf_exp_lead_org_name: 'CREATE INDEX perf_exp_lead_org_name ON lead (org_id, full_name, id)',
};
const run = (sql) => psql(C, DB, `SET ROLE crm_migrator; ${sql}`);
const isPerf = psql(C, DB, 'SELECT current_database()') === DB;
if (!isPerf) throw new Error('refusing: not crm_perf');

const cmd = process.argv[2];
if (cmd === 'apply') {
  for (const [name, sql] of Object.entries(EXPERIMENT)) {
    const t = Date.now();
    run(sql);
    console.log(
      `${name}: built in ${((Date.now() - t) / 1000).toFixed(1)} s, ${psql(C, DB, `SELECT pg_size_pretty(pg_relation_size('${name}'))`)}`,
    );
  }
  run('ANALYZE lead');
} else if (cmd === 'drop') {
  for (const name of Object.keys(EXPERIMENT)) run(`DROP INDEX IF EXISTS ${name}`);
  run('ANALYZE lead');
  console.log('experimental indexes dropped');
} else if (cmd === 'verify') {
  const left = psql(
    C,
    DB,
    `SELECT count(*) FROM pg_indexes WHERE tablename = 'lead' AND indexname LIKE 'perf_exp_%'`,
  );
  console.log(`experimental indexes remaining on crm_perf.lead: ${left}`);
  console.log(
    psql(
      C,
      DB,
      `SELECT string_agg(indexname, ', ' ORDER BY indexname) FROM pg_indexes WHERE tablename = 'lead'`,
    ),
  );
} else {
  console.log('usage: node scripts/perf/index-experiment.mjs apply|drop|verify');
  process.exit(2);
}
