// Fixed-window rate limiter on Valkey (atomic INCR + PEXPIRE in one Lua call), shared by
// Better Auth's HTTP endpoints and our own Server Actions (D3, NFR-046).
import { Redis } from 'ioredis';
import { serverEnv } from '@/env';

export interface RateRule {
  /** Window length in seconds. */
  window: number;
  max: number;
}

export interface RateDecision {
  allowed: boolean;
  /** Seconds until the window frees up (null when allowed). */
  retryAfter: number | null;
}

const CONSUME_LUA = `
local count = redis.call('INCR', KEYS[1])
if count == 1 then redis.call('PEXPIRE', KEYS[1], ARGV[1]) end
local ttl = redis.call('PTTL', KEYS[1])
return {count, ttl}
`;

const g = globalThis as unknown as { __crmRateRedis?: Redis };

function redis(): Redis {
  g.__crmRateRedis ??= new Redis(serverEnv().REDIS_URL, {
    maxRetriesPerRequest: 2,
  });
  return g.__crmRateRedis;
}

export async function consume(key: string, rule: RateRule): Promise<RateDecision> {
  const [count, ttl] = (await redis().eval(
    CONSUME_LUA,
    1,
    `rl:${key}`,
    String(rule.window * 1000),
  )) as [number, number];
  if (count <= rule.max) return { allowed: true, retryAfter: null };
  return { allowed: false, retryAfter: Math.max(1, Math.ceil(ttl / 1000)) };
}

export class RateLimited extends Error {
  override readonly name = 'RateLimited';
  constructor(readonly retryAfter: number) {
    super(`Too many requests. Try again in ${retryAfter} s.`);
  }
}

/** Throws RateLimited when the rule is exceeded. */
export async function enforce(key: string, rule: RateRule): Promise<void> {
  const d = await consume(key, rule);
  if (!d.allowed) throw new RateLimited(d.retryAfter ?? rule.window);
}

/** Limits used by Server Actions (per user, per org). */
export const RULES = {
  invitationCreate: { window: 3600, max: 30 },
  invitationAccept: { window: 600, max: 10 },
  invitationLookup: { window: 600, max: 30 },
  sensitiveSettings: { window: 60, max: 20 },
} satisfies Record<string, RateRule>;

export async function closeRateLimiter(): Promise<void> {
  await g.__crmRateRedis?.quit();
  delete g.__crmRateRedis;
}
