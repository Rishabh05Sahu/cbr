// Returns a Neon TEST branch to its pre-S1 state: drops exactly the databases crm_s1 and
// crm_test and exactly the five roles that scripts/db/bootstrap-managed-roles.sql creates.
// Owner authorisation: 2026-10-21 (clean restart, test branch cbr-s1-test only).
//
//   node scripts/managed-db/neon-clean.mjs --branch-id br-… [--env-file .env.s1-managed] [--dry-run]
//
// Stops without changing anything if the target cannot be proven (neon-target.mjs) or if any
// check is unexpected: another database or another crm_* role exists, a test database is not
// owned by crm_migrator, a role has memberships or dependencies outside the expected set, or a
// session is open on a test database (an active run; sessions are never terminated).
// Never touches neondb, postgres, other branches or the branch itself. The flow and its checks
// are in clean-branch.mjs. A failure says whether it happened before any change (nothing
// changed), while changing (the branch may be partly cleaned) or in the final re-verification
// (state unverified); after a partial cleanup follow the runbook's "Partial cleanup recovery".
import { parseArgs } from 'node:util';
import pg from 'pg';
import { cleanBranch, describeFailure } from './clean-branch.mjs';
import { expectedRoles, inventory, verifiedUrl, verifyNeonTarget } from './neon-target.mjs';

const { values: args } = parseArgs({
  options: {
    'branch-id': { type: 'string' },
    'env-file': { type: 'string', default: '.env.s1-managed' },
    'project-id': { type: 'string' },
    'dry-run': { type: 'boolean', default: false },
  },
});

let scrub = (s) => String(s);
try {
  const roles = expectedRoles();
  const result = await cleanBranch({
    verify: async () => {
      const t = await verifyNeonTarget({
        branchId: args['branch-id'],
        envFile: args['env-file'],
        projectId: args['project-id'],
      });
      scrub = t.scrub;
      return t;
    },
    takeInventory: inventory,
    connect: (direct) => new pg.Client({ connectionString: verifiedUrl(direct) }),
    roles,
    dryRun: args['dry-run'],
  });
  process.exit(result === 'not clean' ? 1 : 0);
} catch (e) {
  console.error(describeFailure(e, scrub));
  process.exit(1);
}
