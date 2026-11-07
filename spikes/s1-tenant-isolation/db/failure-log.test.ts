// Unit tests (no database): S1-08 keeps every unexpected error, from transactions, from the
// unwrapped probe and from rejected workers, and never lets one turn into a pass.
import { describe, expect, it } from 'vitest';
import {
  FailureLog,
  describeError,
  scrub,
  secretsFromUrls,
  sqlstateOf,
  transactionStage,
} from './failure-log';

class Planned extends Error {}

/**
 * The S1-08 worker loop shape with injected transaction and probe steps (probe every 20th
 * iteration), followed by what the test does after Promise.allSettled.
 */
async function runWorkers(opts: {
  workers: number;
  iterations: number;
  tx: (w: number, i: number) => Promise<void>;
  probe: (w: number, i: number) => Promise<void>;
  outsideCapture?: (w: number, i: number) => void;
}) {
  const failures = new FailureLog();
  let done = 0;
  const worker = async (w: number) => {
    for (let i = 0; i < opts.iterations && !failures.stopping; i++) {
      try {
        await opts.tx(w, i);
        done++;
      } catch (e) {
        if (!(e instanceof Planned)) {
          failures.record(`w${w} i${i} transaction`, e);
          throw e;
        }
        done++;
      }
      opts.outsideCapture?.(w, i);
      if (i % 20 === 0) {
        try {
          await opts.probe(w, i);
        } catch (e) {
          failures.record(`w${w} i${i} unwrapped probe`, e, 'unwrapped probe');
          throw e;
        }
      }
      await Promise.resolve();
    }
  };
  const settled = await Promise.allSettled(
    Array.from({ length: opts.workers }, (_, w) => worker(w)),
  );
  failures.collectSettled(settled);
  return { failures, done };
}

const ok = async () => {};

describe('FailureLog in the S1-08 worker loop', () => {
  it('records nothing and completes the workload when nothing fails (planned rollbacks are not errors)', async () => {
    const { failures, done } = await runWorkers({
      workers: 5,
      iterations: 100,
      tx: async (w, i) => {
        if (i % 10 === 0) throw new Planned();
      },
      probe: ok,
    });
    expect(failures.first).toBeUndefined();
    expect(failures.count).toBe(0);
    expect(done).toBe(500);
  });

  it('records a probe failure, stops the other workers and keeps it as the error to re-throw', async () => {
    const boom = new Error('Timed out fetching a new connection from the connection pool');
    const { failures, done } = await runWorkers({
      workers: 5,
      iterations: 100,
      tx: ok,
      probe: async (w, i) => {
        if (w === 2 && i === 40) throw boom;
      },
    });
    expect(failures.first?.error).toBe(boom);
    expect(failures.count).toBe(1);
    expect(failures.samples).toHaveLength(1);
    expect(failures.samples[0]).toMatchObject({
      where: 'w2 i40 unwrapped probe',
      stage: 'unwrapped probe',
      errorClass: 'Error',
      sqlstate: null,
      message: 'Error: Timed out fetching a new connection from the connection pool',
    });
    expect(failures.stopping).toBe(true);
    expect(done).toBeLessThan(500); // the workload is not complete, so the count assertion fails
  });

  it('records a rejected worker whose error escaped the capture', async () => {
    const escaped = new TypeError('Cannot read properties of undefined');
    const { failures } = await runWorkers({
      workers: 3,
      iterations: 10,
      tx: ok,
      probe: ok,
      outsideCapture: (w, i) => {
        if (w === 1 && i === 3) throw escaped;
      },
    });
    expect(failures.first?.error).toBe(escaped);
    expect(failures.count).toBe(1);
    expect(failures.samples[0]).toMatchObject({
      where: 'w1 worker rejected outside the error capture',
      stage: 'worker (outside the error capture)',
      errorClass: 'TypeError',
      message: 'TypeError: Cannot read properties of undefined',
    });
  });

  it('keeps the chronologically first error and does not count a recorded rejection twice', async () => {
    const first = new Error('Unable to start a transaction in the given time.');
    const second = new Error('probe failed later');
    const { failures } = await runWorkers({
      workers: 2,
      iterations: 50,
      tx: async (w, i) => {
        if (w === 0 && i === 5) throw first;
      },
      probe: async (w, i) => {
        if (w === 1 && i === 20) throw second;
      },
    });
    // Worker 1 stops before its i=20 probe because worker 0 failed first.
    expect(failures.first?.error).toBe(first);
    expect(failures.count).toBe(1);
  });

  it('counts every error but keeps only the first 10 samples', () => {
    const log = new FailureLog();
    for (let k = 0; k < 25; k++) log.record(`w${k}`, new Error(`e${k}`));
    expect(log.count).toBe(25);
    expect(log.samples).toHaveLength(10);
    expect((log.first?.error as Error).message).toBe('e0');
  });

  it('records non-Error rejections and ignores fulfilled results', () => {
    const log = new FailureLog();
    log.collectSettled([
      { status: 'fulfilled', value: undefined },
      { status: 'rejected', reason: 'plain string' },
    ]);
    expect(log.count).toBe(1);
    expect(log.samples).toHaveLength(1);
    expect(log.samples[0]).toMatchObject({
      where: 'w1 worker rejected outside the error capture',
      errorClass: 'string',
      sqlstate: null,
      prismaCode: null,
      message: 'non-Error value: plain string',
    });
  });

  it('truncates very long messages', () => {
    expect(describeError(new Error('x'.repeat(2000))).length).toBeLessThan(520);
  });
});

// Shapes as thrown by pg, pg-pool and Prisma 7 with the pg driver adapter (synthetic objects).
class PrismaClientKnownRequestError extends Error {
  constructor(
    message: string,
    readonly code: string,
    readonly meta?: Record<string, unknown>,
  ) {
    super(message);
    this.name = 'PrismaClientKnownRequestError';
  }
}
const pgError = (message: string, code?: string) => Object.assign(new Error(message), { code });

describe('failure samples: stage, class, SQLSTATE and scrubbing', () => {
  it('extracts a SQLSTATE from pg errors, Prisma driver metadata or a cause, else null', () => {
    expect(sqlstateOf(pgError('terminating connection', '57P01'))).toBe('57P01');
    expect(
      sqlstateOf(new PrismaClientKnownRequestError('Raw query failed', 'P2010', { code: '25P03' })),
    ).toBe('25P03');
    expect(
      sqlstateOf(
        new PrismaClientKnownRequestError('x', 'P2010', { driverAdapterError: { code: '08006' } }),
      ),
    ).toBe('08006');
    expect(sqlstateOf(Object.assign(new Error('x'), { cause: { code: '53300' } }))).toBe('53300');
    // Absent or not a SQLSTATE: null, never guessed.
    expect(sqlstateOf(new Error('timeout exceeded when trying to connect'))).toBeNull();
    expect(sqlstateOf(new PrismaClientKnownRequestError('x', 'P2010', { code: 'N/A' }))).toBeNull();
    expect(sqlstateOf(pgError('x', 'ECONNRESET'))).toBeNull();
    expect(sqlstateOf('plain')).toBeNull();
    expect(sqlstateOf(null)).toBeNull();
  });

  it('records the Prisma code separately from the SQLSTATE', () => {
    const log = new FailureLog([], () => '2026-10-22T11:54:30.000Z');
    log.record(
      'w21 i30 transaction',
      new PrismaClientKnownRequestError('Server has closed the connection.', 'P2010', {
        code: 'N/A',
      }),
      'tenant context (set_config)',
      33_512.4,
    );
    expect(log.samples[0]).toEqual({
      atUtc: '2026-10-22T11:54:30.000Z',
      where: 'w21 i30 transaction',
      stage: 'tenant context (set_config)',
      errorClass: 'PrismaClientKnownRequestError',
      sqlstate: null,
      prismaCode: 'P2010',
      message: 'PrismaClientKnownRequestError: Server has closed the connection.',
      elapsedMs: 33_512,
    });
  });

  it('classifies only stages the error identifies; the rest is unknown', () => {
    expect(transactionStage(new Error('timeout exceeded when trying to connect'), false)).toBe(
      'acquisition (pg-pool wait for a connection)',
    );
    expect(
      transactionStage(
        new Error('Transaction API error: Unable to start a transaction in the given time.'),
        false,
      ),
    ).toBe('transaction start (Prisma maxWait)');
    expect(
      transactionStage(
        new PrismaClientKnownRequestError(
          'Invalid `prisma.$queryRawUnsafe()` invocation: Server has closed the connection.',
          'P2010',
        ),
        false,
      ),
    ).toBe('tenant context (set_config)');
    // Same failure without the invocation text: not attributable.
    expect(
      transactionStage(
        new PrismaClientKnownRequestError('Server has closed the connection.', 'P2010'),
        false,
      ),
    ).toBe('unknown (before the callback: acquisition, BEGIN or set_config)');
    expect(transactionStage(new Error('Connection terminated unexpectedly'), false)).toBe(
      'unknown (before the callback: acquisition, BEGIN or set_config)',
    );
    // Once the test's callback ran, acquisition, BEGIN and set_config had succeeded.
    expect(transactionStage(new Error('timeout exceeded when trying to connect'), true)).toBe(
      'query (inside the transaction callback)',
    );
  });

  it('removes connection strings and known passwords, and bounds the message', () => {
    const secrets = secretsFromUrls([
      'postgresql://crm_app:s3cr%2Fet@ep-x.example.invalid/crm_s1',
      undefined,
      'not a url',
    ]);
    expect(secrets).toEqual(['s3cr/et']);
    const text =
      'connect to postgresql://crm_app:s3cr%2Fet@ep-x.example.invalid/crm_s1 failed; ' +
      'password=hunter2; auth s3cr/et rejected';
    const out = scrub(text, secrets);
    expect(out).not.toMatch(/s3cr|hunter2|postgresql:/);
    expect(out).toContain('<url>');
    expect(out).toContain('password=***');
    const log = new FailureLog(secrets);
    log.record('w0 i0 transaction', new Error(`${text} ${'x'.repeat(2000)}`));
    expect(log.samples[0]!.message).not.toMatch(/s3cr|hunter2|postgresql:/);
    expect(log.samples[0]!.message.length).toBeLessThan(520);
  });
});

describe('SQLSTATE vs Prisma codes', () => {
  it('keeps PL/pgSQL P0 SQLSTATEs and rejects Prisma P1000–P6999 codes', () => {
    expect(sqlstateOf(pgError('raise', 'P0001'))).toBe('P0001');
    for (const c of ['P1001', 'P2010', 'P2028', 'P6000'])
      expect(sqlstateOf(pgError('x', c))).toBeNull();
  });
});
