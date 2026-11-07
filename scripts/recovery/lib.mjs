// Shared helpers for the local recovery drills (Docker CLI, no shell path conversion issues).
import { spawnSync } from 'node:child_process';

export function sh(cmd, args, { input, allowFail = false } = {}) {
  const r = spawnSync(cmd, args, { encoding: 'utf8', input, maxBuffer: 64 * 1024 * 1024 });
  if (r.status !== 0 && !allowFail) {
    throw new Error(`${cmd} ${args.join(' ')} failed (${r.status}): ${r.stderr || r.stdout}`);
  }
  return (r.stdout ?? '').trim();
}

export const docker = (...args) => sh('docker', args);
export const dockerMaybe = (...args) => sh('docker', args, { allowFail: true });

export function psql(container, db, sql, user = 'postgres') {
  return docker(
    'exec',
    '-i',
    container,
    'psql',
    '-U',
    user,
    '-d',
    db,
    '-v',
    'ON_ERROR_STOP=1',
    '-qtA',
    '-c',
    sql,
  );
}

export async function waitReady(container, ms = 120_000) {
  const until = Date.now() + ms;
  while (Date.now() < until) {
    const r = spawnSync('docker', ['exec', container, 'pg_isready', '-U', 'postgres'], {
      encoding: 'utf8',
    });
    if (r.status === 0) {
      // pg_isready can succeed during recovery; require a writable primary.
      const q = spawnSync(
        'docker',
        ['exec', container, 'psql', '-U', 'postgres', '-qtA', '-c', 'select pg_is_in_recovery()'],
        { encoding: 'utf8' },
      );
      if (q.status === 0 && q.stdout.trim() === 'f') return;
    }
    await new Promise((res) => setTimeout(res, 250));
  }
  throw new Error(`${container} not ready within ${ms} ms`);
}

export const seconds = (ms) => Math.round(ms / 10) / 100;
