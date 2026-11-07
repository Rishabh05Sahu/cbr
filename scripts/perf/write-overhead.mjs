// M6: write overhead and storage of the proposed P-B column/index and P-D index on the ISOLATED
// crm_perf database (both applied). Every measurement runs in a transaction that is ROLLED BACK:
// a variant without an object drops it inside that transaction (DROP COLUMN / DROP INDEX are
// transactional), so all variants run on the same data, nothing is kept, and the objects are
// verified present again afterwards.
//
//   node scripts/perf/write-overhead.mjs <results.json> [reps=3]
//
// Two write shapes: 2,000 single-row INSERTs in a loop (the per-lead OLTP shape of create and
// import) and one 20,000-row INSERT … SELECT (bulk). Rows are synthetic copies of org rows with
// fresh phones; the CHECKs and the open-phone unique index still apply.
import { writeFileSync } from 'node:fs';
import 'dotenv/config';
import pg from 'pg';

/** crm_perf URL from the local crm_test migrator URL (same check as perf-db.mjs). */
function perfUrl(testVar) {
  const u = new URL(process.env[testVar]);
  if (u.hostname !== '127.0.0.1' || u.port !== '55432' || u.pathname !== '/crm_test')
    throw new Error(`${testVar} is not the local crm_test URL`);
  u.pathname = '/crm_perf';
  return u.toString();
}

const OUT = process.argv[2];
const REPS = Number(process.argv[3] ?? 3);
const c = new pg.Client({ connectionString: perfUrl('TEST_MIGRATOR_URL') });
await c.connect();
const who = (await c.query('SELECT current_user u, current_database() d')).rows[0];
if (who.u !== 'crm_migrator' || who.d !== 'crm_perf')
  throw new Error('refusing: not crm_perf as crm_migrator');

const present = async () =>
  (
    await c.query(`SELECT
      EXISTS (SELECT 1 FROM information_schema.columns WHERE table_name = 'lead' AND column_name = 'email_normalized') col,
      EXISTS (SELECT 1 FROM pg_indexes WHERE tablename = 'lead' AND indexname = 'lead_org_id_email_normalized_idx') email_idx,
      EXISTS (SELECT 1 FROM pg_indexes WHERE tablename = 'lead' AND indexname = 'lead_org_id_full_name_id_idx') name_idx`)
  ).rows[0];
const before = await present();
if (!before.col || !before.email_idx || !before.name_idx)
  throw new Error('apply 0007 and 0008 to crm_perf first');

const org = (await c.query(`SELECT org_id FROM lead GROUP BY 1 ORDER BY count(*) DESC LIMIT 1`))
  .rows[0].org_id;

const VARIANTS = {
  'baseline (neither)': [
    'DROP INDEX lead_org_id_full_name_id_idx',
    'ALTER TABLE lead DROP COLUMN email_normalized',
  ],
  'P-B only (column + e-mail index)': ['DROP INDEX lead_org_id_full_name_id_idx'],
  'P-D only (name index)': ['ALTER TABLE lead DROP COLUMN email_normalized'],
  'P-B + P-D': [],
};

// Single-row inserts in a loop, timed inside the server (no client round trips).
const singleRows = `
DO $$
DECLARE t0 timestamptz := clock_timestamp(); r record; i int := 0;
BEGIN
  FOR r IN SELECT full_name, email, source_id FROM lead WHERE org_id = '${org}' ORDER BY id LIMIT 2000 LOOP
    i := i + 1;
    INSERT INTO lead (org_id, full_name, primary_phone_e164, primary_phone_raw, phone_last10, email, source_id)
    VALUES ('${org}', r.full_name || ' w', '+9169' || lpad(i::text, 8, '0'), '69' || lpad(i::text, 8, '0'),
            '69' || lpad(i::text, 8, '0'), r.email, r.source_id);
  END LOOP;
  PERFORM set_config('perf.ms', (extract(epoch FROM clock_timestamp() - t0) * 1000)::text, true);
END $$;`;
const bulk = `
INSERT INTO lead (org_id, full_name, primary_phone_e164, primary_phone_raw, phone_last10, email, source_id)
SELECT org_id, full_name || ' b', '+9168' || lpad(g::text, 8, '0'), '68' || lpad(g::text, 8, '0'),
       '68' || lpad(g::text, 8, '0'), email, source_id
  FROM (SELECT org_id, full_name, email, source_id, row_number() OVER (ORDER BY id) g
          FROM lead WHERE org_id = '${org}' ORDER BY id LIMIT 20000) s`;

const results = { generatedAt: new Date().toISOString(), reps: REPS, variants: {} };
for (let rep = 0; rep < REPS; rep++)
  for (const [name, drops] of Object.entries(VARIANTS)) {
    await c.query('BEGIN');
    try {
      for (const d of drops) await c.query(d);
      await c.query(singleRows);
      const single = Number((await c.query(`SELECT current_setting('perf.ms') ms`)).rows[0].ms);
      const t = performance.now();
      await c.query(bulk);
      const bulkMs = performance.now() - t;
      const v = (results.variants[name] ??= { single2000Ms: [], bulk20000Ms: [] });
      v.single2000Ms.push(Math.round(single));
      v.bulk20000Ms.push(Math.round(bulkMs));
    } finally {
      await c.query('ROLLBACK');
    }
  }
const med = (xs) => [...xs].sort((a, b) => a - b)[Math.floor(xs.length / 2)];
for (const [name, v] of Object.entries(results.variants)) {
  v.single2000MedianMs = med(v.single2000Ms);
  v.perRowUs = Math.round((v.single2000MedianMs / 2000) * 1000);
  v.bulk20000MedianMs = med(v.bulk20000Ms);
  console.log(
    `${name.padEnd(34)} single 2,000: ${v.single2000Ms.join('/')} ms (median ${v.single2000MedianMs}, ${v.perRowUs} µs/row); bulk 20,000: ${v.bulk20000Ms.join('/')} ms (median ${v.bulk20000MedianMs})`,
  );
}

// Storage.
results.storage = (
  await c.query(`SELECT
    pg_size_pretty(pg_relation_size('lead')) heap,
    pg_relation_size('lead') heap_bytes,
    pg_size_pretty(pg_relation_size('lead_org_id_email_normalized_idx')) email_idx,
    pg_relation_size('lead_org_id_email_normalized_idx') email_idx_bytes,
    pg_size_pretty(pg_relation_size('lead_org_id_full_name_id_idx')) name_idx,
    pg_relation_size('lead_org_id_full_name_id_idx') name_idx_bytes,
    pg_size_pretty(pg_indexes_size('lead')) all_lead_indexes,
    (SELECT count(*) FROM lead) leads,
    (SELECT count(*) FROM lead WHERE email IS NOT NULL) leads_with_email,
    (SELECT avg(pg_column_size(email_normalized))::numeric(6,1) FROM lead WHERE email_normalized IS NOT NULL) avg_col_bytes`)
).rows[0];
console.log('storage:', results.storage);
const after = await present();
results.objectsIntactAfterwards = after.col && after.email_idx && after.name_idx;
const leftovers = Number(
  (
    await c.query(
      `SELECT count(*) n FROM lead WHERE primary_phone_e164 LIKE '+9169%' OR primary_phone_e164 LIKE '+9168%'`,
    )
  ).rows[0].n,
);
results.rolledBack = leftovers === 0;
console.log('objects intact:', results.objectsIntactAfterwards, '; rolled back:', leftovers === 0);
writeFileSync(OUT, JSON.stringify(results, null, 2));
await c.end();
