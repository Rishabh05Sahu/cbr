# Testing Strategy

> Status: Phase 0 draft. Tooling is proposed and is confirmed in Phase 1 setup: **Vitest** (unit/integration), **Testcontainers** or Docker Compose Postgres 18 + Valkey for integration, **Playwright** (E2E, mobile viewport), **k6** (load), **MSW**/fake adapters for providers.

## 1. Pyramid

| Layer | Share of tests | What | Runs |
|---|---|---|---|
| **Unit** | ~60% | Pure domain logic: lifecycle transitions, phone normalisation, budget parsing ("1.2 Cr"), duplicate matching, round-robin selection, KPI formula helpers, permission catalog resolution, provider payload mapping | Every commit, < 1 min |
| **Integration (DB)** | ~30% | Module commands/queries against real PostgreSQL with RLS + migrations applied; transactions, constraints, idempotency; job handlers invoked directly | Every PR, < 8 min |
| **E2E** | ~10% | Critical journeys in a browser: login, invite, import → assign → call-intent → log outcome → follow-up; dashboard drill-down count | Every PR (smoke set) + nightly (full) |
| **Load** | — | k6 scenarios for NFR-001..008 on a seeded 250k-lead org | Before each phase exit from Phase 2 |

## 2. Mandatory specialised suites

1. **Tenant isolation suite** (Phase 1, grows every phase). For every repository/query function: seed orgs A and B and assert that an org A context can never read or write org B rows (expect not-found). Also: the raw `crm_app` connection without `app.org_id` returns zero rows on every tenant table (introspected automatically from the schema, so new tables are covered by default).
2. **Permission matrix suite.** Generated from the permission catalog × roles × scopes (own/team/org/none) with fixtures. Expected results come from a declarative matrix file that mirrors [user-personas-and-roles.md](../product/user-personas-and-roles.md). CI fails if a catalog permission is missing from the matrix.
3. **Server Action exposure test.** Every exported Server Action is invoked unauthenticated and as a low-privilege user. Expect rejection unless explicitly marked public.
4. **Background job tests:**
   - idempotency (run each handler twice, assert one effect);
   - crash-resume (abort mid-import, resume, compare counts);
   - retry/backoff configuration snapshot;
   - reminder dedup under reschedule;
   - outbox relay with a Redis outage simulated.
5. **Webhook tests:** signature valid/invalid; duplicate delivery; out-of-order events; replay of old events; unknown connection token.
6. **KPI tests:** fixture scenarios per KPI (reassignment, leave, maturity window, merged leads, IST/UTC day boundary). Assert tile = drill-down count.
7. **Import corpus:** real-world messy files (merged cells, blank rows, Hindi names, phone formats, "1.2 Cr", duplicate phones, 100k rows, zip-bomb-like XLSX, formulas) kept in `tests/fixtures/imports`. **Anonymised only.**
8. **Accessibility:** axe checks in Playwright on core pages; manual screen-reader pass per phase.
9. **Migration tests:** apply all migrations from empty; apply the latest migration against a snapshot of the previous release; verify RLS policies exist on all tenant tables (catalog query).

## 3. Test data rules

- No real customer data in any non-production environment. Seed generators (Faker with `en_IN` locale) for names/phones in reserved test ranges.
- Staging uses synthetic or irreversibly anonymised data only.

## 4. Quality gates (CI)

`typecheck` → `lint` (incl. boundaries, banned APIs) → `unit` → `integration` → `build` → `e2e-smoke` → security scans (deps, secrets) → migration check. All are required for merge to `main`.
