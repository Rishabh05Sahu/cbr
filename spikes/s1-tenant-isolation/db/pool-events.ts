// S1-08 diagnostics: the client pool's own events (pg.Pool `connect`, `remove`, `error`), with
// the pool counts at the time, and the peak number of client connections. A reconnect after a
// closed connection shows up here as remove + connect. Error samples are scrubbed and bounded.
// A pool `error` event (an idle client's connection failed) is recorded here and the S1-08 test
// turns it into an unexpected error, so listening for it never hides a failure.
import { describeError, sqlstateOf } from './failure-log';

const ERROR_SAMPLE_LIMIT = 10;

export interface PoolCounts {
  readonly totalCount: number;
  readonly idleCount: number;
  readonly waitingCount: number;
}

export interface PoolHandlers {
  readonly connect: () => void;
  readonly remove: () => void;
  readonly error: (err: Error) => void;
}

export interface PoolErrorSample {
  readonly atUtc: string;
  readonly sqlstate: string | null;
  readonly message: string;
  readonly pool: { total: number; idle: number; waiting: number };
}

export class PoolEventLog {
  connects = 0;
  removes = 0;
  errors = 0;
  /** The first pool error event, for the test to re-throw. */
  firstError: Error | undefined;
  /** Highest pool.totalCount seen at a connect event or a sample() call. */
  peakTotalCount = 0;
  readonly errorSamples: PoolErrorSample[] = [];

  /** `subscribe` attaches the three handlers, e.g. `(h) => { pool.on('connect', h.connect); … }`. */
  constructor(
    private readonly pool: PoolCounts,
    subscribe: (handlers: PoolHandlers) => void,
    private readonly secrets: readonly string[] = [],
    private readonly nowUtc: () => string = () => new Date().toISOString(),
  ) {
    subscribe({
      connect: () => {
        this.connects++;
        this.sample();
      },
      remove: () => {
        this.removes++;
      },
      error: (err: Error) => {
        this.errors++;
        this.firstError ??= err;
        if (this.errorSamples.length < ERROR_SAMPLE_LIMIT)
          this.errorSamples.push({
            atUtc: this.nowUtc(),
            sqlstate: sqlstateOf(err),
            message: describeError(err, this.secrets),
            pool: this.counts(),
          });
      },
    });
  }

  counts() {
    return {
      total: this.pool.totalCount,
      idle: this.pool.idleCount,
      waiting: this.pool.waitingCount,
    };
  }

  /** Records the current totalCount in the peak (also called inside every transaction). */
  sample(): void {
    this.peakTotalCount = Math.max(this.peakTotalCount, this.pool.totalCount);
  }

  summary() {
    return {
      ...this.counts(),
      peakTotal: this.peakTotalCount,
      events: { connect: this.connects, remove: this.removes, error: this.errors },
      errorSamples: this.errorSamples,
    };
  }
}
