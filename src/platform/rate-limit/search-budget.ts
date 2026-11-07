// Per-organisation budget for lead text search (M6 P-E, owner decision 2026-10-26): at most
// SEARCH_BUDGET.max searches in any SEARCH_BUDGET.windowMs, per organisation, across every app
// instance. Substring search keeps its semantics and its cost under RLS (load-test plan F-1/F-2);
// this caps how often an organisation can run it.
//
// Sliding-window log in one Lua call on the shared Valkey: the clock is Valkey's (TIME), so app
// instances with skewed clocks agree; accepted requests are members of a sorted set scored by
// their time; a request is accepted only while fewer than `max` were accepted in the last
// `windowMs` (a fixed window would let 2 × max through across a window edge). Refused requests
// are not recorded, so a client that waits Retry-After gets in.
//
// Fails closed: if Valkey errors or does not answer within SEARCH_BUDGET.timeoutMs the decision is
// UNAVAILABLE and the caller refuses the search (503). Nothing falls back to unlimited searches or
// to a per-process counter.
import { randomUUID } from 'node:crypto';
import { Redis } from 'ioredis';
import { serverEnv } from '@/env';

export const SEARCH_BUDGET = { windowMs: 1000, max: 10, timeoutMs: 300 } as const;

export type SearchBudgetDecision =
  | { allowed: true }
  | { allowed: false; reason: 'LIMITED' | 'UNAVAILABLE'; retryAfterSeconds: number };

/** Seconds a client is told to wait when the limiter itself is unavailable. */
export const UNAVAILABLE_RETRY_AFTER = 5;

const SLIDING_WINDOW_LUA = `
local t = redis.call('TIME')
local now = tonumber(t[1]) * 1000 + math.floor(tonumber(t[2]) / 1000)
local window = tonumber(ARGV[1])
local max = tonumber(ARGV[2])
redis.call('ZREMRANGEBYSCORE', KEYS[1], '-inf', now - window)
if redis.call('ZCARD', KEYS[1]) < max then
  redis.call('ZADD', KEYS[1], now, ARGV[3])
  redis.call('PEXPIRE', KEYS[1], window)
  return {1, 0}
end
local oldest = redis.call('ZRANGE', KEYS[1], 0, 0, 'WITHSCORES')
return {0, tonumber(oldest[2]) + window - now}
`;

const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/;

/** One key per organisation; the id is a validated UUID, so keys cannot collide or overlap. */
export function searchBudgetKey(orgId: string): string {
  if (!UUID.test(orgId)) throw new Error('search budget needs an organisation id');
  return `rl:lead-search:org:${orgId}`;
}

const g = globalThis as unknown as { __crmSearchBudgetRedis?: Redis };

function sharedClient(): Redis {
  // Its own connection. A command issued while it (re)connects waits in the offline queue, but
  // never longer than timeoutMs (the race below), so an outage refuses searches within 300 ms.
  g.__crmSearchBudgetRedis ??= new Redis(serverEnv().REDIS_URL, { maxRetriesPerRequest: 1 });
  return g.__crmSearchBudgetRedis;
}

export interface SearchBudgetOptions {
  client?: Pick<Redis, 'eval'>;
  windowMs?: number;
  max?: number;
  timeoutMs?: number;
}

export async function consumeSearchBudget(
  orgId: string,
  opts: SearchBudgetOptions = {},
): Promise<SearchBudgetDecision> {
  const windowMs = opts.windowMs ?? SEARCH_BUDGET.windowMs;
  const max = opts.max ?? SEARCH_BUDGET.max;
  let timer: ReturnType<typeof setTimeout> | undefined;
  try {
    const key = searchBudgetKey(orgId);
    const client = opts.client ?? sharedClient();
    const answer = (await Promise.race([
      client.eval(SLIDING_WINDOW_LUA, 1, key, String(windowMs), String(max), randomUUID()),
      new Promise((_, reject) => {
        timer = setTimeout(
          () => reject(new Error('search budget timed out')),
          opts.timeoutMs ?? SEARCH_BUDGET.timeoutMs,
        );
      }),
    ])) as [number, number];
    if (answer[0] === 1) return { allowed: true };
    return {
      allowed: false,
      reason: 'LIMITED',
      retryAfterSeconds: Math.max(1, Math.ceil(answer[1] / 1000)),
    };
  } catch {
    return { allowed: false, reason: 'UNAVAILABLE', retryAfterSeconds: UNAVAILABLE_RETRY_AFTER };
  } finally {
    clearTimeout(timer);
  }
}

export async function closeSearchBudget(): Promise<void> {
  await g.__crmSearchBudgetRedis?.quit().catch(() => {});
  delete g.__crmSearchBudgetRedis;
}
