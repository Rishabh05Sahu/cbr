// S1-08 backend usage: which tenant organisations each server backend (pg_backend_pid()) served,
// in execution order.
//
// Why the pooled variant needs this instead of `distinct pids <= 5`: the runner's pooled-s1-08
// batch only swaps S1_APP_URL's host for the Neon pooler (scripts/managed-db/s1-managed-run.mjs,
// pooledUrl), which runs PgBouncer in transaction mode. There, each transaction gets whichever
// server connection PgBouncer picks, and a client reconnect gets new ones, so the number of
// distinct server pids measures the pooler's server-side pool, not the client pool of 5. The
// direct variant keeps `distinct pids <= 5`, which is valid there (one backend per client
// connection).
//
// What the pooled variant asserts instead, both derived from the test's purpose rather than
// tuned to a result:
//  1. the client pool never exceeds its configured 5 connections (peak pool.totalCount);
//  2. cross-tenant backend reuse covers every direction a leak could take: for every ordered
//     pair of distinct tenant orgs (X, Y), some backend ran a transaction for Y directly after
//     one for X. With 3 orgs that is 6 pairs. This is the minimum for each possible X -> Y
//     carry-over to have been exposed to the leak checks at all. No higher frequency threshold
//     is set: nothing in the workload or the code fixes one, so any number would be arbitrary.
// Within one backend, transactions run one at a time (PgBouncer transaction mode, or one client
// connection directly), and each is recorded from inside the transaction, so per-backend order is
// execution order.

export interface BackendStats {
  transactions: number;
  readonly orgs: Set<string>;
  lastOrg: string | null;
  /** Consecutive transactions on this backend for two different orgs. */
  crossTenantSwitches: number;
}

export class BackendUsage {
  readonly byPid = new Map<number, BackendStats>();
  /** "X->Y" for every org switch observed on one backend. */
  readonly orderedPairs = new Map<string, number>();

  record(pid: number, orgId: string): void {
    let s = this.byPid.get(pid);
    if (!s) {
      s = { transactions: 0, orgs: new Set(), lastOrg: null, crossTenantSwitches: 0 };
      this.byPid.set(pid, s);
    }
    s.transactions++;
    s.orgs.add(orgId);
    if (s.lastOrg !== null && s.lastOrg !== orgId) {
      s.crossTenantSwitches++;
      const key = `${s.lastOrg}->${orgId}`;
      this.orderedPairs.set(key, (this.orderedPairs.get(key) ?? 0) + 1);
    }
    s.lastOrg = orgId;
  }

  /** Bounded summary for the log (the 20 busiest backends). */
  summary(label: (orgId: string) => string = (o) => o) {
    const backends = [...this.byPid.entries()]
      .sort((a, b) => b[1].transactions - a[1].transactions)
      .slice(0, 20)
      .map(([pid, s]) => ({
        pid,
        transactions: s.transactions,
        orgs: [...s.orgs].map(label).sort(),
        crossTenantSwitches: s.crossTenantSwitches,
      }));
    return {
      distinctBackends: this.byPid.size,
      backendsServingSeveralOrgs: [...this.byPid.values()].filter((s) => s.orgs.size > 1).length,
      orderedPairs: Object.fromEntries(
        [...this.orderedPairs.entries()].map(([k, n]) => [
          k
            .split('->')
            .map((o) => label(o))
            .join('->'),
          n,
        ]),
      ),
      busiestBackends: backends,
    };
  }
}

/** The ordered org pairs never observed consecutively on one backend (empty = criterion met). */
export function missingCrossTenantPairs(usage: BackendUsage, orgIds: readonly string[]): string[] {
  const missing: string[] = [];
  for (const x of orgIds)
    for (const y of orgIds)
      if (x !== y && !usage.orderedPairs.has(`${x}->${y}`)) missing.push(`${x}->${y}`);
  return missing;
}

export type S108Path = 'direct' | 'pooled';

/**
 * Which assertion set S1-08 uses. Pooled only when the runner says so (S1_APP_POOLED=1) AND the
 * app connection really goes to a different endpoint than the migrator's direct one; anything
 * else is direct (the stricter `pids <= 5`), and an inconsistent or unknown value throws.
 */
export function s108Path(env: Readonly<Record<string, string | undefined>>): S108Path {
  const flag = env.S1_APP_POOLED;
  if (flag === undefined || flag === '' || flag === '0') return 'direct';
  if (flag !== '1') throw new Error(`S1_APP_POOLED must be 1 or 0, not ${JSON.stringify(flag)}`);
  const endpoint = (u: string | undefined) => {
    const url = new URL(u ?? '');
    return `${url.hostname}:${url.port || '5432'}`;
  };
  if (endpoint(env.S1_APP_URL) === endpoint(env.S1_MIGRATOR_URL))
    throw new Error(
      'S1_APP_POOLED=1 but the app connection uses the direct endpoint: refusing the pooled assertions',
    );
  return 'pooled';
}
