// db-roles: is this run against the verified Neon test branch? Only then may the narrow Neon
// role-refusal rule in ./set-role.ts apply.
//
// The managed runner passes the target that neon-s1.mjs verified (Neon control plane + server
// identity on the direct and pooled connections) as TEST_NEON_BRANCH_ID, TEST_NEON_ENDPOINT_ID
// and TEST_NEON_PRODUCTION_BRANCH_IDS. Those variables alone are not trusted: the test's own
// connection must also be to that endpoint, and the server itself must report that branch and
// endpoint (neon.branch_id / neon.endpoint_id, read in a fresh session), which must not be a
// production branch. No variables: null (PostgreSQL rules only). Variables that are incomplete,
// malformed or not confirmed by the server: throw, so the test fails rather than guessing.

export interface ParamClient {
  query(sql: string, values?: unknown[]): Promise<{ rows: Record<string, unknown>[] }>;
}

export interface NeonContext {
  readonly branchId: string;
  readonly endpointId: string;
}

const KEYS = [
  'TEST_NEON_BRANCH_ID',
  'TEST_NEON_ENDPOINT_ID',
  'TEST_NEON_PRODUCTION_BRANCH_IDS',
] as const;
const BRANCH = /^br-[a-z0-9-]+$/;
const ENDPOINT = /^ep-[a-z0-9-]+$/;

export async function neonContextFor(
  c: ParamClient,
  env: Readonly<Record<string, string | undefined>>,
  connectionUrl: string,
): Promise<NeonContext | null> {
  const present = KEYS.filter((k) => env[k] !== undefined && env[k] !== '');
  if (present.length === 0) return null;
  const refuse = (why: string): never => {
    throw new Error(`Neon test context not established: ${why}`);
  };
  if (present.length !== KEYS.length) refuse(`only ${present.join(', ')} set`);
  const branchId = env.TEST_NEON_BRANCH_ID!;
  const endpointId = env.TEST_NEON_ENDPOINT_ID!;
  const production = env.TEST_NEON_PRODUCTION_BRANCH_IDS!.split(',').filter(Boolean);
  if (!BRANCH.test(branchId)) refuse('branch id malformed');
  if (!ENDPOINT.test(endpointId)) refuse('endpoint id malformed');
  if (production.length === 0 || !production.every((p) => BRANCH.test(p)))
    refuse('production branch ids unknown');
  if (production.includes(branchId)) refuse('the target is a production branch');
  const label = new URL(connectionUrl).hostname.split('.')[0];
  if (label !== endpointId && label !== `${endpointId}-pooler`)
    refuse('the test connection is not to the verified endpoint');
  const { rows } = await c.query(
    `SELECT current_setting('neon.branch_id', true) AS branch,
            current_setting('neon.endpoint_id', true) AS endpoint`,
  );
  const server = rows[0] ?? {};
  if (server.branch !== branchId || server.endpoint !== endpointId)
    refuse('the server does not report the verified branch and endpoint');
  return { branchId, endpointId };
}
