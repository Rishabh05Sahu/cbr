// Helper for s1-managed-run.mjs: run SQL statements in order on one connection and print the
// rows and server notices as JSON. Inputs (environment only): U = connection URL, Q = JSON array
// of SQL strings. Errors print the message only (never the URL).
import pg from 'pg';

const statements = JSON.parse(process.env.Q ?? '[]');
const client = new pg.Client({ connectionString: process.env.U });
const notices = [];
client.on('notice', (n) => notices.push(n.message));

try {
  await client.connect();
  const results = [];
  for (const sql of statements) {
    const r = await client.query(sql);
    results.push((Array.isArray(r) ? r.at(-1) : r).rows ?? []);
  }
  console.log(JSON.stringify({ results, notices }));
} catch (e) {
  console.error(e.message);
  process.exitCode = 1;
} finally {
  await client.end().catch(() => {});
}
