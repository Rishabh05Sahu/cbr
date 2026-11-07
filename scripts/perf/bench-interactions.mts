// NFR-003 LOCAL benchmark of the interaction / outcome-sheet save (FR-083/084) on the ISOLATED
// crm_perf database, against a PRODUCTION build (docs/PHASE-3-NFR-003-BENCHMARK.md). A local
// indication only: formal NFR-003 acceptance is k6 on staging (M6 plan §3) and OD-02.
//
//   pnpm exec tsx scripts/perf/bench-interactions.mts <command> <accounts.json> <pools.json> <state-dir>
//
// Commands:
//   serve    start the built standalone server on 127.0.0.1:3200 against crm_perf (explicit
//            environment; nothing from .env except what is listed below), record its PID
//   inproc   L2 (logInteraction in-process) and L1 (its tenant transaction), S1–S5
//   http     L3 (the server action over HTTP, as the browser sends it, including the re-rendered
//            lead page), S1–S6. Needs <state-dir>/router-headers.json from the browser script
//   retry    identical and changed retries; side-effect counts before/after
//   load     open-loop arrival rates 0.2, 1, 2, 5, 10 saves/s (mixed S1–S4)
//   mixed    2 saves/s plus 10 reads/s (list, search, detail pages)
//   verify   duplicate and side-effect consistency checks over every phase's ledger
//   stop     stop the server by its recorded PID
//
// Levels: L1 = withTenant() for the save (pool wait, BEGIN, statements, triggers, COMMIT);
// L2 = logInteraction(); L3 = HTTP request sent → full response read. Percentiles are
// nearest-rank; the mean is only a secondary figure. Guards: free memory < 1.5 GB, error rate
// > 5 % (after 20 requests), rolling p95 > 5 s, or database errors stop the run (exit 3) and keep
// crm_perf and the state for diagnosis. Synthetic data only.
import { execFile, spawn } from 'node:child_process';
import { appendFileSync, cpSync, existsSync, openSync, readFileSync, writeFileSync } from 'node:fs';
import { cpus, freemem } from 'node:os';
import { createRequire } from 'node:module';
import { randomUUID, randomBytes } from 'node:crypto';
const req = createRequire('C:/Users/aDMIN/Desktop/CRM/package.json');
req('dotenv').config({ path: 'C:/Users/aDMIN/Desktop/CRM/.env', quiet: true });
const pg = req('pg') as typeof import('pg');

const PORT = 3200;
const SERVER = `http://127.0.0.1:${PORT}`;
const MIN_FREE_MB = Number(process.env.PERF_MIN_FREE_MB ?? 1536);
const [cmd, accountsPath, poolsPath, stateDir] = process.argv.slice(2) as [
  string,
  string,
  string,
  string,
];
if (!cmd || !accountsPath || !poolsPath || !stateDir) {
  console.log('usage: bench-interactions.mts <command> <accounts.json> <pools.json> <state-dir>');
  process.exit(2);
}
const statePath = (f: string) => `${stateDir}/${f}`;

/** crm_perf URL for a role, from the local crm_test URL of the same role (refuses others). */
const perf = (v: string) => {
  const u = new URL(process.env[v]!);
  if (u.hostname !== '127.0.0.1' || u.port !== '55432' || u.pathname !== '/crm_test')
    throw new Error(`${v} is not the local crm_test URL`);
  u.pathname = '/crm_perf';
  return u.toString();
};
const PERF = {
  DATABASE_URL: perf('TEST_DATABASE_URL'),
  AUTH_DATABASE_URL: perf('TEST_AUTH_DATABASE_URL'),
  PLATFORM_DATABASE_URL: perf('TEST_PLATFORM_DATABASE_URL'),
  MIGRATOR: perf('TEST_MIGRATOR_URL'),
};
const REDIS = `${(process.env.REDIS_URL ?? 'redis://127.0.0.1:56379').replace(/\/\d+$/, '')}/3`;
if (!/^redis:\/\/(127\.0\.0\.1|localhost):\d+\/3$/.test(REDIS))
  throw new Error('Redis is not local');

// Everything this process might reach goes to crm_perf / local services only.
const ENV_KEYS = readFileSync('C:/Users/aDMIN/Desktop/CRM/.env', 'utf8')
  .split('\n')
  .map((l) => /^([A-Z0-9_]+)=/.exec(l)?.[1])
  .filter((k): k is string => !!k);
for (const k of ENV_KEYS) if (/^(SUPABASE_|ACCEPTANCE_|S1_|S2_)/.test(k)) process.env[k] = '';
Object.assign(process.env, {
  DATABASE_URL: PERF.DATABASE_URL,
  AUTH_DATABASE_URL: PERF.AUTH_DATABASE_URL,
  PLATFORM_DATABASE_URL: PERF.PLATFORM_DATABASE_URL,
  DATABASE_MIGRATOR_URL: PERF.MIGRATOR,
  TEST_MIGRATOR_URL: PERF.MIGRATOR,
  CLEANUP_DATABASE_URL: '',
  REDIS_URL: REDIS,
  BETTER_AUTH_URL: SERVER,
  LOG_LEVEL: 'silent',
  // src/env.ts defaults (a blank value fails its validation); local configuration only.
  SUPABASE_IMPORT_BUCKET: 'crm-imports',
  IMPORT_MAX_BYTES: String(20 * 1024 * 1024),
});

const db = new pg.Client({ connectionString: PERF.MIGRATOR });
await db.connect();
{
  const r = (await db.query('SELECT current_database() d, current_user u, inet_server_port() p'))
    .rows[0];
  if (r.d !== 'crm_perf' || r.u !== 'crm_migrator')
    throw new Error('refusing: not crm_perf as crm_migrator');
}
const acc = JSON.parse(readFileSync(accountsPath, 'utf8'));
const pools = JSON.parse(readFileSync(poolsPath, 'utf8'));
const ROOT = 'file:///C:/Users/aDMIN/Desktop/CRM';

// ---------------------------------------------------------------------------------------------
// Shared helpers

const log = (...a: unknown[]) => console.log(new Date().toISOString().slice(11, 19), ...a);
const pct = (xs: number[], p: number) => {
  if (!xs.length) return null;
  const s = [...xs].sort((a, b) => a - b);
  return Math.round(s[Math.max(0, Math.ceil((p / 100) * s.length) - 1)]! * 10) / 10;
};
const summary = (ms: number[], errors: number, extra: Record<string, unknown> = {}) => {
  const n = ms.length + errors;
  return {
    n,
    ok: ms.length,
    errors,
    errorRate: n ? Math.round((errors / n) * 10_000) / 100 : null,
    p50: pct(ms, 50),
    p95: pct(ms, 95),
    p99: pct(ms, 99),
    max: ms.length ? Math.round(Math.max(...ms) * 10) / 10 : null,
    mean_secondary: ms.length
      ? Math.round((ms.reduce((a, b) => a + b, 0) / ms.length) * 10) / 10
      : null,
    p95Status: ms.length >= 100 ? 'reported' : 'INCONCLUSIVE (fewer than 100 samples)',
    p99Status: ms.length >= 1000 ? 'reported' : 'indicative (fewer than 1,000 samples)',
    ...extra,
  };
};
const results: Record<string, unknown> = existsSync(statePath('results.json'))
  ? JSON.parse(readFileSync(statePath('results.json'), 'utf8'))
  : {};
const saveResults = () =>
  writeFileSync(statePath('results.json'), JSON.stringify(results, null, 2));

/** Each pool lead is used once across every phase (cursor persisted after each take). */
const cursors: Record<string, number> = existsSync(statePath('cursors.json'))
  ? JSON.parse(readFileSync(statePath('cursors.json'), 'utf8'))
  : {};
type Item = { id: string; owner: string; taskId?: string; taskVersion?: number };
function take(scenario: 'S1' | 'S2' | 'S3' | 'S4'): Item {
  const i = cursors[scenario] ?? 0;
  const item = pools[scenario][i] as Item | undefined;
  if (!item) throw new Error(`pool ${scenario} exhausted at ${i}`);
  cursors[scenario] = i + 1;
  writeFileSync(statePath('cursors.json'), JSON.stringify(cursors));
  return item;
}
let heavyNext = 0;
const takeHeavy = (): Item => pools.S5[heavyNext++ % pools.S5.length];

interface Entry {
  phase: string;
  scenario: string;
  leadId: string;
  key: string;
  ok: boolean;
  code: string | null;
  duplicate: boolean | null;
  interactionId: string | null;
  ms: number | null;
  rerendered?: boolean;
  note?: string;
}
const ledger = (e: Entry) => appendFileSync(statePath('ledger.jsonl'), `${JSON.stringify(e)}\n`);

const versionOf = async (id: string) =>
  Number((await db.query('SELECT version FROM lead WHERE id = $1', [id])).rows[0].version);
const { orgLocalInputValue } = await import(`${ROOT}/src/modules/interactions/rules.ts`);
const local = (minutes: number) =>
  orgLocalInputValue(new Date(Date.now() + minutes * 60_000), pools.timeZone) as string;

type Scenario = 'S1' | 'S2' | 'S3' | 'S4' | 'S5';
/** The sheet's form fields for a scenario, as the browser sends them (strings). */
function fields(
  s: Scenario,
  it: Item,
  version: number,
  key = randomUUID(),
): Record<string, string> {
  const base = {
    leadId: it.id,
    idempotencyKey: key,
    version: String(version),
    channel: 'PHONE_NATIVE',
    direction: 'OUTBOUND',
    occurredAt: local(-2),
    requirementFields: '',
  };
  switch (s) {
    case 'S1':
    case 'S5':
      return { ...base, outcome: 'NO_ANSWER' };
    case 'S2':
      return {
        ...base,
        outcome: 'CONNECTED_INTERESTED',
        notes: 'Synthetic benchmark note',
        nextDueAt: local(24 * 60),
      };
    case 'S3':
      return {
        ...base,
        outcome: 'CONNECTED_CALL_BACK',
        notes: 'Synthetic benchmark note',
        followUpTaskId: it.taskId!,
        followUpVersion: String(it.taskVersion!),
        completeFollowUp: 'on',
        nextDueAt: local(2 * 24 * 60),
        nextTitle: 'Synthetic next step',
        requirementFields: 'intent,preferredCity',
        intent: 'WARM',
        preferredCity: 'Pune',
      };
    case 'S4':
      return {
        ...base,
        outcome: 'WRONG_NUMBER',
        confirmStatusChange: 'on',
        statusReason: 'Synthetic: wrong number',
      };
  }
}
const pick = (s: Scenario): Item =>
  s === 'S5' ? takeHeavy() : take(s as 'S1' | 'S2' | 'S3' | 'S4');

function memoryGuard(where: string) {
  const free = Math.round(freemem() / 1024 / 1024);
  if (free < MIN_FREE_MB) {
    results.abort = { where, freeMb: free, at: new Date().toISOString() };
    saveResults();
    log(`ABORT: free memory ${free} MB < ${MIN_FREE_MB} MB at ${where}; crm_perf kept`);
    process.exit(3);
  }
  return free;
}

// Resource samples every 10 s while a phase runs.
const samples: unknown[] = [];
let cpuPrev = cpus().map((c) => c.times);
const serverPid = existsSync(statePath('server.pid'))
  ? Number(readFileSync(statePath('server.pid'), 'utf8'))
  : null;
const sh = (file: string, args: string[]) =>
  new Promise<string>((res) =>
    execFile(file, args, { timeout: 8000 }, (_e, out) => res(String(out ?? ''))),
  );
function startSampler(label: string) {
  const t = setInterval(async () => {
    const now = cpus().map((c) => c.times);
    let busy = 0;
    let total = 0;
    now.forEach((c, i) => {
      const p = cpuPrev[i]!;
      const d = (k: keyof typeof c) => c[k] - p[k];
      const all = d('user') + d('nice') + d('sys') + d('idle') + d('irq');
      busy += all - d('idle');
      total += all;
    });
    cpuPrev = now;
    const rss = serverPid
      ? (await sh('tasklist', ['/FI', `PID eq ${serverPid}`, '/FO', 'CSV', '/NH'])).split('","')[4]
      : null;
    const pgStats = (
      await sh('docker', [
        'stats',
        '--no-stream',
        '--format',
        '{{.CPUPerc}} {{.MemUsage}}',
        'cbr-crm-postgres-1',
      ])
    ).trim();
    samples.push({
      label,
      at: new Date().toISOString().slice(11, 19),
      freeMb: Math.round(freemem() / 1024 / 1024),
      machineCpuPct: total ? Math.round((busy / total) * 100) : null,
      serverRss: rss?.replace(/"/g, '').trim() ?? null,
      postgres: pgStats,
    });
  }, 10_000);
  return () => {
    clearInterval(t);
    results[`resources:${label}`] = samples.filter((s) => (s as { label: string }).label === label);
    saveResults();
  };
}

// ---------------------------------------------------------------------------------------------
// serve / stop

if (cmd === 'serve') {
  if (!existsSync('.next/standalone/server.js')) throw new Error('run `pnpm build` first');
  if (serverPid) throw new Error(`a server PID is already recorded (${serverPid}); stop it first`);
  cpSync('.next/static', '.next/standalone/.next/static', { recursive: true });
  // Explicit environment: OS basics, then only what the app needs, pointing at crm_perf and local
  // services. Every other .env key is set to '' so a copied .env cannot supply it.
  const keep = [
    'SystemRoot',
    'SYSTEMROOT',
    'windir',
    'TEMP',
    'TMP',
    'PATH',
    'Path',
    'PATHEXT',
    'COMSPEC',
    'USERPROFILE',
    'LOCALAPPDATA',
    'APPDATA',
  ];
  const env: Record<string, string> = {};
  for (const k of keep) if (process.env[k]) env[k] = process.env[k]!;
  for (const k of ENV_KEYS) env[k] = '';
  Object.assign(env, {
    NODE_ENV: 'production',
    PORT: String(PORT),
    HOSTNAME: '127.0.0.1',
    DATABASE_URL: PERF.DATABASE_URL,
    AUTH_DATABASE_URL: PERF.AUTH_DATABASE_URL,
    PLATFORM_DATABASE_URL: PERF.PLATFORM_DATABASE_URL,
    REDIS_URL: REDIS,
    SMTP_HOST: '127.0.0.1',
    SMTP_PORT: '54025',
    EMAIL_FROM: 'CBR Bench <no-reply@bench.test>',
    BETTER_AUTH_URL: SERVER,
    BETTER_AUTH_SECRET: randomBytes(32).toString('hex'), // fresh: sessions only for this server
    LOG_LEVEL: 'warn',
    NEXT_TELEMETRY_DISABLED: '1',
    // src/env.ts defaults (a blank value fails its validation); local configuration only.
    SUPABASE_IMPORT_BUCKET: 'crm-imports',
    IMPORT_MAX_BYTES: String(20 * 1024 * 1024),
  });
  const check = Object.entries(env).filter(([, v]) => /postgres(ql)?:\/\//.test(v));
  for (const [k, v] of check)
    if (new URL(v).pathname !== '/crm_perf' || new URL(v).hostname !== '127.0.0.1')
      throw new Error(`refusing: ${k} does not point to local crm_perf`);
  const remote = Object.entries(env).filter(
    ([, v]) => /https?:\/\//.test(v) && !/127\.0\.0\.1|localhost/.test(v),
  );
  if (remote.length) throw new Error(`refusing: remote URL in ${remote.map(([k]) => k).join(',')}`);
  const out = openSync(statePath('server.log'), 'a');
  const child = spawn(process.execPath, ['.next/standalone/server.js'], {
    env,
    detached: true,
    stdio: ['ignore', out, out],
  });
  child.unref();
  writeFileSync(statePath('server.pid'), String(child.pid));
  const until = Date.now() + 60_000;
  let up = false;
  while (Date.now() < until && !up) {
    try {
      up = (await fetch(`${SERVER}/api/health`)).ok;
    } catch {
      await new Promise((r) => setTimeout(r, 500));
    }
  }
  if (!up) throw new Error('server did not become ready');
  results.server = {
    pid: child.pid,
    port: PORT,
    databases: check.map(
      ([k, v]) => `${k} -> ${new URL(v).username}@${new URL(v).host}${new URL(v).pathname}`,
    ),
    redis: REDIS,
    standaloneEnvFile: existsSync('.next/standalone/.env')
      ? 'present (all its keys overridden or blanked)'
      : 'absent',
    startedAt: new Date().toISOString(),
  };
  saveResults();
  log('SERVER', JSON.stringify(results.server));
  process.exit(0);
}
if (cmd === 'stop') {
  if (!serverPid) throw new Error('no recorded server PID');
  const r = await sh('taskkill', ['/PID', String(serverPid), '/T', '/F']);
  log('STOP', r.trim().split('\n')[0]);
  writeFileSync(statePath('server.pid.stopped'), String(serverPid));
  (await import('node:fs')).rmSync(statePath('server.pid'));
  process.exit(0);
}

// ---------------------------------------------------------------------------------------------
// inproc: L2 and L1

// S5 needs heavy-timeline leads owned by an executive; without any it is reported as not run.
const S_ALL: Scenario[] = pools.S5.length
  ? ['S1', 'S2', 'S3', 'S4', 'S5']
  : ['S1', 'S2', 'S3', 'S4'];
if (!pools.S5.length) results.S5 = 'not run: no heavy-timeline lead is owned by an executive';
if (cmd === 'inproc') {
  const f = await import(`${ROOT}/tests/support/factory.ts`);
  const ix = await import(`${ROOT}/src/modules/interactions/index.ts`);
  const { tenantRunner } = await import(`${ROOT}/src/platform/db/index.ts`);
  const runner = tenantRunner();
  const original = runner.withTenant.bind(runner);
  let l1: number[] = [];
  let recording = false;
  runner.withTenant = (async (c: unknown, fn: unknown, o: unknown) => {
    const t = performance.now();
    try {
      return await (original as (...a: unknown[]) => Promise<unknown>)(c, fn, o);
    } finally {
      if (recording) l1.push(performance.now() - t);
    }
  }) as typeof runner.withTenant;
  const actors = new Map<string, { ctx: unknown }>();
  const actor = async (userId: string) => {
    if (!actors.has(userId))
      actors.set(
        userId,
        await f.actorIn(
          { id: userId, email: pools.execEmails[userId], name: 'Synthetic exec' },
          pools.orgId,
        ),
      );
    return actors.get(userId)!;
  };
  const stop = startSampler('inproc');
  const out: Record<string, unknown> = {};
  for (const s of S_ALL) {
    const l2: number[] = [];
    const l1s: number[] = [];
    let errors = 0;
    for (let i = 0; i < 210; i++) {
      memoryGuard(`inproc ${s} #${i}`);
      const it = pick(s);
      const a = await actor(it.owner);
      const body = fields(s, it, await versionOf(it.id));
      l1 = [];
      recording = true;
      const t = performance.now();
      let ok = false;
      let res: { interactionId: string; duplicate: boolean } | null = null;
      let code: string | null = null;
      try {
        res = await ix.logInteraction(a.ctx, body);
        ok = true;
      } catch (e) {
        code = (e as { code?: string }).code ?? (e as Error).name;
      }
      const ms = performance.now() - t;
      recording = false;
      ledger({
        phase: 'inproc',
        scenario: s,
        leadId: it.id,
        key: body.idempotencyKey!,
        ok,
        code,
        duplicate: res?.duplicate ?? null,
        interactionId: res?.interactionId ?? null,
        ms: i < 10 ? null : ms,
        note: i < 10 ? 'warm-up' : undefined,
      });
      if (i < 10) continue;
      if (ok) {
        l2.push(ms);
        l1s.push(l1.reduce((x, y) => x + y, 0));
      } else errors++;
    }
    out[s] = { L2: summary(l2, errors), L1: summary(l1s, 0) };
    log('INPROC', s, JSON.stringify(out[s]));
  }
  stop();
  results.inproc = out;
  saveResults();
  process.exit(0);
}

// ---------------------------------------------------------------------------------------------
// HTTP helpers (L3)

// tests/e2e/http.ts calls a bare require() (CommonJS under Vitest); give it one under tsx ESM.
(globalThis as { require?: unknown }).require = req;
const http = await import(`${ROOT}/tests/e2e/http.ts`);
const { encodeReply } = req('next/dist/compiled/react-server-dom-turbopack/client.node.js') as {
  encodeReply: (v: unknown) => Promise<FormData | string>;
};
const ACTION = http.actionId('src/modules/interactions/actions.ts', 'logInteractionAction');
const routerPath = statePath('router-headers.json');
const router = existsSync(routerPath)
  ? (JSON.parse(readFileSync(routerPath, 'utf8')) as {
      leadId: string;
      headers: Record<string, string>;
    })
  : null;
const browsers = new Map<string, InstanceType<typeof http.Browser>>();
async function browserFor(userId: string, email = pools.execEmails[userId]) {
  if (!browsers.has(userId)) {
    const b = new http.Browser(SERVER);
    b.base = SERVER;
    const r = await b.signIn(email, acc.password);
    if (r.status !== 200) throw new Error(`sign-in failed for a synthetic account (${r.status})`);
    const active = await b.authPost('/organization/set-active', { organizationId: pools.orgId });
    if (active.status !== 200)
      throw new Error(`set-active failed for a synthetic account (${active.status})`);
    browsers.set(userId, b);
  }
  return browsers.get(userId)!;
}
/** The browser's next-router headers for this lead's page (calibrated; lead id substituted). */
const pageHeaders = (leadId: string): Record<string, string> =>
  router
    ? Object.fromEntries(
        Object.entries(router.headers).map(([k, v]) => [k, v.split(router.leadId).join(leadId)]),
      )
    : {};
interface Prepared {
  s: Scenario;
  it: Item;
  fields: Record<string, string>;
  body: FormData | string;
  b: InstanceType<typeof http.Browser>;
}
async function prepare(
  s: Scenario,
  it = pick(s),
  version?: number,
  key?: string,
): Promise<Prepared> {
  const fl = fields(s, it, version ?? (await versionOf(it.id)), key);
  const fd = new FormData();
  for (const [k, v] of Object.entries(fl)) fd.append(k, v);
  return { s, it, fields: fl, body: await encodeReply([null, fd]), b: await browserFor(it.owner) };
}
/** One timed save: request sent → full response read (L3). */
async function send(p: Prepared, timeoutMs = 5000) {
  const ac = new AbortController();
  const timer = setTimeout(() => ac.abort(), timeoutMs);
  const t = performance.now();
  try {
    const res = await p.b.fetch(`/app/leads/${p.it.id}`, {
      method: 'POST',
      headers: { 'next-action': ACTION, accept: 'text/x-component', ...pageHeaders(p.it.id) },
      body: p.body,
      signal: ac.signal,
    });
    const text = await res.text();
    const ms = performance.now() - t;
    const r = http.parseActionResult(text) as {
      ok: boolean | null;
      code: string | null;
      data?: { duplicate?: boolean; interactionId?: string };
    };
    return {
      ms,
      status: res.status,
      ok: res.status === 200 && r.ok === true,
      code: r.code ?? (res.status === 200 ? null : `HTTP_${res.status}`),
      duplicate: r.data?.duplicate ?? null,
      interactionId: r.data?.interactionId ?? null,
      rerendered: text.includes('Logged by user'),
      bytes: text.length,
    };
  } catch (e) {
    return {
      ms: performance.now() - t,
      status: 0,
      ok: false,
      code: (e as Error).name === 'AbortError' ? 'TIMEOUT' : 'NETWORK',
      duplicate: null,
      interactionId: null,
      rerendered: false,
      bytes: 0,
    };
  } finally {
    clearTimeout(timer);
  }
}

if (cmd === 'http') {
  if (!router) throw new Error('router-headers.json missing: run the browser calibration first');
  const stop = startSampler('http');
  const out: Record<string, unknown> = {};
  for (const s of S_ALL) {
    const n = s === 'S2' ? 1010 : 210;
    const ms: number[] = [];
    let errors = 0;
    let rerendered = 0;
    let bytes = 0;
    for (let i = 0; i < n; i++) {
      memoryGuard(`http ${s} #${i}`);
      const p = await prepare(s);
      const r = await send(p);
      ledger({
        phase: 'http',
        scenario: s,
        leadId: p.it.id,
        key: p.fields.idempotencyKey!,
        ok: r.ok,
        code: r.code,
        duplicate: r.duplicate,
        interactionId: r.interactionId,
        ms: i < 10 ? null : r.ms,
        rerendered: r.rerendered,
        note: i < 10 ? 'warm-up' : undefined,
      });
      if (i < 10) continue;
      if (r.ok) {
        ms.push(r.ms);
        if (r.rerendered) rerendered++;
        bytes += r.bytes;
      } else errors++;
      if (errors > 5 && errors / (i - 9) > 0.05) {
        results.abort = { where: `http ${s}`, errors, at: i };
        saveResults();
        log('ABORT: error rate > 5 %');
        process.exit(3);
      }
    }
    out[s] = summary(ms, errors, {
      rerenderedResponses: `${rerendered}/${ms.length}`,
      meanResponseKB: ms.length ? Math.round(bytes / ms.length / 102.4) / 10 : null,
    });
    log('HTTP', s, JSON.stringify(out[s]));
  }
  // S6: five saves at once on the same lead (distinct keys): expected to queue on the lead lock.
  const s6: number[] = [];
  let s6err = 0;
  for (let round = 0; round < 22; round++) {
    memoryGuard(`http S6 #${round}`);
    const it = take('S1');
    const v = await versionOf(it.id);
    const ps = await Promise.all([0, 1, 2, 3, 4].map(() => prepare('S1', it, v)));
    const rs = await Promise.all(ps.map((p) => send(p, 10_000)));
    rs.forEach((r, k) =>
      ledger({
        phase: 'http',
        scenario: 'S6',
        leadId: it.id,
        key: ps[k]!.fields.idempotencyKey!,
        ok: r.ok,
        code: r.code,
        duplicate: r.duplicate,
        interactionId: r.interactionId,
        ms: round < 2 ? null : r.ms,
        note: round < 2 ? 'warm-up' : undefined,
      }),
    );
    if (round < 2) continue;
    for (const r of rs) {
      if (r.ok) s6.push(r.ms);
      else s6err++;
    }
  }
  out.S6 = summary(s6, s6err, {
    note: '5 concurrent saves on one lead, 20 rounds (informational)',
  });
  log('HTTP', 'S6', JSON.stringify(out.S6));
  stop();
  results.http = out;
  saveResults();
  process.exit(0);
}

// ---------------------------------------------------------------------------------------------
// retry: identical and changed retries; nothing may be written twice

async function counts(leadId: string) {
  const r = (
    await db.query(
      `SELECT (SELECT count(*) FROM interaction WHERE lead_id = $1) i,
              (SELECT count(*) FROM lead_activity WHERE lead_id = $1) a,
              (SELECT count(*) FROM lead_stage_history WHERE lead_id = $1) h,
              (SELECT count(*) FROM task WHERE lead_id = $1) t,
              (SELECT count(*) FROM lead_contact_status_event WHERE lead_id = $1) e,
              (SELECT count(*) FROM audit_log WHERE entity_id = $1) au,
              (SELECT version FROM lead WHERE id = $1) v`,
      [leadId],
    )
  ).rows[0];
  return JSON.stringify(r);
}
if (cmd === 'retry') {
  if (!router) throw new Error('router-headers.json missing');
  const out = {
    sequential: { n: 0, pass: 0, fail: [] as string[] },
    concurrent: { n: 0, pass: 0, fail: [] as string[] },
    changed: { n: 0, pass: 0, fail: [] as string[] },
  };
  for (let i = 0; i < 100; i++) {
    memoryGuard(`retry seq ${i}`);
    const p = await prepare(i % 2 ? 'S2' : 'S1');
    const first = await send(p);
    const before = await counts(p.it.id);
    const again = await send(p);
    const after = await counts(p.it.id);
    ledger({
      phase: 'retry',
      scenario: `${p.s}-first`,
      leadId: p.it.id,
      key: p.fields.idempotencyKey!,
      ok: first.ok,
      code: first.code,
      duplicate: first.duplicate,
      interactionId: first.interactionId,
      ms: first.ms,
    });
    ledger({
      phase: 'retry',
      scenario: `${p.s}-identical`,
      leadId: p.it.id,
      key: p.fields.idempotencyKey!,
      ok: again.ok,
      code: again.code,
      duplicate: again.duplicate,
      interactionId: again.interactionId,
      ms: again.ms,
    });
    out.sequential.n++;
    if (
      first.ok &&
      again.ok &&
      again.duplicate === true &&
      again.interactionId === first.interactionId &&
      before === after
    )
      out.sequential.pass++;
    else out.sequential.fail.push(p.it.id);
  }
  for (let i = 0; i < 50; i++) {
    memoryGuard(`retry conc ${i}`);
    const p = await prepare('S2');
    const rs = await Promise.all([send(p, 10_000), send(p, 10_000), send(p, 10_000)]);
    rs.forEach((r) =>
      ledger({
        phase: 'retry',
        scenario: 'S2-concurrent',
        leadId: p.it.id,
        key: p.fields.idempotencyKey!,
        ok: r.ok,
        code: r.code,
        duplicate: r.duplicate,
        interactionId: r.interactionId,
        ms: r.ms,
      }),
    );
    const c = JSON.parse(await counts(p.it.id));
    const firsts = rs.filter((r) => r.ok && r.duplicate === false).length;
    const dups = rs.filter((r) => r.ok && r.duplicate === true).length;
    const hist = Number(
      (
        await db.query(
          `SELECT count(*) n FROM lead_stage_history WHERE lead_id = $1 AND reason_code = 'FIRST_CONNECTED_INTERACTION'`,
          [p.it.id],
        )
      ).rows[0].n,
    );
    const open = Number(
      (
        await db.query(`SELECT count(*) n FROM task WHERE lead_id = $1 AND status = 'OPEN'`, [
          p.it.id,
        ])
      ).rows[0].n,
    );
    out.concurrent.n++;
    if (firsts === 1 && dups === 2 && Number(c.i) === 1 && hist === 1 && open === 1)
      out.concurrent.pass++;
    else
      out.concurrent.fail.push(
        `${p.it.id} firsts=${firsts} dups=${dups} i=${c.i} hist=${hist} open=${open}`,
      );
  }
  for (let i = 0; i < 20; i++) {
    memoryGuard(`retry changed ${i}`);
    const p = await prepare('S2');
    const first = await send(p);
    const before = await counts(p.it.id);
    const changed = await prepare('S2', p.it, Number(p.fields.version), p.fields.idempotencyKey);
    const fd = new FormData();
    for (const [k, v] of Object.entries({ ...changed.fields, outcome: 'CONNECTED_CALL_BACK' }))
      fd.append(k, v);
    changed.body = await encodeReply([null, fd]);
    const r = await send(changed);
    const after = await counts(p.it.id);
    ledger({
      phase: 'retry',
      scenario: 'S2-first',
      leadId: p.it.id,
      key: p.fields.idempotencyKey!,
      ok: first.ok,
      code: first.code,
      duplicate: first.duplicate,
      interactionId: first.interactionId,
      ms: first.ms,
    });
    ledger({
      phase: 'retry',
      scenario: 'S2-changed',
      leadId: p.it.id,
      key: p.fields.idempotencyKey!,
      ok: r.ok,
      code: r.code,
      duplicate: r.duplicate,
      interactionId: r.interactionId,
      ms: r.ms,
    });
    out.changed.n++;
    if (first.ok && !r.ok && r.code === 'CONFLICT' && before === after) out.changed.pass++;
    else out.changed.fail.push(`${p.it.id} code=${r.code}`);
  }
  results.retry = out;
  saveResults();
  log('RETRY', JSON.stringify(out));
  process.exit(
    out.sequential.fail.length + out.concurrent.fail.length + out.changed.fail.length ? 4 : 0,
  );
}

// ---------------------------------------------------------------------------------------------
// load (open loop) and mixed

const MIX: Scenario[] = ['S1', 'S2', 'S1', 'S3', 'S1', 'S2', 'S4', 'S1', 'S2', 'S3']; // 40/30/20/10
async function openLoop(
  label: string,
  rate: number,
  warmupS: number,
  timedS: number,
  reads?: { rate: number },
) {
  const total = Math.round(rate * (warmupS + timedS));
  const warm = Math.round(rate * warmupS);
  log(`LOAD ${label}: preparing ${total} saves`);
  const prepared: Prepared[] = [];
  for (let i = 0; i < total; i++) prepared.push(await prepare(MIX[i % MIX.length]!));
  // Reads (mixed phase): list 60 %, search 25 %, detail 15 %, as the manager and executives.
  const readers = reads
    ? [
        await browserFor(pools.manager.id, pools.manager.email),
        ...(await Promise.all(
          Object.keys(pools.execEmails)
            .slice(0, 4)
            .map((u) => browserFor(u)),
        )),
      ]
    : [];
  const readPaths = (i: number) => {
    const r = i % 20;
    if (r < 12)
      return [
        '/app/leads',
        '/app/leads?stage=CONTACTED',
        '/app/leads?city=Pune',
        '/app/leads?sort=oldest',
      ][i % 4]!;
    if (r < 17)
      return [`/app/leads?q=Sharma`, `/app/leads?q=98${String(1000 + (i % 9000))}`][i % 2]!;
    return `/app/leads/${pools.S1[(i * 7) % pools.S1.length].id}`;
  };
  const saveMs: number[] = [];
  const serviceMs: number[] = [];
  let errors = 0;
  let retried = 0;
  const readMs: Record<string, number[]> = { list: [], search: [], detail: [] };
  let readErrors = 0;
  const stop = startSampler(label);
  const t0 = performance.now() + 1000;
  const recent: number[] = [];
  let aborted: string | null = null;
  const inflight: Promise<void>[] = [];
  const at = (ms: number) => new Promise((r) => setTimeout(r, Math.max(0, ms - performance.now())));
  const saveTasks = prepared.map((p, i) =>
    (async () => {
      const scheduled = t0 + (i / rate) * 1000;
      await at(scheduled);
      if (aborted) return;
      let r = await send(p);
      let note: string | undefined;
      if (r.code === 'TIMEOUT' || r.code === 'NETWORK') {
        // A client retry with the same key (the real retry path); must not duplicate.
        retried++;
        note = `retried after ${r.code}`;
        r = await send(p);
      }
      const latency = performance.now() - scheduled; // from the scheduled time (no coordinated omission)
      const timed = i >= warm;
      ledger({
        phase: label,
        scenario: p.s,
        leadId: p.it.id,
        key: p.fields.idempotencyKey!,
        ok: r.ok,
        code: r.code,
        duplicate: r.duplicate,
        interactionId: r.interactionId,
        ms: timed ? latency : null,
        note: timed ? note : 'warm-up',
      });
      if (!timed) return;
      if (r.ok) {
        saveMs.push(latency);
        serviceMs.push(r.ms);
        recent.push(latency);
        if (recent.length > 50) recent.shift();
      } else errors++;
      const done = saveMs.length + errors;
      if (done >= 20 && errors / done > 0.05) aborted = 'error rate > 5 %';
      if (recent.length >= 50 && (pct(recent, 95) ?? 0) > 5000) aborted = 'rolling p95 > 5 s';
      if (freemem() / 1024 / 1024 < MIN_FREE_MB) aborted = 'free memory below floor';
    })(),
  );
  inflight.push(...saveTasks);
  if (reads) {
    const n = Math.round(reads.rate * (warmupS + timedS));
    const rw = Math.round(reads.rate * warmupS);
    for (let i = 0; i < n; i++)
      inflight.push(
        (async () => {
          const scheduled = t0 + (i / reads.rate) * 1000;
          await at(scheduled);
          if (aborted) return;
          const path = readPaths(i);
          const kind = path.startsWith('/app/leads/')
            ? 'detail'
            : path.includes('q=')
              ? 'search'
              : 'list';
          try {
            const res = await readers[i % readers.length]!.get(path);
            await res.text();
            if (i >= rw) {
              if (res.status === 200) readMs[kind]!.push(performance.now() - scheduled);
              else readErrors++;
            }
          } catch {
            if (i >= rw) readErrors++;
          }
        })(),
      );
  }
  await Promise.all(inflight);
  stop();
  const elapsedTimed = timedS;
  const res = {
    targetRate: rate,
    achievedRate: Math.round(((saveMs.length + errors) / elapsedTimed) * 100) / 100,
    warmupSeconds: warmupS,
    timedSeconds: timedS,
    retriedAfterTimeout: retried,
    L3_fromScheduledTime: summary(saveMs, errors),
    L3_serviceTime: summary(serviceMs, 0),
    ...(reads
      ? {
          reads: {
            targetRate: reads.rate,
            errors: readErrors,
            list: summary(readMs.list!, 0),
            search: summary(readMs.search!, 0),
            detail: summary(readMs.detail!, 0),
          },
        }
      : {}),
    aborted,
  };
  log(`LOAD ${label}`, JSON.stringify(res));
  return res;
}

if (cmd === 'load') {
  if (!router) throw new Error('router-headers.json missing');
  const plan: [string, number, number, number][] = [
    ['rate-0.2', 0.2, 30, 600],
    ['rate-1', 1, 15, 300],
    ['rate-2', 2, 15, 150],
    ['rate-5', 5, 15, 60],
    ['rate-10', 10, 15, 60],
  ];
  const out: Record<string, unknown> = (results.load as Record<string, unknown>) ?? {};
  for (const [label, rate, w, t] of plan) {
    if (out[label]) continue; // resumable
    memoryGuard(`load ${label}`);
    const r = await openLoop(label, rate, w, t);
    out[label] = r;
    results.load = out;
    saveResults();
    if (r.aborted) {
      log(`STOP: ${label} aborted (${r.aborted}); crm_perf kept`);
      process.exit(3);
    }
  }
  process.exit(0);
}
if (cmd === 'mixed') {
  if (!router) throw new Error('router-headers.json missing');
  memoryGuard('mixed');
  const r = await openLoop('mixed', 2, 15, 150, { rate: 10 });
  results.mixed = r;
  saveResults();
  process.exit(r.aborted ? 3 : 0);
}

// ---------------------------------------------------------------------------------------------
// verify: duplicates and side effects over the whole ledger

if (cmd === 'verify') {
  const entries = readFileSync(statePath('ledger.jsonl'), 'utf8')
    .trim()
    .split('\n')
    .map((l) => JSON.parse(l) as Entry);
  const firsts = entries.filter((e) => e.ok && e.duplicate === false);
  const byKey = new Map<string, Entry[]>();
  for (const e of entries) byKey.set(e.key, [...(byKey.get(e.key) ?? []), e]);
  const keys = [...byKey.keys()];
  const failures: string[] = [];
  const rows = (
    await db.query(
      `SELECT client_idempotency_key k, id, lead_id, request_fingerprint fp FROM interaction WHERE client_idempotency_key = ANY($1::uuid[])`,
      [keys],
    )
  ).rows as { k: string; id: string; lead_id: string; fp: string | null }[];
  const rowByKey = new Map(rows.map((r) => [r.k, r]));
  for (const [k, es] of byKey) {
    const savedOnce = es.some((e) => e.ok && e.duplicate === false);
    const row = rowByKey.get(k);
    if (savedOnce && !row) failures.push(`key ${k}: reported saved, no row`);
    if (!savedOnce && row && !es.some((e) => e.code === 'TIMEOUT' || e.code === 'NETWORK'))
      failures.push(`key ${k}: row without a reported save`);
    if (es.filter((e) => e.ok && e.duplicate === false).length > 1)
      failures.push(`key ${k}: saved twice`);
    if (row && !row.fp) failures.push(`key ${k}: no fingerprint`);
  }
  const ids = rows.map((r) => r.id);
  const timeline = Number(
    (
      await db.query(
        `SELECT count(*) n FROM lead_activity WHERE type = 'INTERACTION' AND ref_id = ANY($1::uuid[])`,
        [ids],
      )
    ).rows[0].n,
  );
  if (timeline !== ids.length)
    failures.push(`timeline rows ${timeline} != interactions ${ids.length}`);
  const leadsOf = (pred: (e: Entry) => boolean) => [
    ...new Set(firsts.filter(pred).map((e) => e.leadId)),
  ];
  const s2 = leadsOf((e) => e.scenario.startsWith('S2'));
  const s2bad = (
    await db.query(
      `SELECT l.id FROM lead l WHERE l.id = ANY($1::uuid[]) AND (l.stage <> 'CONTACTED' OR l.first_contacted_at IS NULL OR (SELECT count(*) FROM lead_stage_history h WHERE h.lead_id = l.id AND h.reason_code = 'FIRST_CONNECTED_INTERACTION') <> 1)`,
      [s2],
    )
  ).rows;
  if (s2bad.length) failures.push(`S2 leads with a wrong stage/milestone/history: ${s2bad.length}`);
  const s3 = leadsOf((e) => e.scenario === 'S3');
  const s3bad = (
    await db.query(
      `SELECT l.id FROM lead l WHERE l.id = ANY($1::uuid[]) AND ((SELECT count(*) FROM task t WHERE t.lead_id = l.id AND t.status = 'OPEN') <> 1 OR (SELECT count(*) FROM task t WHERE t.lead_id = l.id AND t.status = 'DONE') <> 1 OR (SELECT count(*) FROM lead_activity a WHERE a.lead_id = l.id AND a.type = 'FIELD_CHANGED') > 1 OR l.intent IS DISTINCT FROM 'WARM' OR l.preferred_city IS DISTINCT FROM 'Pune')`,
      [s3],
    )
  ).rows;
  if (s3bad.length) failures.push(`S3 leads with wrong follow-ups/requirements: ${s3bad.length}`);
  const s4 = leadsOf((e) => e.scenario === 'S4');
  const s4bad = (
    await db.query(
      `SELECT l.id FROM lead l WHERE l.id = ANY($1::uuid[]) AND (l.contact_status <> 'INVALID' OR (SELECT count(*) FROM lead_contact_status_event e WHERE e.lead_id = l.id) <> 1)`,
      [s4],
    )
  ).rows;
  if (s4bad.length) failures.push(`S4 leads with wrong contact status events: ${s4bad.length}`);
  const s1 = leadsOf((e) => e.scenario.startsWith('S1') || e.scenario === 'S6');
  const s1bad = (
    await db.query(
      `SELECT count(*) n FROM lead_stage_history WHERE lead_id = ANY($1::uuid[]) AND reason_code = 'FIRST_CONNECTED_INTERACTION'`,
      [s1],
    )
  ).rows[0].n;
  if (Number(s1bad)) failures.push(`S1 leads with an unexpected stage change: ${s1bad}`);
  const v = {
    requests: entries.length,
    distinctKeys: keys.length,
    savedInteractions: rows.length,
    duplicatesAnswered: entries.filter((e) => e.duplicate === true).length,
    refused: entries
      .filter((e) => !e.ok)
      .map((e) => e.code)
      .reduce((m: Record<string, number>, c) => ((m[c ?? '?'] = (m[c ?? '?'] ?? 0) + 1), m), {}),
    leadsChecked: { S1: s1.length, S2: s2.length, S3: s3.length, S4: s4.length },
    failures,
    result: failures.length ? 'FAIL' : 'PASS',
  };
  results.verify = v;
  saveResults();
  log('VERIFY', JSON.stringify(v));
  process.exit(failures.length ? 4 : 0);
}

console.log(`unknown command ${cmd}`);
process.exit(2);
