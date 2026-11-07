// S1-08 pool leakage under concurrency: 50 concurrent workers x 1,000 iterations each
// (50,000 transactions) alternating orgs A/B/C over a pool of 5 connections.
// 10% of transactions throw (rollback path); unwrapped probes are interleaved.
//
// Diagnostics (docs/NEON-S1-FAILURE-TRIAGE.md §1d): a progress line about every 60 s with a UTC
// timestamp, and the counters, leak samples, unexpected errors, pool events and backend usage
// are printed even when the test fails. Unexpected errors from transactions, from the unwrapped
// probe, from any rejected worker and from pool error events are all recorded with their stage
// and SQLSTATE (../db/failure-log.ts); after the first one the other workers finish their
// current iteration and stop, so the printed counters are final, and the first error is
// re-thrown. A progress gap over 120 s (../db/progress-monitor.ts) makes the run invalid: the
// test fails whatever its counters say.
//
// Workload and assertions are unchanged, except that the pooled variant (S1_APP_POOLED=1 from
// the runner, through a different endpoint) replaces `distinct server pids <= 5`, which does not
// measure the client pool behind a transaction-mode pooler, with: client pool peak <= 5 and
// cross-tenant backend reuse in every direction (../db/backend-reuse.ts).
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import {
  assertDiagnosticServer,
  createAppClient,
  createMigratorClient,
  tenantRunnerFor,
} from '../db/clients';
import {
  assertDiagnosticHosts,
  diagnosticLabel,
  txStartBudgetFromEnv,
} from '../db/diagnostic-override';
import { BackendUsage, missingCrossTenantPairs, s108Path } from '../db/backend-reuse';
import { FailureLog, secretsFromUrls, transactionStage } from '../db/failure-log';
import { PoolEventLog } from '../db/pool-events';
import { PROGRESS_INTERVAL_MS, ProgressMonitor } from '../db/progress-monitor';
import { seedOrg, type OrgFixture } from './fixtures';

const WORKERS = 50;
const ITERATIONS = 1_000;
const POOL = 5;
// Wall-clock limit only; remote runs (S1-18) pay a network round trip per query. The workload
// and every assertion are unchanged.
const TIMEOUT_MS = Number(process.env.S1_LONG_TEST_TIMEOUT_MS ?? 600_000);
// Binding 30 s, or the labelled Neon diagnostic value (validated; see ../db/diagnostic-override.ts).
const budget = txStartBudgetFromEnv();

const migrator = createMigratorClient();
const app = createAppClient(POOL);
const { withTenant } = tenantRunnerFor(app, budget);
// Direct, or the runner's pooled batch (validated: throws on an inconsistent setting).
const PATH = s108Path(process.env);
const SECRETS = secretsFromUrls([
  process.env.S1_APP_URL,
  process.env.S1_MIGRATOR_URL,
  process.env.S1_PLATFORM_URL,
  process.env.S1_BASELINE_URL,
]);
const poolEvents = new PoolEventLog(
  app.pool,
  (h) => {
    app.pool.on('connect', h.connect);
    app.pool.on('remove', h.remove);
    app.pool.on('error', h.error);
  },
  SECRETS,
);
let orgs: OrgFixture[];
/** Org ids appear in the backend-usage log only as their fixture names. */
const ORG_LABEL = new Map<string, string>();

beforeAll(async () => {
  if (budget.diagnostic) {
    assertDiagnosticHosts(budget.diagnostic, [
      process.env.S1_APP_URL!,
      process.env.S1_MIGRATOR_URL!,
    ]);
    // The pool actually built must use the diagnostic pool-wait timeout.
    const expected = budget.diagnostic.connectionTimeoutMs;
    const poolTimeouts = [app, migrator].map((h) => h.pool.options.connectionTimeoutMillis);
    if (poolTimeouts.some((t) => t !== expected))
      throw new Error(
        `diagnostic override refused: pool connection timeout ${poolTimeouts.join('/')} ms, ` +
          `expected ${expected} ms`,
      );
    const direct = await assertDiagnosticServer(migrator, budget.diagnostic);
    const viaApp = await assertDiagnosticServer(app, budget.diagnostic);
    console.info(
      `[S1-08] DIAGNOSTIC OVERRIDE, NOT A BINDING RESULT: ${JSON.stringify({
        txStartMaxWaitMs: budget.maxWaitMs,
        bindingTxStartMaxWaitMs: 30_000,
        connectionTimeoutMs: budget.diagnostic.connectionTimeoutMs,
        branchId: budget.diagnostic.branchId,
        endpointId: budget.diagnostic.endpointId,
        serverCheck: { migratorConnection: direct, appConnection: viaApp },
      })}`,
    );
  }
  orgs = [
    await seedOrg(migrator, 'Charlie'),
    await seedOrg(migrator, 'Delta'),
    await seedOrg(migrator, 'Echo'),
  ];
  ['Charlie', 'Delta', 'Echo'].forEach((name, n) => ORG_LABEL.set(orgs[n]!.orgId, name));
});
afterAll(async () => {
  await app.close();
  await migrator.close();
});

class Planned extends Error {}

describe('S1-08 pool leakage under concurrency', () => {
  it(
    `${WORKERS} workers x ${ITERATIONS} iterations over a pool of ${POOL}: 0 leaks${diagnosticLabel(budget)}`,
    async () => {
      let leaks = 0;
      let committed = 0;
      let rolledBack = 0;
      let unwrappedProbes = 0;
      const pids = new Set<number>();
      const backends = new BackendUsage();
      const leakSamples: string[] = [];
      // Diagnostics only: nothing below feeds an assertion except where stated. Transaction
      // errors, probe errors, rejected workers and pool error events all land in `failures`;
      // its first error is re-thrown.
      const failures = new FailureLog(SECRETS);
      // requestToCallbackMs: from just before withTenant() to the start of the test's callback,
      // i.e. the WHOLE observed duration (pool queue + connect + BEGIN + set_config), not only
      // pool-acquisition time.
      let requestToCallbackMax = 0;
      let requestToCallbackIntervalMax = 0;
      let requestToCallbackOver10s = 0;
      const monitor = new ProgressMonitor();

      const snapshot = () => ({
        atUtc: monitor.nowUtc(),
        elapsedS: Number(((performance.now() - started) / 1000).toFixed(1)),
        path: PATH,
        transactions: committed + rolledBack,
        committed,
        rolledBack,
        unwrappedProbes,
        leaks,
        distinctBackends: pids.size,
        pool: poolEvents.summary(),
        requestToCallbackMs: {
          max: Math.round(requestToCallbackMax),
          maxSinceLastLine: Math.round(requestToCallbackIntervalMax),
          over10s: requestToCallbackOver10s,
        },
        unexpectedErrors: failures.count,
        progressGaps: monitor.gapCount,
      });

      const worker = async (w: number) => {
        for (let i = 0; i < ITERATIONS && !failures.stopping; i++) {
          const org = orgs[(w + i) % orgs.length]!;
          const shouldFail = (w * ITERATIONS + i) % 10 === 0;
          const requested = performance.now();
          let callbackEntered = false;
          try {
            await withTenant({ orgId: org.orgId, userId: org.users.admin }, async (tx) => {
              callbackEntered = true;
              const wait = performance.now() - requested;
              requestToCallbackMax = Math.max(requestToCallbackMax, wait);
              requestToCallbackIntervalMax = Math.max(requestToCallbackIntervalMax, wait);
              if (wait > 10_000) requestToCallbackOver10s++;
              poolEvents.sample();
              const [s] = await tx.$queryRaw<{ org: string; pid: number }[]>`
              SELECT current_setting('app.org_id', true) AS org, pg_backend_pid() AS pid`;
              pids.add(s!.pid);
              backends.record(s!.pid, org.orgId);
              const leads = await tx.lead.findMany({ select: { orgId: true } });
              const foreign = leads.filter((l) => l.orgId !== org.orgId).length;
              if (s!.org !== org.orgId || foreign > 0 || leads.length === 0) {
                leaks++;
                if (leakSamples.length < 5)
                  leakSamples.push(
                    `w${w} i${i} want ${org.orgId} got ${s!.org} foreign=${foreign}`,
                  );
              }
              if (shouldFail) throw new Planned();
            });
            committed++;
          } catch (e) {
            if (!(e instanceof Planned)) {
              failures.record(
                `w${w} i${i} transaction`,
                e,
                transactionStage(e, callbackEntered),
                performance.now() - requested,
              );
              throw e;
            }
            rolledBack++;
          }
          // Every 20th iteration: a query outside the wrapper must see nothing.
          if (i % 20 === 0) {
            unwrappedProbes++;
            const probeStarted = performance.now();
            let n: number;
            try {
              n = await app.prisma.lead.count();
            } catch (e) {
              failures.record(
                `w${w} i${i} unwrapped probe`,
                e,
                'unwrapped probe',
                performance.now() - probeStarted,
              );
              throw e;
            }
            if (n !== 0) {
              leaks++;
              if (leakSamples.length < 5) leakSamples.push(`unwrapped probe saw ${n} leads`);
            }
          }
        }
      };

      const started = performance.now();
      const progress = setInterval(() => {
        const gap = monitor.observe('progress tick');
        if (gap) console.info(`[S1-08] PROGRESS GAP (run invalid) ${JSON.stringify(gap)}`);
        console.info(`[S1-08] progress ${JSON.stringify(snapshot())}`);
        requestToCallbackIntervalMax = 0;
      }, PROGRESS_INTERVAL_MS);
      try {
        const settled = await Promise.allSettled(
          Array.from({ length: WORKERS }, (_, w) => worker(w)),
        );
        failures.collectSettled(settled);
      } finally {
        clearInterval(progress);
      }
      monitor.observe('end of run');
      // An idle client's connection error is an unexpected error too (never a success).
      if (poolEvents.firstError)
        failures.record('pool error event (idle client)', poolEvents.firstError);
      const seconds = ((performance.now() - started) / 1000).toFixed(1);
      const label = (o: string) => ORG_LABEL.get(o) ?? 'unknown org';
      const missingPairs = missingCrossTenantPairs(
        backends,
        orgs.map((o) => o.orgId),
      ).map((p) => p.split('->').map(label).join('->'));

      console.info(
        `[S1-08] transactions=${committed + rolledBack} committed=${committed} rolledBack=${rolledBack} ` +
          `unwrappedProbes=${unwrappedProbes} distinctBackends=${pids.size} leaks=${leaks} in ${seconds}s`,
      );
      console.info(
        `[S1-08] final ${JSON.stringify({
          ...snapshot(),
          startedAtUtc: monitor.startedAtUtc,
          completed: !failures.first,
          validForAcceptance: monitor.validForAcceptance,
          progressGapSamples: monitor.gaps,
          leakSamples,
          unexpectedErrorSamples: failures.samples,
          backendUsage: { ...backends.summary(label), missingCrossTenantPairs: missingPairs },
        })}`,
      );
      // An interrupted or stalled run is never an S1-08 result, whatever its counters say.
      if (!monitor.validForAcceptance)
        throw new Error(
          monitor.invalidRunMessage() +
            (failures.first
              ? `; also ${failures.count} unexpected error(s), first: ${failures.samples[0]?.message}`
              : ''),
        );
      if (failures.first) throw failures.first.error;
      expect(leakSamples).toEqual([]);
      expect(leaks).toBe(0);
      expect(committed + rolledBack).toBe(WORKERS * ITERATIONS);
      if (PATH === 'direct') {
        // One server backend per client connection: unchanged.
        expect(pids.size).toBeLessThanOrEqual(POOL);
      } else {
        // Through the pooler (../db/backend-reuse.ts): the client pool stays within 5, and
        // backends were shared across tenants in every direction.
        expect(poolEvents.peakTotalCount).toBeGreaterThan(0);
        expect(poolEvents.peakTotalCount).toBeLessThanOrEqual(POOL);
        expect(missingPairs).toEqual([]);
      }
    },
    TIMEOUT_MS,
  );
});
