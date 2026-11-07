// Local point-in-time-recovery (PITR) drill: measures RPO and recovery time for the WAL
// archiving method, using throwaway containers (never the dev database).
//
//  1. Primary with WAL archiving (archive_timeout = ARCHIVE_TIMEOUT s) + base backup.
//  2. A writer commits a timestamped marker row every 200 ms.
//  3. Disaster: the primary is SIGKILLed and its data volume is treated as lost.
//  4. Recovery: fresh data dir from the base backup + archived WAL, replay to end of archive.
//  5. RPO = last committed marker before the crash − last marker present after recovery.
//  6. Point-in-time target: a second recovery to a chosen timestamp must stop exactly there.
//
// Managed PostgreSQL archives WAL differently (often continuously); this measures the method
// and the procedure, not the provider. Usage: node scripts/recovery/pitr-drill.mjs
import { writeFileSync } from 'node:fs';
import { docker, dockerMaybe, psql, seconds, waitReady } from './lib.mjs';

const IMAGE = 'postgres:18.6-trixie';
const ARCHIVE_TIMEOUT = Number(process.env.PITR_ARCHIVE_TIMEOUT ?? 30);
const WRITE_SECONDS = Number(process.env.PITR_WRITE_SECONDS ?? 75);
const P = 'cbr-pitr-primary';
const R = 'cbr-pitr-restore';
const VOLS = ['cbr-pitr-archive', 'cbr-pitr-backup', 'cbr-pitr-data', 'cbr-pitr-restore-data'];

function cleanup() {
  for (const c of [P, R]) dockerMaybe('rm', '-f', c);
  for (const v of VOLS) dockerMaybe('volume', 'rm', '-f', v);
}

function runPostgres(name, dataVol, extraArgs = []) {
  docker(
    'run',
    '-d',
    '--name',
    name,
    '-e',
    'POSTGRES_PASSWORD=drill',
    '-e',
    'PGDATA=/var/lib/postgresql/data',
    '-v',
    `${dataVol}:/var/lib/postgresql/data`,
    '-v',
    'cbr-pitr-archive:/archive',
    '-v',
    'cbr-pitr-backup:/backup',
    IMAGE,
    'postgres',
    '-c',
    'wal_level=replica',
    '-c',
    'archive_mode=on',
    '-c',
    'archive_command=test ! -f /archive/%f && cp %p /archive/%f',
    '-c',
    `archive_timeout=${ARCHIVE_TIMEOUT}`,
    ...extraArgs,
  );
}

async function recoverInto(target) {
  dockerMaybe('rm', '-f', R);
  dockerMaybe('volume', 'rm', '-f', 'cbr-pitr-restore-data');
  docker('volume', 'create', 'cbr-pitr-restore-data');
  const t = Date.now();
  // Copy the base backup into a fresh data directory, then configure archive recovery.
  const conf = [
    "restore_command = 'cp /archive/%f %p'",
    target ? `recovery_target_time = '${target}'` : "recovery_target_timeline = 'latest'",
    "recovery_target_action = 'promote'",
  ].join('\\n');
  docker(
    'run',
    '--rm',
    '-v',
    'cbr-pitr-backup:/backup',
    '-v',
    'cbr-pitr-restore-data:/data',
    IMAGE,
    'bash',
    '-c',
    `cp -a /backup/base/. /data/ && touch /data/recovery.signal && printf '%b\\n' "${conf}" >> /data/postgresql.auto.conf && chown -R postgres:postgres /data && chmod 700 /data`,
  );
  docker(
    'run',
    '-d',
    '--name',
    R,
    '-e',
    'PGDATA=/var/lib/postgresql/data',
    '-v',
    'cbr-pitr-restore-data:/var/lib/postgresql/data',
    '-v',
    'cbr-pitr-archive:/archive',
    IMAGE,
    'postgres',
  );
  await waitReady(R, 300_000);
  return Date.now() - t;
}

cleanup();
try {
  for (const v of VOLS) docker('volume', 'create', v);
  docker(
    'run',
    '--rm',
    '-v',
    'cbr-pitr-archive:/archive',
    IMAGE,
    'chown',
    'postgres:postgres',
    '/archive',
  );
  docker(
    'run',
    '--rm',
    '-v',
    'cbr-pitr-backup:/backup',
    IMAGE,
    'chown',
    'postgres:postgres',
    '/backup',
  );
  console.log('[pitr] starting primary with WAL archiving');
  runPostgres(P, 'cbr-pitr-data');
  await waitReady(P);
  psql(
    P,
    'postgres',
    'CREATE TABLE marker (id bigserial PRIMARY KEY, at timestamptz NOT NULL DEFAULT clock_timestamp(), pad text)',
  );
  psql(
    P,
    'postgres',
    "INSERT INTO marker (pad) SELECT repeat('x', 500) FROM generate_series(1, 20000)",
  ); // some volume

  console.log('[pitr] base backup');
  docker(
    'exec',
    '-u',
    'postgres',
    P,
    'pg_basebackup',
    '-D',
    '/backup/base',
    '-X',
    'stream',
    '-c',
    'fast',
  );

  console.log(`[pitr] writer: one committed marker every 200 ms for ${WRITE_SECONDS} s`);
  docker(
    'exec',
    '-d',
    P,
    'bash',
    '-c',
    `for i in $(seq 1 ${WRITE_SECONDS * 5}); do psql -U postgres -qtAc "INSERT INTO marker (pad) VALUES ('w')" >/dev/null; sleep 0.2; done`,
  );
  await new Promise((r) => setTimeout(r, (WRITE_SECONDS - 5) * 1000));
  const midTarget = psql(
    P,
    'postgres',
    "SELECT to_char((SELECT at FROM marker ORDER BY id DESC OFFSET 100 LIMIT 1) AT TIME ZONE 'UTC', 'YYYY-MM-DD HH24:MI:SS.US') || '+00'",
  );

  // The last commit the application could have seen acknowledged, read immediately before the crash.
  const lastCommitted = psql(
    P,
    'postgres',
    "SELECT max(id) || '|' || to_char(max(at) AT TIME ZONE 'UTC', 'YYYY-MM-DD\"T\"HH24:MI:SS.MS\"Z\"') FROM marker",
  );
  docker('kill', '-s', 'KILL', P);
  const crashAt = new Date();
  console.log('[pitr] primary killed; its data directory is treated as lost');
  const archived = Number(
    docker(
      'run',
      '--rm',
      '-v',
      'cbr-pitr-archive:/archive',
      IMAGE,
      'bash',
      '-c',
      'ls /archive | wc -l',
    ),
  );

  console.log('[pitr] recovering to end of archive');
  const recoverMs = await recoverInto(null);
  const recovered = psql(
    R,
    'postgres',
    "SELECT max(id) || '|' || to_char(max(at) AT TIME ZONE 'UTC', 'YYYY-MM-DD\"T\"HH24:MI:SS.MS\"Z\"') FROM marker",
  );
  const [lcId, lcAt] = lastCommitted.split('|');
  const [rcId, rcAt] = recovered.split('|');
  const rpoSeconds = seconds(new Date(lcAt).getTime() - new Date(rcAt).getTime());

  console.log(`[pitr] recovering to a point in time (${midTarget})`);
  const pitrMs = await recoverInto(midTarget);
  const atTarget = psql(R, 'postgres', `SELECT count(*) FROM marker WHERE at > '${midTarget}'`);
  const maxAtTarget = psql(
    R,
    'postgres',
    "SELECT to_char(max(at) AT TIME ZONE 'UTC', 'YYYY-MM-DD HH24:MI:SS.US') || '+00' FROM marker",
  );

  const result = {
    drill: 'pitr-wal-archive',
    ranAt: new Date().toISOString(),
    environment:
      'local Docker postgres:18.6 (Windows 11 laptop) — method validation, NOT the managed provider',
    archiveTimeoutSeconds: ARCHIVE_TIMEOUT,
    walSegmentsArchived: archived,
    crashAt: crashAt.toISOString(),
    lastCommittedBeforeCrash: { id: Number(lcId), at: lcAt },
    lastRecovered: { id: Number(rcId), at: rcAt },
    lostCommittedRows: Number(lcId) - Number(rcId),
    measuredRpoSeconds: rpoSeconds,
    recoverToEndOfArchiveSeconds: seconds(recoverMs),
    pointInTime: {
      target: midTarget,
      recoverSeconds: seconds(pitrMs),
      rowsAfterTarget: Number(atTarget),
      latestRowAt: maxAtTarget,
    },
    passed: rpoSeconds <= ARCHIVE_TIMEOUT + 5 && Number(atTarget) === 0,
  };
  writeFileSync('scripts/recovery/results/pitr.json', `${JSON.stringify(result, null, 2)}\n`);
  console.log(JSON.stringify(result, null, 2));
  if (!result.passed) process.exitCode = 1;
} finally {
  cleanup();
}
