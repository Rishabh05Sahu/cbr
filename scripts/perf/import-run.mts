// M6 PRELIMINARY import benchmark and corpus integrity run on the ISOLATED crm_perf database
// (seeded 250k-lead org). Uses the real import job (start → upload verification → analysis →
// mapping → validation → attested import) with in-memory storage (no bucket), the SYNTHETIC
// corpus (tests/support/import-corpus.ts) and the worker's own step function. Measures each phase
// and checks exact counts, a crash in the middle of a batch with resume, and re-upload of the
// same file. Not the staging acceptance (NFR-006 is measured again on staging).
//
//   pnpm exec tsx scripts/perf/import-run.mts <perf-accounts.json> <results.json> [full|rest|sample] [rows] [label]
//
// "full" (default): the corpus checks below. "rest": the same without the 100k file (steps 2-6),
// for a machine without the free memory the 100k file needs. "sample": one synthetic CSV of <rows> (default
// 1,000) into the 250k org, to compare one optimisation at a time on a freshly seeded crm_perf.
//
// Memory guard: if free system memory drops below PERF_MIN_FREE_MB (default 1,000) or this
// process passes PERF_MAX_RSS_MB (default 3,000), the run writes what it has, stops with exit
// code 3 and is NOT restarted (an interrupted batch rolls back; FR-048 resume covers it).
import { spawnSync } from 'node:child_process';
import { readFileSync, writeFileSync } from 'node:fs';
import { freemem } from 'node:os';
import { createRequire } from 'node:module';
const req = createRequire('C:/Users/aDMIN/Desktop/CRM/package.json');
req('dotenv').config({ path: 'C:/Users/aDMIN/Desktop/CRM/.env', quiet: true });
const pg = req('pg') as typeof import('pg');

const perf = (v: string) => {
  const u = new URL(process.env[v]!);
  if (u.hostname !== '127.0.0.1' || u.port !== '55432' || u.pathname !== '/crm_test')
    throw new Error(`${v} is not the local crm_test URL`);
  u.pathname = '/crm_perf';
  return u.toString();
};
const urls = Object.entries({
  DATABASE_URL: 'TEST_DATABASE_URL',
  AUTH_DATABASE_URL: 'TEST_AUTH_DATABASE_URL',
  PLATFORM_DATABASE_URL: 'TEST_PLATFORM_DATABASE_URL',
  TEST_MIGRATOR_URL: 'TEST_MIGRATOR_URL',
}).map(([k, v]) => [k, perf(v)] as const);
for (const [k, v] of urls) process.env[k] = v;
process.env.CLEANUP_DATABASE_URL = '';
process.env.REDIS_URL = `${(process.env.REDIS_URL ?? 'redis://127.0.0.1:56379').replace(/\/\d+$/, '')}/3`;
process.env.BETTER_AUTH_URL = 'http://localhost:3400';
process.env.LOG_LEVEL = 'silent';

const acc = JSON.parse(readFileSync(process.argv[2]!, 'utf8'));
const ROOT = 'file:///C:/Users/aDMIN/Desktop/CRM';
const { authenticators } = await import(`${ROOT}/tests/support/totp.ts`);
for (const u of [acc.A.owner, acc.B.owner])
  if (u.secret) authenticators.set(u.email.toLowerCase(), u.secret);
const f = await import(`${ROOT}/tests/support/factory.ts`);
const imports = await import(`${ROOT}/src/modules/imports/index.ts`);
const { processImportJob } = await import(`${ROOT}/src/modules/imports/processor.ts`);
const leads = await import(`${ROOT}/src/modules/leads/index.ts`);
const { memoryStorage } = await import(`${ROOT}/tests/support/memory-storage.ts`);
const corpus = await import(`${ROOT}/tests/support/import-corpus.ts`);
const S = await import(`${ROOT}/tests/support/synthetic-data.ts`);

const db = new pg.Client({ connectionString: process.env.TEST_MIGRATOR_URL });
await db.connect();
{
  const who = (await db.query('SELECT current_database() d, current_user u')).rows[0];
  if (who.d !== 'crm_perf' || who.u !== 'crm_migrator')
    throw new Error('refusing: not crm_perf as crm_migrator');
}
const ownerA = await f.actorIn(acc.A.owner, acc.A.orgId);
const ownerB = await f.actorIn(acc.B.owner, acc.B.orgId);
const storage = memoryStorage();
const TYPES = {
  csv: 'text/csv',
  xlsx: 'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet',
} as const;
const s = (ms: number) => Math.round(ms / 100) / 10;
const leadCount = async (orgId: string) =>
  Number((await db.query('SELECT count(*) n FROM lead WHERE org_id = $1', [orgId])).rows[0].n);

interface CorpusFile {
  name: string;
  type: 'csv' | 'xlsx';
  bytes: () => Uint8Array;
  sheet?: string;
}
interface RunOpts {
  crashAtBatch?: number;
  acknowledgeDuplicateFile?: boolean;
  expectRefusedWithoutAck?: boolean;
}
async function runImport(actor: typeof ownerA, file: CorpusFile, opts: RunOpts = {}) {
  const bytes = file.bytes();
  const before = await leadCount(actor.ctx.orgId);
  const step = (deps = {}) =>
    processImportJob(actor.ctx.orgId, id, { storage, commitStrategy: STRATEGY, ...deps });
  const t0 = performance.now();
  const started = await imports.startImport(
    actor.ctx,
    { fileName: file.name, size: bytes.byteLength, type: TYPES[file.type] },
    storage,
  );
  const id = started.importId;
  storage.browserPut(started.upload.url, bytes, started.upload.headers['content-type']!);
  await imports.confirmUpload(actor.ctx, id, storage);
  const tUpload = performance.now();
  let out = await step();
  if (file.sheet) {
    const j = await imports.getImport(actor.ctx, id);
    if (j.sheetName !== file.sheet) {
      await imports.chooseSheet(actor.ctx, id, { sheet: file.sheet, version: j.version });
      out = await step();
    }
  }
  if (out !== 'needs_mapping') throw new Error(`${file.name}: analysis ended ${out}`);
  const tAnalyse = performance.now();
  let job = await imports.getImport(actor.ctx, id);
  await imports.submitMapping(actor.ctx, id, {
    mapping: job.mapping,
    duplicatePolicy: 'ATTACH',
    assignment: { mode: 'none' },
    dryRun: false,
    version: job.version,
  });
  out = await step();
  if (out !== 'ready') throw new Error(`${file.name}: validation ended ${out}`);
  const tValidate = performance.now();
  job = await imports.getImport(actor.ctx, id);
  let refusedWithoutAck: boolean | null = null;
  if (opts.expectRefusedWithoutAck) {
    try {
      await imports.confirmImport(actor.ctx, id, { attest: true, version: job.version });
      refusedWithoutAck = false;
    } catch (e) {
      refusedWithoutAck = (e as { code?: string } | null)?.code === 'RULE_VIOLATION';
    }
  }
  await imports.confirmImport(actor.ctx, id, {
    attest: true,
    version: job.version,
    ...(opts.acknowledgeDuplicateFile ? { acknowledgeDuplicateFile: true } : {}),
  });
  let crashes = 0;
  for (let attempt = 0; attempt < 5; attempt++) {
    try {
      out = await step(
        opts.crashAtBatch !== undefined && crashes === 0
          ? {
              inBatch: (b: number) => {
                if (b === opts.crashAtBatch) {
                  crashes++;
                  throw new Error('simulated worker crash inside a batch');
                }
              },
            }
          : {},
      );
      break;
    } catch (e) {
      if (!/simulated worker crash/.test((e as Error | null)?.message ?? '')) throw e;
    }
  }
  if (out !== 'completed') throw new Error(`${file.name}: import ended ${out}`);
  const tImport = performance.now();
  const view = await imports.getImport(actor.ctx, id);
  const after = await leadCount(actor.ctx.orgId);
  const rr = (
    await db.query(
      `SELECT outcome, count(*)::int n FROM import_row_result WHERE import_job_id = $1 GROUP BY outcome`,
      [id],
    )
  ).rows;
  return {
    file: file.name,
    bytes: bytes.byteLength,
    rows: view.counts.total,
    crashes,
    refusedWithoutAck,
    duplicateOfEarlierFile: view.duplicateOfJob !== null,
    counts: view.counts,
    rowResults: Object.fromEntries(rr.map((r: { outcome: string; n: number }) => [r.outcome, r.n])),
    leadsCreated: after - before,
    seconds: {
      upload: s(tUpload - t0),
      analyse: s(tAnalyse - tUpload),
      validate: s(tValidate - tAnalyse),
      import: s(tImport - tValidate),
      total: s(tImport - t0),
    },
    importRowsPerSec: Math.round(view.counts.valid / ((tImport - tValidate) / 1000)),
    endToEndRowsPerSec: Math.round(view.counts.total / ((tImport - t0) / 1000)),
  };
}

type Run = Awaited<ReturnType<typeof runImport>> & Record<string, unknown>;
const MODE = process.argv[4] ?? 'full';
// PERF_COMMIT_STRATEGY: 'set' (default, the application default) or 'row' (the rollback path).
const STRATEGY = (process.env.PERF_COMMIT_STRATEGY ?? 'set') as 'row' | 'set';
if (STRATEGY !== 'row' && STRATEGY !== 'set') throw new Error(`unknown strategy ${STRATEGY}`);
if (MODE !== 'full' && MODE !== 'rest' && MODE !== 'sample')
  throw new Error(`unknown mode ${MODE}`);
const results: { runs: Run[]; [k: string]: unknown } = {
  generatedAt: new Date().toISOString(),
  mode: MODE,
  label: process.argv[6] ?? null,
  strategy: STRATEGY,
  thresholds: { rowsPerSecPerWorker: 300, maxSecondsFor100kFile: 600 },
  runs: [],
};

// ---- Resource monitoring and the memory guard ------------------------------------------------
const MIN_FREE_MB = Number(process.env.PERF_MIN_FREE_MB ?? 1000);
const MAX_RSS_MB = Number(process.env.PERF_MAX_RSS_MB ?? 3000);
const mb = (b: number) => Math.round(b / 1048576);
const pgMem = () =>
  spawnSync(
    'docker',
    ['stats', '--no-stream', '--format', '{{.MemUsage}} cpu {{.CPUPerc}}', 'cbr-crm-postgres-1'],
    { encoding: 'utf8' },
  ).stdout.trim();
const resources: Record<string, unknown> & { peakRssMb: number; minFreeMb: number } = {
  peakRssMb: 0,
  minFreeMb: mb(freemem()),
  postgresAtStart: pgMem(),
};
results.resources = resources;
const guard = setInterval(() => {
  const rss = mb(process.memoryUsage().rss);
  const free = mb(freemem());
  resources.peakRssMb = Math.max(resources.peakRssMb, rss);
  resources.minFreeMb = Math.min(resources.minFreeMb, free);
  if (free < MIN_FREE_MB || rss > MAX_RSS_MB) {
    clearInterval(guard);
    results.stoppedByMemoryGuard = { rssMb: rss, freeMb: free, at: new Date().toISOString() };
    console.error(`MEMORY GUARD: rss ${rss} MB, free ${free} MB; stopping (not restarted)`);
    writeFileSync(process.argv[3]!, JSON.stringify(results, null, 2));
    process.exit(3);
  }
}, 2000);

const files = corpus.corpusFiles() as CorpusFile[];
const byName = (n: string) => files.find((x) => x.name === n)!;
const log = (r: Run) =>
  console.log(
    `${r.file}: rows ${r.rows}, created ${r.leadsCreated}, counts ${JSON.stringify(r.counts)}, results ${JSON.stringify(r.rowResults)}, crashes ${r.crashes}, ${JSON.stringify(r.seconds)} s, import ${r.importRowsPerSec} rows/s, end-to-end ${r.endToEndRowsPerSec} rows/s, rss ${mb(process.memoryUsage().rss)} MB, free ${mb(freemem())} MB`,
  );
const finish = async () => {
  // Integrity: no duplicate open-lead phones in either org (the database also enforces this).
  results.integrity = (
    await db.query(
      `SELECT count(*)::int dup FROM (SELECT org_id, primary_phone_e164 FROM lead WHERE stage NOT IN ('WON','LOST') AND deleted_at IS NULL AND merged_into_lead_id IS NULL GROUP BY 1, 2 HAVING count(*) > 1) x`,
    )
  ).rows[0];
  console.log('duplicate open-lead phones:', results.integrity.dup);
  clearInterval(guard);
  resources.postgresAtEnd = pgMem();
  writeFileSync(process.argv[3]!, JSON.stringify(results, null, 2));
  await db.end();
  process.exit(0);
};

let r: Run;

// ---- Sample: one optimisation at a time ------------------------------------------------------
// N rows into org A (250k): new phones (block 9), every 2nd row with an e-mail (each one pays the
// duplicate check), and every 20th row reusing a seeded org A phone, which is an open lead
// (enquiry attached) or a won/lost one (new lead linked as a returning customer).
if (MODE === 'sample') {
  const rows = Number(process.argv[5] ?? 1000);
  // PERF_SAMPLE_OFFSET shifts the rows (fresh phones and e-mails) for a second sample on the same
  // database; the default 0 is the sample compared across configurations.
  const offset = Number(process.env.PERF_SAMPLE_OFFSET ?? 0);
  const sample: CorpusFile = {
    name: `perf_sample_${rows}_${offset}.csv`,
    type: 'csv',
    bytes: () =>
      corpus.csv([
        ['Customer Name', 'Mobile', 'Email', 'City'],
        ...Array.from({ length: rows }, (_, k) => {
          const i = k + offset;
          const rr = S.rowRandom(20261027, i);
          return [
            S.syntheticName(rr, 300_000 + i),
            i % 20 === 10 ? S.syntheticMobile(7, (i * 997) % acc.A.leads) : S.syntheticMobile(9, i),
            i % 2 === 0 ? S.syntheticEmail(300_000 + i, 'sample') : '',
            S.pick(rr, S.CITY_NAMES),
          ];
        }),
      ]),
  };
  r = await runImport(ownerA, sample);
  r.org = 'A (250k)';
  results.runs.push(r);
  log(r);
  await finish();
}

const sheetOnly = (name: string, sheet: string) => ({ ...byName(name), sheet });
const openMatchesIn = async (orgId: string, rows: number, file: 'csv' | 'xlsx') => {
  const reused = Array.from({ length: rows }, (_, i) => i)
    .filter((i) => corpus.mixOf(i) === 'existing')
    .map((i) => `+91${corpus.largePhone(i, file)}`);
  return Number(
    (
      await db.query(
        `SELECT count(*) n FROM lead WHERE org_id = $1 AND primary_phone_e164 = ANY($2) AND stage NOT IN ('WON','LOST') AND deleted_at IS NULL AND merged_into_lead_id IS NULL`,
        [orgId, reused],
      )
    ).rows[0].n,
  );
};

// Any failure still writes what was measured (and the error), then exits 1; not restarted.
try {
  // ---- Org B (5,000 leads): the import pipeline itself -----------------------------------------
  // 1. 100k rows just under 20 MB, with a simulated worker crash inside batch 100 and resume.
  if (MODE === 'full') {
    r = await runImport(ownerB, byName('corpus_large_100k.csv'), { crashAtBatch: 100 });
    r.org = 'B (5k)';
    r.expectedExistingMatches = await openMatchesIn(acc.B.orgId, corpus.LARGE_ROWS, 'csv');
    results.runs.push(r);
    log(r);
  }
  // 2. 20k rows as XLSX.
  r = await runImport(ownerB, byName('corpus_xlsx_20k.xlsx'));
  r.org = 'B (5k)';
  r.expectedExistingMatches = await openMatchesIn(acc.B.orgId, corpus.XLSX_ROWS, 'xlsx');
  results.runs.push(r);
  log(r);
  // 3. Header variants, then the same file again (flagged, refused without acknowledgement, attaches).
  r = await runImport(ownerB, byName('corpus_variants.csv'));
  r.org = 'B (5k)';
  results.runs.push(r);
  log(r);
  r = await runImport(ownerB, byName('corpus_variants.csv'), {
    expectRefusedWithoutAck: true,
    acknowledgeDuplicateFile: true,
  });
  r.org = 'B (5k)';
  r.reupload = true;
  results.runs.push(r);
  log(r);
  // 4. Custom fields last (a required custom field would block the files above).
  for (const d of corpus.CORPUS_CUSTOM_FIELDS) await leads.createCustomField(ownerB.ctx, { ...d });
  r = await runImport(ownerB, byName('corpus_custom_fields.csv'));
  r.org = 'B (5k)';
  results.runs.push(r);
  log(r);

  // ---- Org A (250,000 leads): per-row cost at scale ---------------------------------------------
  // 5. 500 rows (half with an e-mail), 150 rows (all with an e-mail).
  r = await runImport(ownerA, byName('corpus_variants.csv'));
  r.org = 'A (250k)';
  results.runs.push(r);
  log(r);
  r = await runImport(ownerA, sheetOnly('corpus_multisheet.xlsx', 'Leads Q4'));
  r.org = 'A (250k)';
  results.runs.push(r);
  log(r);
  // 5b. The large files at 250k scale: their "existing" rows reuse seeded org A phones, so they
  //     attach there (manifest "existing"); throughput and batch time measured on the big org.
  if (MODE === 'full') {
    r = await runImport(ownerA, byName('corpus_large_100k.csv'));
    r.org = 'A (250k)';
    r.expectedExistingMatches = await openMatchesIn(acc.A.orgId, corpus.LARGE_ROWS, 'csv');
    results.runs.push(r);
    log(r);
  }
  r = await runImport(ownerA, byName('corpus_xlsx_20k.xlsx'));
  r.org = 'A (250k)';
  r.expectedExistingMatches = await openMatchesIn(acc.A.orgId, corpus.XLSX_ROWS, 'xlsx');
  results.runs.push(r);
  log(r);
  // 6. Index comparison (throwaway crm_perf only): the other 150-row sheet WITHOUT the proposed
  //    name-sort index (P-D), to see its write cost inside a real import; then it is rebuilt.
  const nameIdx = (
    await db.query(
      `SELECT indexdef FROM pg_indexes WHERE tablename = 'lead' AND indexname = 'lead_org_id_full_name_id_idx'`,
    )
  ).rows[0]?.indexdef as string | undefined;
  if (nameIdx) {
    await db.query('DROP INDEX lead_org_id_full_name_id_idx');
    // Same workbook as Q4 (another sheet): the duplicate-file guard asks for an acknowledgement.
    r = await runImport(ownerA, sheetOnly('corpus_multisheet.xlsx', 'Leads Q3'), {
      acknowledgeDuplicateFile: true,
    });
    r.org = 'A (250k)';
    r.experiment = 'without lead_org_id_full_name_id_idx (P-D)';
    results.runs.push(r);
    log(r);
    await db.query(nameIdx);
    await db.query('ANALYZE lead');
  }
} catch (e) {
  results.error = e instanceof Error ? `${e.name}: ${e.message}` : String(e);
  console.error('RUN FAILED:', results.error);
  clearInterval(guard);
  writeFileSync(process.argv[3]!, JSON.stringify(results, null, 2));
  await db.end();
  process.exit(1);
}

await finish();
