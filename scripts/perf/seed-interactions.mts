// NFR-003 benchmark seed (docs/PHASE-3-NFR-003-BENCHMARK.md), run AFTER seed-perf.mts on the
// ISOLATED local database crm_perf only (identity queried; refuses anything else). SYNTHETIC data.
//
//   pnpm exec tsx scripts/perf/seed-interactions.mts <accounts.json> <pools-out.json>
//
// 1. Pools of org A leads for the benchmark scenarios, each lead owned by one of the 40 synthetic
//    executives, live, not archived, contact status OK, outside the 20 heavy-timeline leads:
//      S1  minimal save ("No answer")           Contacted / Qualified / visit stages
//      S2  first connected outcome               Assigned (moves to Contacted)
//      S3  full sheet (follow-up done + next +   Contacted, each given one open follow-up here
//          two requirement fields)
//      S4  wrong number (contact status event)   Qualified / Nurture / visit stages
//      S5  heavy timeline                        the 20 seeded leads with 300 activities
// 2. History so indexes have a realistic size: 50,000 earlier interactions (with their timeline
//    rows, through the real triggers) on other live org A leads, and 100 more on each heavy lead.
// Rows are inserted as the schema owner (crm_migrator, `maintenance` policy), within every CHECK
// and trigger (fingerprints are random hex: these rows are never retried).
import { writeFileSync, readFileSync } from 'node:fs';
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
const acc = JSON.parse(readFileSync(process.argv[2]!, 'utf8'));
const out = process.argv[3]!;
const db = new pg.Client({ connectionString: perf('TEST_MIGRATOR_URL') });
await db.connect();
const id = (await db.query('SELECT current_database() d, current_user u')).rows[0];
if (id.d !== 'crm_perf' || id.u !== 'crm_migrator')
  throw new Error('refusing: not crm_perf as crm_migrator');
if (Number((await db.query('SELECT count(*) n FROM interaction')).rows[0].n) > 0)
  throw new Error('crm_perf already has interactions; recreate it first');
const t0 = Date.now();
const A = acc.A.orgId as string;
const execs = acc.A.execs as string[];
const heavy = acc.A.timelineLeads as string[];

const SIZES = { S1: 3000, S2: 2600, S3: 1300, S4: 1000 };
const pool = async (stages: string[], n: number, exclude: string[]) =>
  (
    await db.query(
      `SELECT id, owner_user_id AS owner FROM lead
        WHERE org_id = $1 AND stage::text = ANY($2) AND deleted_at IS NULL AND archived_at IS NULL
          AND merged_into_lead_id IS NULL AND contact_status = 'OK'
          AND owner_user_id = ANY($3::uuid[]) AND NOT (id = ANY($4::uuid[]))
        ORDER BY md5(id::text) LIMIT $5`,
      [A, stages, execs, exclude, n],
    )
  ).rows as { id: string; owner: string }[];

const used: string[] = [...heavy];
const S2 = await pool(['ASSIGNED'], SIZES.S2, used);
used.push(...S2.map((r) => r.id));
const S3 = await pool(['CONTACTED'], SIZES.S3, used);
used.push(...S3.map((r) => r.id));
const S1 = await pool(
  ['CONTACTED', 'QUALIFIED', 'SITE_VISIT_SCHEDULED', 'SITE_VISIT_COMPLETED'],
  SIZES.S1,
  used,
);
used.push(...S1.map((r) => r.id));
const S4 = await pool(
  ['QUALIFIED', 'NURTURE', 'SITE_VISIT_COMPLETED', 'NEGOTIATION'],
  SIZES.S4,
  used,
);
used.push(...S4.map((r) => r.id));
for (const [k, p] of Object.entries({ S1, S2, S3, S4 }))
  if (p.length < SIZES[k as keyof typeof SIZES])
    throw new Error(`pool ${k} too small: ${p.length}`);

// S3: one open follow-up per lead, assigned to its owner, due in 1–5 days.
const tasks = (
  await db.query(
    `INSERT INTO task (org_id, type, lead_id, assignee_user_id, created_by, due_at, priority)
     SELECT $1, 'FOLLOW_UP', x.id, x.owner, x.owner,
            now() + (1 + (abs(hashtext(x.id::text)) % 5)) * interval '1 day', 'NORMAL'
       FROM unnest($2::uuid[], $3::uuid[]) AS x(id, owner)
     RETURNING id, lead_id, version`,
    [A, S3.map((r) => r.id), S3.map((r) => r.owner)],
  )
).rows as { id: string; lead_id: string; version: number }[];
const taskOf = new Map(tasks.map((t) => [t.lead_id, t]));

// History: 50,000 interactions on other live leads (outcomes that fit their stage), then 100 on
// each heavy lead. Inserted in batches through the real triggers (guard + timeline row).
async function history(leadSql: string, params: unknown[], label: string) {
  const r = await db.query(
    `WITH l AS (${leadSql}),
          o(k, channel, direction, outcome, grp) AS (VALUES
            (0, 'PHONE_NATIVE', 'OUTBOUND', 'NO_ANSWER', 'NOT_CONNECTED'),
            (1, 'PHONE_NATIVE', 'OUTBOUND', 'BUSY', 'NOT_CONNECTED'),
            (2, 'WHATSAPP_APP_MESSAGE', 'OUTBOUND', 'MESSAGE_SENT', 'OTHER'),
            (3, 'PHONE_NATIVE', 'OUTBOUND', 'CONNECTED_CALL_BACK', 'CONNECTED'),
            (4, 'PHONE_NATIVE', 'INBOUND', 'CONNECTED_INTERESTED', 'CONNECTED'))
     INSERT INTO interaction (org_id, lead_id, user_id, channel, direction, outcome, outcome_group,
                              occurred_at, contact_status_at_log, client_idempotency_key,
                              request_fingerprint, notes)
     SELECT l.org_id, l.id, l.owner_user_id, o.channel, o.direction, o.outcome, o.grp,
            now() - ((l.n * 7919) % 9000) * interval '1 minute', 'OK', gen_random_uuid(),
            encode(sha256(gen_random_uuid()::text::bytea), 'hex'),
            CASE WHEN l.n % 3 = 0 THEN 'Synthetic history note ' || l.n END
       FROM l JOIN o ON o.k = CASE WHEN l.stage = 'ASSIGNED' THEN l.n % 2 ELSE l.n % 5 END`,
    params,
  );
  console.log(
    `  ${label}: ${r.rowCount} interactions (${((Date.now() - t0) / 1000).toFixed(0)} s)`,
  );
  return r.rowCount ?? 0;
}
let historyRows = 0;
for (let batch = 0; batch < 10; batch++)
  historyRows += await history(
    `SELECT id, org_id, owner_user_id, stage::text AS stage, row_number() OVER () AS n FROM lead
      WHERE org_id = $1 AND deleted_at IS NULL AND archived_at IS NULL AND merged_into_lead_id IS NULL
        AND contact_status = 'OK' AND owner_user_id = ANY($2::uuid[]) AND NOT (id = ANY($3::uuid[]))
      ORDER BY md5(id::text || 'h') OFFSET $4 LIMIT 5000`,
    [A, execs, used, batch * 5000],
    `history batch ${batch + 1}/10`,
  );
for (const lead of heavy)
  historyRows += await history(
    `SELECT id, org_id, owner_user_id, 'CONTACTED'::text AS stage, g AS n
       FROM lead, generate_series(1, 100) g
      WHERE id = $1 AND owner_user_id IS NOT NULL AND contact_status = 'OK'
        AND deleted_at IS NULL AND archived_at IS NULL AND merged_into_lead_id IS NULL`,
    [lead],
    `heavy ${lead.slice(0, 8)}`,
  );
await db.query('ANALYZE');

const emails = new Map(
  (
    await db.query(`SELECT id, email FROM "user" WHERE id = ANY($1::uuid[])`, [
      [...execs, acc.A.manager.id],
    ])
  ).rows.map((r: { id: string; email: string }) => [r.id, r.email]),
);
const heavyOwners = (
  await db.query(
    `SELECT id, owner_user_id AS owner FROM lead WHERE id = ANY($1::uuid[])
        AND deleted_at IS NULL AND archived_at IS NULL AND merged_into_lead_id IS NULL`,
    [heavy],
  )
).rows as { id: string; owner: string | null }[];
writeFileSync(
  out,
  JSON.stringify(
    {
      orgId: A,
      timeZone: (await db.query(`SELECT time_zone FROM organization WHERE id = $1`, [A])).rows[0]
        .time_zone,
      execEmails: Object.fromEntries(execs.map((e) => [e, emails.get(e)])),
      manager: { id: acc.A.manager.id, email: emails.get(acc.A.manager.id) },
      S1,
      S2,
      S3: S3.map((r) => ({
        ...r,
        taskId: taskOf.get(r.id)!.id,
        taskVersion: taskOf.get(r.id)!.version,
      })),
      S4,
      S5: heavyOwners.filter((h) => h.owner && execs.includes(h.owner)),
    },
    null,
    2,
  ),
);
const counts = (
  await db.query(
    `SELECT (SELECT count(*) FROM interaction) interactions,
            (SELECT count(*) FROM lead_activity WHERE type = 'INTERACTION') timeline,
            (SELECT count(*) FROM task WHERE status = 'OPEN') open_tasks,
            pg_size_pretty(pg_database_size('crm_perf')) size`,
  )
).rows[0];
console.log(`done in ${((Date.now() - t0) / 1000).toFixed(0)} s:`, { historyRows, ...counts });
await db.end();
process.exit(0);
