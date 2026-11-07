// Unit tests (no database): the pool event log with a fake pool (an EventEmitter with counts).
import { EventEmitter } from 'node:events';
import { describe, expect, it } from 'vitest';
import { PoolEventLog } from './pool-events';

class FakePool extends EventEmitter {
  totalCount = 0;
  idleCount = 0;
  waitingCount = 0;
}

function setup(secrets: string[] = []) {
  const pool = new FakePool();
  const log = new PoolEventLog(
    pool,
    (h) => {
      pool.on('connect', h.connect);
      pool.on('remove', h.remove);
      pool.on('error', h.error);
    },
    secrets,
    () => '2026-10-22T12:01:30.000Z',
  );
  return { pool, log };
}

describe('PoolEventLog', () => {
  it('counts connects and removes and keeps the peak client count', () => {
    const { pool, log } = setup();
    for (let n = 1; n <= 5; n++) {
      pool.totalCount = n;
      pool.emit('connect');
    }
    // A closed connection replaced: remove, then connect again at 5.
    pool.totalCount = 4;
    pool.emit('remove');
    pool.totalCount = 5;
    pool.emit('connect');
    expect(log.summary()).toMatchObject({
      total: 5,
      peakTotal: 5,
      events: { connect: 6, remove: 1, error: 0 },
      errorSamples: [],
    });
    expect(log.firstError).toBeUndefined();
  });

  it('sample() raises the peak between events (e.g. inside every transaction)', () => {
    const { pool, log } = setup();
    pool.totalCount = 7;
    log.sample();
    expect(log.peakTotalCount).toBe(7);
    pool.totalCount = 2;
    log.sample();
    expect(log.peakTotalCount).toBe(7);
  });

  it('records error events with SQLSTATE (or null), pool counts, and keeps the first error', () => {
    const { pool, log } = setup(['s3cret']);
    pool.totalCount = 5;
    pool.idleCount = 5;
    const first = Object.assign(new Error('terminating connection due to administrator command'), {
      code: '57P01',
    });
    pool.emit('error', first);
    pool.emit(
      'error',
      new Error('Connection terminated unexpectedly: postgresql://crm_app:s3cret@h/db'),
    );
    expect(log.firstError).toBe(first);
    expect(log.errorSamples).toEqual([
      {
        atUtc: '2026-10-22T12:01:30.000Z',
        sqlstate: '57P01',
        message: 'Error: terminating connection due to administrator command',
        pool: { total: 5, idle: 5, waiting: 0 },
      },
      {
        atUtc: '2026-10-22T12:01:30.000Z',
        sqlstate: null,
        message: 'Error: Connection terminated unexpectedly: <url>',
        pool: { total: 5, idle: 5, waiting: 0 },
      },
    ]);
    expect(JSON.stringify(log.summary())).not.toContain('s3cret');
  });

  it('bounds error samples at 10 but counts every error', () => {
    const { pool, log } = setup();
    for (let k = 0; k < 15; k++) pool.emit('error', new Error(`e${k}`));
    expect(log.errors).toBe(15);
    expect(log.errorSamples).toHaveLength(10);
  });
});
