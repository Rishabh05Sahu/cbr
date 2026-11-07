# ADR-0002: PostgreSQL 18 with Prisma ORM 7

- **Status:** Proposed. **Spike S1 (2026-10-19): 17/18 criteria pass locally** with Prisma 7.10.1 + PostgreSQL 18.6, including concurrency and performance; S1-18 (staging parity) pending ([S1 report](../spikes/S1-report.md)). Confirm after S1-18.
- **Date:** 2026-10-19 (versions verified the same day)

## Context
We need relational integrity, partial/exclusion constraints, row-level security, JSONB for settings/custom fields, trigram search and decimal money. The team is TypeScript-first.

## Decision
- **PostgreSQL 18** (current stable 18.x, supported to Nov 2030). It has a built-in `uuidv7()`, and pg_trgm, citext and btree_gist are available as extensions.
- **Prisma ORM 7.x** (latest stable 7.10.x) with the `prisma-client` generator, the `@prisma/adapter-pg` driver adapter, `prisma.config.ts`, and ESM.
- Prisma 7's supported-databases page lists PostgreSQL 9.6–**18** (re-verified 2026-10-19). Prisma 7 receives fixes and security updates for 18 months after Prisma 8 GA (Prisma release-status page), so it is a safe conservative default.
- **Do not adopt Prisma 8** while it is Early Access/RC. Pin exact versions, because the npm `latest` tag for the `prisma` CLI pointed at an 8.0 RC on 2026-10-19.
- RLS-dependent access goes through our own `withTenant()` interactive transaction that calls `set_config('app.org_id', …, true)` first. Constraints that Prisma's schema cannot express (RLS policies, exclusion constraints, partial unique indexes, triggers) are written as raw SQL in migrations.

## Alternatives considered
| Alternative | Pros | Cons |
|---|---|---|
| Drizzle ORM (0.45 stable; 1.0 RC) | First-class RLS policy declarations, SQL-like, light runtime | 1.0 not yet stable; smaller ecosystem for migrations review tooling; team familiarity assumed lower |
| Kysely + raw SQL | Full control, typed SQL | More hand-written code; no schema-first migrations |
| MySQL | Familiar to some | No RLS, weaker partial/exclusion constraints |

## Advantages / disadvantages
- (+) Mature migrations, typed client, broad docs. Better Auth has an official Prisma adapter.
- (−) Prisma has no native RLS. The official RLS client-extension example is "not intended for production", and explicit `$transaction` usage with that extension may misbehave. Hence our own wrapper.
- (−) Prisma 7 breaking changes (ESM, required generator output, explicit driver adapter, `.env` not auto-loaded, `pg` pool defaults without connect timeout) must be configured deliberately.

## Security & operations
App connects as a non-owner role without BYPASSRLS. Migrations run as a separate role in a release step. Set explicit pool size and connection timeout on the `pg` adapter.

## Reconsider when
The RLS spike shows unacceptable overhead or awkwardness (fallback: Drizzle for data access, keeping PostgreSQL); Prisma 8 reaches GA with stable schema-level RLS (evaluate migration).

## References
- PostgreSQL versioning: https://www.postgresql.org/support/versioning/ · UUID functions: https://www.postgresql.org/docs/current/functions-uuid.html · RLS: https://www.postgresql.org/docs/current/ddl-rowsecurity.html · pg_trgm: https://www.postgresql.org/docs/current/pgtrgm.html
- Prisma 7 supported databases: https://www.prisma.io/docs/orm/v7/reference/supported-databases · system requirements: https://www.prisma.io/docs/orm/v7/reference/system-requirements · release status: https://www.prisma.io/docs/orm/release-status
- Prisma 7 upgrade guide: https://www.prisma.io/docs/orm/more/upgrade-guides/upgrading-to-prisma-7 · Releases: https://github.com/prisma/prisma/releases · RLS extension example: https://github.com/prisma/prisma-client-extensions/tree/main/row-level-security · Prisma 8 EA: https://www.prisma.io/changelog/2026-07-17
- Drizzle RLS: https://orm.drizzle.team/docs/rls
