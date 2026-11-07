# Spike S1: Tenant Isolation — Results

> **Result (2026-10-19): 17 of 18 criteria PASS on local PostgreSQL 18.6. S1-18 (staging parity) NOT RUN**, because no managed staging database exists yet. Under the gate rule in [PHASE-0-FINAL-REVIEW §7](../../PHASE-0-FINAL-REVIEW.md), S1 is therefore **not yet fully passed**. **Owner decision D1 (2026-10-19):** the local results are accepted for continued development, but S1 is **not** fully passed until S1-18 runs on the managed database. That must happen before any staging deploy or real data ([runbook](../../runbooks/staging-preparation.md)).
> No security requirement was weakened. All data is synthetic.

## 1. What was built

| Item | Location |
|---|---|
| Tenant gateway `createTenantRunner()` → `withTenant(ctx, fn)` / `withUser(userId, fn)` (**production code**) | `src/platform/db/with-tenant.ts` |
| Representative schema (14 org-owned tables, including a child table without a direct org FK in its parent chain) | `spikes/s1-tenant-isolation/prisma/schema.prisma` |
| RLS, grants, exclusion constraint, `SECURITY DEFINER` lookups | `spikes/s1-tenant-isolation/prisma/migrations/0002_tenant_security/migration.sql` |
| Roles `crm_migrator`, `crm_app`, `crm_platform`, `crm_definer` (+ `crm_auth` for S2) | `docker/postgres/init/01-roles.sh` |
| Access-path harness: Server Action, Route Handler, webhook handler, worker job | `spikes/s1-tenant-isolation/harness/access-paths.ts` |
| Scope layer (own / team / org, delegations) | `spikes/s1-tenant-isolation/harness/lead-repository.ts` |
| Lint rule: raw DB clients only in `src/platform/db` | `eslint.config.mjs` |
| Tests (8 files, 96 tests) | `spikes/s1-tenant-isolation/tests/` |

Key design points, now proven:
- The policy shape is `org_id = (SELECT app.current_org_id())`, where `app.current_org_id()` = `nullif(current_setting('app.org_id', true), '')::uuid`.
  - **Finding:** after a transaction-local `set_config` ends, PostgreSQL reports the setting as `''`, not NULL, on that connection. Without `nullif`, the cast raises an error instead of matching nothing. The test for this is S1-03.
  - The `(SELECT …)` wrapper makes the function an InitPlan evaluated once per query. The index is still used, and S1-17 shows the plans are identical.
- `withTenant` validates ids with Zod before borrowing a connection. Supported options: `userId: null` for system actors (webhooks, jobs) and `readOnly` (`SET TRANSACTION READ ONLY`, used by support access in S2-08).
- `crm_migrator` has an explicit `maintenance` policy, because FORCE RLS applies to the owner too. The owner could disable RLS anyway; the app never connects as this role.
- Pre-tenant functions are owned by a NOLOGIN `crm_definer`. They get **column-level** SELECT grants plus their own `definer_lookup` policies, so no BYPASSRLS role is needed.

## 2. Results

Run: `pnpm spike:s1:test` on Windows 11 with Docker `postgres:18.6-trixie`. Log: `spikes/results/full-run.log`.

| # | Criterion | Result | Evidence (test) |
|---|---|---|---|
| S1-01 | Role hardening | **PASS** | `crm_app`: not superuser, no BYPASSRLS/CREATEROLE/CREATEDB, owns 0 relations/functions/schemas, no CREATE on `public`, `app` or the database, member of no role |
| S1-02 | RLS enabled + forced | **PASS** | Catalog: 0 tables with `org_id` lacking ENABLE+FORCE. `organization`/`user` forced. The suite's table list equals the catalog list. Every tenant table has a `crm_app` policy |
| S1-03 | Fail closed | **PASS** | No context: `SELECT` = 0 rows on 16 tables (raw + ORM); `INSERT` raises RLS violation; `UPDATE`/`DELETE` affect 0 rows. Empty-string context also matches nothing |
| S1-04 | Tenant reads | **PASS** | Org A context: 0 rows of org B on all 14 tables via ORM (`count`, `findUnique` by known ids, relation traversal) and raw SQL. Sanity check: A sees its own rows in every table |
| S1-05 | Tenant writes | **PASS** | Insert with `org_id = B` → RLS violation (ORM + raw). Update/delete of B rows → 0. Moving a row A→B → violation |
| S1-06 | Composite FK | **PASS** | Task(A) → lead(B) fails at `task_org_id_lead_id_fkey` **as `crm_migrator`**. A lead in A owned by a B-only user fails at `lead_org_id_owner_user_id_fkey`. Same for `crm_app` |
| S1-07 | Transaction-local context | **PASS** | Pool of 1: after commit **and** after a thrown error, the same backend PID shows an empty setting and 0 visible rows. Rolled-back insert absent |
| S1-08 | Pool leakage under concurrency | **PASS** | 50 workers × 1,000 iterations = **50,000 transactions** (45,000 committed, 5,000 deliberately rolled back), 5 backends, 2,500 interleaved unwrapped probes: **0 leaks**. Passed in all 3 runs, including from a freshly created database (≈ 124 s each) |
| S1-09 | Outside-wrapper access blocked | **PASS** | ESLint rejects `@prisma/client`, generated client, `@prisma/adapter-pg`, `pg` in `src/modules/**` and `src/app/**`, and allows them in `src/platform/db/**`. Raw client at runtime returns 0 rows |
| S1-10 | Server Action path | **PASS** | Org from the (mock) session. A forged `orgId` input is ignored. The executive scope still applies. No session → `UNAUTHENTICATED` |
| S1-11 | Route Handler path | **PASS** | `?orgId=` is ignored; 401 without session. The webhook resolves org **only** via `app.resolve_webhook_connection`; a B lead id in an A webhook → 404, nothing written |
| S1-12 | Worker path | **PASS** | Job runs under `withTenant(payload.orgId)`. A payload org mismatching the entity → `JobEntityNotFound`, 0 rows written. A malformed payload is rejected before the DB |
| S1-13 | Pre-tenant functions | **PASS** | All 4 functions: `SECURITY DEFINER`, owner `crm_definer` (NOLOGIN), `search_path=pg_catalog, pg_temp`, exact documented columns, EXECUTE for `crm_app` only. 7 probe strings (`''`, `%`, `_`, `*`, prefix, trailing space, quote injection) and NULL return 0 rows. Another user's id returns 0. `crm_app` cannot `SET ROLE crm_definer`; no secret column grant |
| S1-14 | Platform tables | **PASS** | `user`: own row (`withUser`) or members of the current org only. Update of another user → 0. `organization`: current org only; `crm_platform` sees all. `audit_log`: NULL-org rows invisible to `crm_app`; `crm_platform` sees only NULL-org rows; append-only for both. `crm_platform` has no access to `lead` or `user` |
| S1-15 | Scope layer | **PASS** | 2 teams, overlapping membership (manager leads North, is member of South), a reassigned lead, an active and an expired delegation. Exec sees own; exec with cover sees own + delegated; Manager sees the led team only; Admin/Owner see the org; HR sees none. Ending the lead spell removes team scope. An org-B user in org-A context sees nothing |
| S1-16 | Ownership history | **PASS** | Overlapping spell → exclusion constraint `lead_assignment_history_no_overlap`. Close-then-open succeeds. `crm_app` can only update `ended_at` |
| S1-17 | Performance sanity | **PASS** | 250,000 leads, 20 execs, 4 teams. End-to-end list (`withTenant` + scope queries + ORM), 200 runs each, range over 3 runs: Exec p95 **11.5–29.8 ms**, Manager p95 **25.8–27.9 ms**, Admin p95 **11.1–16.5 ms** (limit 500 ms). RLS overhead vs the same query without RLS (superuser + explicit org predicate): p50 **+0.1 % to +6.2 %** (asserted ≤ 15 %), p95 **+8.6 % to +11.0 %** (not asserted; reported). Query plans are identical (`lead_org_id_created_at_id_idx`, Index Cond on org) |
| S1-18 | Staging parity | **NOT RUN** | No managed staging database exists. Provisioning needs the hosting decision and the pre-provisioning cost estimate required by the Phase 1 approval |

### 2.1 Do the tests detect real leaks? (mutation check)

The suite was run against deliberately weakened controls, which were then reverted:

| Mutation | Tests failed | Caught by |
|---|---|---|
| Extra permissive policy `USING (true)` on `lead` for `crm_app` | 6 | S1-03, S1-04, S1-07 |
| `set_config(..., false)` (session-level instead of transaction-local) in `withTenant` | 3 | S1-07 (commit and rollback) and **S1-08 concurrency** |

The suite fails loudly for both of the most likely real-world mistakes.

## 3. Known limitations

1. **S1-18 not run**, as above. The DigitalOcean-specific risk is in role creation:
   - whether `doadmin` can create `NOBYPASSRLS` roles;
   - whether a NOLOGIN definer role can be granted to the migrator;
   - whether the needed extensions (`citext`, `btree_gist`, `pg_trgm`) can be created by the admin user.
2. **Access paths are harness functions**, which the S1 setup allows. The real Next.js Server Actions, Route Handlers and BullMQ worker are re-tested when those modules exist (Phase 1 Step 5).
3. **The performance numbers are local.** They come from Docker on a Windows laptop, with the data warm in cache, and are not representative of a managed single-node database. They re-run on staging.
4. **The overhead baseline uses the local superuser**, which bypasses RLS. That role does not exist on managed hosting.
5. **The `app.user_id` check in `auth_memberships_for_user` is defence against bugs, not against compromised app code.** `crm_app` can set any GUC. This is documented in the migration.
6. **The scope layer is application code** (by design, database-design §2.6). A missing scope predicate in a new repository is caught only by that module's permission tests, not by RLS. RLS still prevents cross-*org* exposure.
7. **Prisma may try to drop objects that only exist in raw SQL.** Future `prisma migrate diff` output could propose dropping the exclusion constraint or CHECKs. Migration review must catch this; consider a CI check that diffs expected raw objects.

## 4. Next permitted step

S1-18 must pass before S1 is complete. See the [gate review](../../PHASE-1-GATE-REVIEW.md) for the decision requested.
