// M6 P-E acceptance, end to end: the per-organisation lead text-search budget (10 per second,
// src/platform/rate-limit/search-budget.ts) enforced by the BUILT app's proxy, on the real local
// test Valkey (db 1). Three web processes: the suite's main server, a second instance sharing
// the same Valkey (the budget is shared across processes), and a third whose Valkey is
// unreachable (the budget fails closed). Synthetic data only.
//
// Timing: every test starts from an empty window (its organisation's key is deleted first), and
// a wait for the window to free up is computed from Valkey's own clock and the recorded request
// times (no guessed sleeps).
import type { ChildProcess } from 'node:child_process';
import { Redis } from 'ioredis';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { migrator } from '../support/db';
import { PASSWORD, seedOrg } from '../support/factory';
import { Browser } from './http';
import { spawnWeb } from './server';

const SECOND = 3101;
const NO_VALKEY = 3102;
const MARK = 'Zqx7731';

let A: Awaited<ReturnType<typeof seedOrg>>;
let B: Awaited<ReturnType<typeof seedOrg>>;
let ownerA: Browser;
let ownerB: Browser;
const extra: ChildProcess[] = [];
// The test Valkey database the servers use (tests/setup/test-env.ts sets db 1 as they do).
const valkey = new Redis(process.env.REDIS_URL!, { maxRetriesPerRequest: 1 });
const key = (orgId: string) => `rl:lead-search:org:${orgId}`;

async function browserFor(user: { email: string }, orgId: string): Promise<Browser> {
  const b = new Browser();
  expect((await b.signIn(user.email, PASSWORD)).status).toBe(200);
  expect((await b.authPost('/organization/set-active', { organizationId: orgId })).status).toBe(
    200,
  );
  return b;
}

/** The same signed-in session, sent to another server instance. */
function at(b: Browser, port: number): Browser {
  const c = new Browser();
  for (const [k, v] of b.jar) c.jar.set(k, v);
  c.base = `http://127.0.0.1:${port}`;
  return c;
}

const search = (b: Browser, q = MARK) => b.get(`/app/leads?q=${encodeURIComponent(q)}`);
const burst = (b: Browser | Browser[], n: number, q?: string) =>
  Promise.all(
    Array.from({ length: n }, (_, i) => search(Array.isArray(b) ? b[i % b.length]! : b, q)),
  );
const statuses = (rs: Response[]) => rs.map((r) => r.status);
const count = (rs: Response[], s: number) => rs.filter((r) => r.status === s).length;

/** Waits until the oldest recorded search of the org leaves the one-second window. */
async function untilWindowFrees(orgId: string) {
  const oldest = await valkey.zrange(key(orgId), 0, 0, 'WITHSCORES');
  if (oldest.length < 2) return;
  const [sec, usec] = await valkey.time();
  const nowMs = Number(sec) * 1000 + Math.floor(Number(usec) / 1000);
  const wait = Number(oldest[1]) + 1000 - nowMs;
  if (wait > 0) await new Promise((r) => setTimeout(r, wait + 25));
}

beforeAll(async () => {
  A = await seedOrg('E2ESearchA');
  B = await seedOrg('E2ESearchB');
  for (const [o, name] of [
    [A, `Alpha ${MARK} OrgA`],
    [B, `Beta ${MARK} OrgB`],
  ] as const) {
    const source = await migrator().leadSource.create({
      data: { orgId: o.orgId, name: 'Seeded', channel: 'PORTAL' },
    });
    await migrator().lead.create({
      data: {
        orgId: o.orgId,
        fullName: name,
        primaryPhoneE164: '+919811100001',
        primaryPhoneRaw: '9811100001',
        phoneLast10: '9811100001',
        sourceId: source.id,
      },
    });
  }
  ownerA = await browserFor(A.users.owner, A.orgId);
  ownerB = await browserFor(B.users.owner, B.orgId);
  extra.push(await spawnWeb(SECOND));
  extra.push(await spawnWeb(NO_VALKEY, { REDIS_URL: 'redis://127.0.0.1:1/1' }));
}, 180_000);

afterAll(async () => {
  for (const c of extra) c.kill('SIGTERM');
  await valkey.quit();
});

describe('lead text-search budget through the built app', () => {
  it('10 searches in a second pass; the 11th gets 429 with Retry-After, uncached, revealing nothing', async () => {
    await valkey.del(key(A.orgId));
    const first = await burst(ownerA, 10);
    expect(statuses(first)).toEqual(Array(10).fill(200));
    const refused = await search(ownerA);
    expect(refused.status).toBe(429);
    expect(refused.headers.get('retry-after')).toBe('1');
    expect(refused.headers.get('cache-control')).toBe('private, no-store');
    const body = await refused.text();
    expect(body).toContain('Too many searches');
    expect(body).not.toContain(A.orgId);
    expect(body).not.toContain(MARK);
    expect(await valkey.zcard(key(A.orgId))).toBe(10); // refusals are not counted
  });

  it('retry: after the window frees up (Valkey clock), the next search passes', async () => {
    await valkey.del(key(A.orgId));
    expect(count(await burst(ownerA, 11), 429)).toBe(1);
    // Hammering while refused does not extend the wait.
    expect(count(await burst(ownerA, 5), 429)).toBe(5);
    await untilWindowFrees(A.orgId);
    expect((await search(ownerA)).status).toBe(200);
  });

  it('concurrent burst: 25 at once admit exactly 10', async () => {
    await valkey.del(key(A.orgId));
    const rs = await burst(ownerA, 25);
    expect(count(rs, 200)).toBe(10);
    expect(count(rs, 429)).toBe(15);
  });

  it('two app processes share one budget: 12 searches split across them admit 10', async () => {
    await valkey.del(key(A.orgId));
    const rs = await burst([ownerA, at(ownerA, SECOND)], 12);
    expect(count(rs, 200)).toBe(10);
    expect(count(rs, 429)).toBe(2);
  });

  it('organisations have separate counters: A spent, B still has its full budget', async () => {
    await valkey.del(key(A.orgId));
    await valkey.del(key(B.orgId));
    expect(count(await burst(ownerA, 12), 200)).toBe(10);
    expect(statuses(await burst(ownerB, 10))).toEqual(Array(10).fill(200));
    expect(await valkey.zcard(key(A.orgId))).toBe(10);
    expect(await valkey.zcard(key(B.orgId))).toBe(10);
    expect((await search(ownerB)).status).toBe(429);
  });

  it('the limit does not change what a search returns: RLS still scopes results', async () => {
    await valkey.del(key(A.orgId));
    await valkey.del(key(B.orgId));
    const a = (await (await search(ownerA)).text()).replace(/<!-- -->/g, '');
    const b = (await (await search(ownerB)).text()).replace(/<!-- -->/g, '');
    expect(a).toContain(`Alpha ${MARK} OrgA`);
    expect(a).not.toContain(`Beta ${MARK} OrgB`);
    expect(b).toContain(`Beta ${MARK} OrgB`);
    expect(b).not.toContain(`Alpha ${MARK} OrgA`);
  });

  it('filters, sorting, paging and a blank search are not metered', async () => {
    await valkey.del(key(A.orgId));
    const paths = [
      '/app/leads',
      '/app/leads?stage=NEW',
      '/app/leads?sort=name',
      '/app/leads?sort=oldest&stage=NEW',
      '/app/leads?q=%20%20',
    ];
    const rs = await Promise.all(
      Array.from({ length: 30 }, (_, i) => ownerA.get(paths[i % paths.length]!)),
    );
    expect(statuses(rs)).toEqual(Array(30).fill(200));
    expect(await valkey.exists(key(A.orgId))).toBe(0);
  });

  it('signed-out requests are sent to sign-in and never counted', async () => {
    await valkey.del(key(A.orgId));
    const res = await new Browser().get(`/app/leads?q=${MARK}`);
    expect([302, 303, 307]).toContain(res.status);
    expect(res.headers.get('location')).toMatch(/\/login/);
    expect(await valkey.exists(key(A.orgId))).toBe(0);
  });

  it('Valkey unavailable: searches fail closed with 503 and Retry-After; the plain list still works', async () => {
    const down = at(ownerA, NO_VALKEY);
    const refused = await search(down);
    expect(refused.status).toBe(503);
    expect(refused.headers.get('retry-after')).toBe('5');
    expect(refused.headers.get('cache-control')).toBe('private, no-store');
    expect(await refused.text()).not.toContain(MARK);
    // Only the text search is refused; the list without a search text renders.
    expect((await down.get('/app/leads')).status).toBe(200);
  });
});
