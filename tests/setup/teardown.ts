// Per-file teardown: close pools, queues and Valkey connections opened by the app modules.
import { afterAll } from 'vitest';
import { disconnectAll } from '@/platform/db/client';
import { closeQueues } from '@/platform/queue';
import { closeRateLimiter } from '@/platform/rate-limit';
import { closeSearchBudget } from '@/platform/rate-limit/search-budget';
import { closeTestDb } from '../support/db';

afterAll(async () => {
  await Promise.allSettled([
    disconnectAll(),
    closeQueues(),
    closeRateLimiter(),
    closeSearchBudget(),
    closeTestDb(),
  ]);
});
