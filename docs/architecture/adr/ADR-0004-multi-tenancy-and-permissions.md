# ADR-0004: Shared-schema multi-tenancy with PostgreSQL RLS; fixed roles + scoped permission catalog

- **Status:** Proposed. Tenancy decisions 1–5 proven locally by Spike S1 (17/18; staging parity pending) and Spike S2 ([S1](../spikes/S1-report.md), [S2](../spikes/S2-report.md)).
- **Date:** 2026-10-19

## Context
One brokerage must never see another's data, including via platform staff, background jobs and reports. Within a brokerage, access varies by role and by own/team/org scope. Permissions must be enforced on the server.

## Decision
**Tenancy:**
1. Shared database, shared schema, `org_id` on every tenant table.
2. **PostgreSQL row-level security** (ENABLE + FORCE) on every tenant table, keyed on the transaction-local setting `app.org_id`. It fails closed when the setting is unset.
3. App connects as a non-owner role without BYPASSRLS. Tenant DB access is only possible through `withTenant(ctx, fn)`. The authentication library uses its own role, `crm_auth`, limited to auth and membership tables (approved as D2, 2026-10-19).
4. Composite `(org_id, id)` foreign keys between tenant tables.
5. Platform admins have no tenant memberships. Access to tenant data requires a time-boxed, owner-approved support grant.

**Permissions:**
1. Permission catalog in code (`resource.action`), with each grant carrying a scope `OWN | TEAM | ORG`.
2. **Fixed system roles** (Owner, Admin, Sales Manager, Sales Executive, HR/Ops). *Phase 1 implementation:* the catalog and role grants are **code** (`src/platform/authz/permissions.ts`), and the membership stores one role code. `Role`/`RolePermission` tables arrive with custom roles (Phase 7); see [ADR-0008](ADR-0008-phase-1-implementation-decisions.md) #5.
3. Enforcement in module commands/queries (`authorize` + scope predicates in SQL). The UI only mirrors.
4. Team leadership (`TeamMembership.team_role = LEAD`) defines `TEAM` scope.

## Alternatives considered
| Alternative | Pros | Cons |
|---|---|---|
| App-level `WHERE org_id` only | Simple | One missed filter = cross-tenant breach; no defence in depth |
| Schema-per-tenant | Strong separation | Migrations × N tenants; pooling/complexity; reporting harder |
| Database-per-tenant | Strongest isolation | Ops cost; premature at 1–300 tenants (kept as an escape hatch for very large tenants) |
| RLS for own/team scope too | Single enforcement point | Complex policies with joins on team membership; harder to test and slower; frequent changes |
| Fully configurable RBAC from day one | Flexible | More UI/test surface; customers misconfigure; not needed for pilot |
| Policy engine (Cedar/OPA/Casbin) | Expressive | Extra dependency and learning; our rules fit a simple catalog |

## Consequences
- (+) Cross-tenant leaks need two independent failures (app + RLS).
- (−) Every request runs tenant work in an interactive transaction (connection held for the transaction's duration), which needs pool sizing and short transactions.
- (−) Reporting across tenants (platform metrics) requires a separate role/views with aggregated, non-PII data.
- Tests: isolation suite and permission matrix are mandatory CI gates.

## Reconsider when
A tenant needs dedicated infrastructure (contractual or > 20% of load) → move that tenant to its own database. Customers demand custom roles → enable Phase 7 custom roles. RLS overhead measured > 10% on hot paths → optimise policies (indexes on `org_id` lead every composite) before considering alternatives.

## References
- PostgreSQL RLS: https://www.postgresql.org/docs/current/ddl-rowsecurity.html · `set_config`: https://www.postgresql.org/docs/current/functions-admin.html
- Next.js data security (authorise inside each Server Action): https://nextjs.org/docs/app/guides/data-security
