// S1-08 diagnostics (docs/NEON-S1-FAILURE-TRIAGE.md §1d): records every unexpected error of the
// concurrent workers, whether thrown by a transaction, by the unwrapped probe, or seen only as a
// rejected worker promise. Keeps the chronologically first error for the test to re-throw and
// tells the other workers to stop. Nothing here feeds an assertion or turns an error into a pass.
//
// Each sample is structured: UTC time, worker/iteration, stage, error class, SQLSTATE or
// driver/Prisma code where the error carries one (null otherwise, never guessed), and a message
// scrubbed of connection strings and known passwords, truncated to 500 characters.

const SAMPLE_LIMIT = 10;
const MESSAGE_LIMIT = 500;
// Five characters; Prisma codes (P1000–P6999) have the same shape but are not SQLSTATEs (the only
// PostgreSQL class starting with P is P0, PL/pgSQL).
const SQLSTATE = /^(?!P[1-9])[0-9A-Z]{5}$/;

/**
 * Where a transaction failed. Only what the error or the test's own markers show reliably;
 * anything else is "unknown".
 */
export type FailureStage =
  | 'acquisition (pg-pool wait for a connection)'
  | 'transaction start (Prisma maxWait)'
  | 'tenant context (set_config)'
  | 'query (inside the transaction callback)'
  | 'unwrapped probe'
  | 'worker (outside the error capture)'
  | 'unknown (before the callback: acquisition, BEGIN or set_config)';

export interface FailureSample {
  readonly atUtc: string;
  readonly where: string;
  readonly stage: FailureStage;
  readonly errorClass: string;
  /** PostgreSQL SQLSTATE, when the error (or its driver metadata) carries one. */
  readonly sqlstate: string | null;
  /** Prisma error code (e.g. P2010), when present. */
  readonly prismaCode: string | null;
  readonly message: string;
  /** Request to failure, ms (the whole observed duration, not only queue time). */
  readonly elapsedMs: number | null;
}

/** Passwords of the URLs the test uses; removed from every recorded message. */
export function secretsFromUrls(urls: readonly (string | undefined)[]): string[] {
  const out: string[] = [];
  for (const u of urls) {
    if (!u) continue;
    try {
      const p = decodeURIComponent(new URL(u).password);
      if (p) out.push(p);
    } catch {
      // not a URL: nothing to extract
    }
  }
  return out;
}

export function scrub(text: string, secrets: readonly string[] = []): string {
  let s = secrets.reduce((acc, x) => acc.split(x).join('***'), text);
  s = s.replace(/postgres(ql)?:\/\/[^\s'"`]+/gi, '<url>');
  s = s.replace(/(password\s*[=:]\s*)[^\s'"`;,]+/gi, '$1***');
  return s.length > MESSAGE_LIMIT ? `${s.slice(0, MESSAGE_LIMIT)}…` : s;
}

export function describeError(e: unknown, secrets: readonly string[] = []): string {
  const text = e instanceof Error ? `${e.name}: ${e.message}` : `non-Error value: ${String(e)}`;
  return scrub(text, secrets);
}

const get = (o: unknown, k: string): unknown =>
  typeof o === 'object' && o !== null ? (o as Record<string, unknown>)[k] : undefined;

/** SQLSTATE from a pg error (`code`), Prisma driver-adapter metadata or a cause; else null. */
export function sqlstateOf(e: unknown): string | null {
  for (const c of [
    get(e, 'code'),
    get(get(e, 'meta'), 'code'),
    get(get(get(e, 'meta'), 'driverAdapterError'), 'code'),
    get(get(e, 'cause'), 'code'),
    get(get(e, 'cause'), 'originalCode'),
  ])
    if (typeof c === 'string' && SQLSTATE.test(c)) return c;
  return null;
}

function prismaCodeOf(e: unknown): string | null {
  const c = get(e, 'code');
  return typeof c === 'string' && /^P\d{4}$/.test(c) ? c : null;
}

function errorClassOf(e: unknown): string {
  if (e instanceof Error) return e.constructor?.name || e.name;
  return e === null ? 'null' : typeof e;
}

/**
 * Stage of a failed withTenant() call. `callbackEntered`: the test's callback had started, so
 * acquisition, BEGIN and set_config had succeeded. Before that, only messages that a single
 * stage produces are classified; the rest are "unknown".
 */
export function transactionStage(e: unknown, callbackEntered: boolean): FailureStage {
  if (callbackEntered) return 'query (inside the transaction callback)';
  const message = e instanceof Error ? e.message : '';
  // pg-pool's own text, produced only while waiting for a pool connection.
  if (message === 'timeout exceeded when trying to connect')
    return 'acquisition (pg-pool wait for a connection)';
  if (/Unable to start a transaction in the given time/.test(message))
    return 'transaction start (Prisma maxWait)';
  // Before the callback, the only $queryRawUnsafe in with-tenant.ts is the tenant set_config.
  if (errorClassOf(e) === 'PrismaClientKnownRequestError' && /\$queryRawUnsafe\(\)/.test(message))
    return 'tenant context (set_config)';
  return 'unknown (before the callback: acquisition, BEGIN or set_config)';
}

export class FailureLog {
  /** Set by the first unexpected error; workers check it before each iteration. */
  stopping = false;
  /** The chronologically first unexpected error (re-thrown by the test). */
  first: { error: unknown } | undefined;
  /** Every unexpected error, uncapped. */
  count = 0;
  /** The first 10, structured. */
  readonly samples: FailureSample[] = [];
  private readonly recorded = new WeakSet<object>();

  constructor(
    private readonly secrets: readonly string[] = [],
    private readonly nowUtc: () => string = () => new Date().toISOString(),
  ) {}

  record(
    where: string,
    error: unknown,
    stage: FailureStage = 'worker (outside the error capture)',
    elapsedMs: number | null = null,
  ): void {
    this.stopping = true;
    this.first ??= { error };
    this.count++;
    if (typeof error === 'object' && error !== null) this.recorded.add(error);
    if (this.samples.length < SAMPLE_LIMIT)
      this.samples.push({
        atUtc: this.nowUtc(),
        where,
        stage,
        errorClass: errorClassOf(error),
        sqlstate: sqlstateOf(error),
        prismaCode: prismaCodeOf(error),
        message: describeError(error, this.secrets),
        elapsedMs: elapsedMs === null ? null : Math.round(elapsedMs),
      });
  }

  /**
   * Records rejected worker results whose error was not already recorded where it was thrown,
   * so no rejection is lost. Index = worker number.
   */
  collectSettled(results: readonly PromiseSettledResult<unknown>[]): void {
    results.forEach((r, w) => {
      if (r.status !== 'rejected') return;
      const reason: unknown = r.reason;
      if (typeof reason === 'object' && reason !== null && this.recorded.has(reason)) return;
      this.record(`w${w} worker rejected outside the error capture`, reason);
    });
  }
}
