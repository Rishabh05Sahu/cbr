# ADR-0001: Modular monolith with a separate worker process

- **Status:** Proposed (Phase 0, awaiting blueprint approval)
- **Date:** 2026-10-19

## Context
CBR Property CRM needs strong transactional consistency (assignment + history + audit + tasks together), a small initial team, a single first tenant, and reliable background work (imports, reminders, webhooks). Scale targets (NFR §1) are well within one PostgreSQL primary for years.

## Decision
Build a **modular monolith**: one TypeScript repository and one build, organised into business modules with enforced public interfaces (module-boundaries.md). It is deployed as two process types: **web** (Next.js App Router) and **worker** (BullMQ consumers + schedulers). Both share PostgreSQL, Redis-compatible storage and object storage.

## Alternatives considered
| Alternative | Pros | Cons |
|---|---|---|
| Microservices (leads, comms, reporting…) | Independent scaling/deploys | Distributed transactions, ops burden, slower delivery; no team-size or scale driver |
| Single Next.js app with background work inside requests/serverless functions | Simplest deploy | Long imports and retries break on request timeouts and instance recycling; no persistent schedulers |
| Separate backend API (NestJS) + Next.js frontend | Clear API boundary for future mobile apps | Two deployables and a duplicated auth/validation layer before it's needed |

## Consequences
- (+) One transaction per use case; simple local development; fast iteration.
- (+) Modules can be extracted later (system-architecture.md §9 triggers).
- (−) Boundary discipline relies on lint rules and review.
- (−) Web and worker share a release cadence.
- Security: one codebase means one authorisation implementation used by both web and worker.
- Operations: two process types to monitor, which is acceptable.

## Reconsider when
Engineering team > ~25 with separate release needs; a module has scaling characteristics radically different from the rest (e.g. real-time media for WhatsApp calling, which may justify a separate media service); regulatory isolation needs.

## References
- Next.js self-hosting / `output: 'standalone'`: https://nextjs.org/docs/app/api-reference/config/next-config-js/output
