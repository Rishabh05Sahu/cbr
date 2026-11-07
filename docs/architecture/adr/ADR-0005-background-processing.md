# ADR-0005: BullMQ 6 on Redis/Valkey with a PostgreSQL transactional outbox

- **Status:** Proposed
- **Date:** 2026-10-19 (BullMQ 6.3.x verified)

## Context
Imports, reminders, notifications, webhook processing, exports and scheduled sweeps must run outside request handlers. They need retries with backoff, idempotency, schedules and monitoring. Jobs must not be lost or enqueued for rolled-back transactions.

## Decision
- **BullMQ 6.x** in a dedicated **worker** process, backed by managed **Valkey/Redis** with `maxmemory-policy noeviction` and persistence.
- **Job Schedulers** (`upsertJobScheduler`) for periodic jobs. Legacy repeatable jobs were removed in v6.
- **Transactional outbox** in PostgreSQL: use cases write `OutboxEvent` rows in their transaction, and a relay enqueues them with deterministic `jobId`s.
- Idempotent handlers. Retries with exponential backoff + jitter. Non-retryable errors via `UnrecoverableError`. Failed jobs retained 30 days, with alerting and an admin retry screen (our dead-letter equivalent).
- Reminders: delayed jobs plus a periodic backfill sweep from Postgres (the source of truth).

## Alternatives considered
| Alternative | Pros | Cons |
|---|---|---|
| **BullMQ PostgreSQL backend** (new in v6, same API) | No Redis to run | New (Jul 2026), ~1.5–2× lower throughput, maturity label not stated in docs. **Kept as a fallback**: same API, so switching is low-cost |
| pg-boss (12.x) | Postgres-only, transactional job creation, DLQ, cron | Different API; Node ≥ 22.12; lower throughput than Redis for bursts |
| Managed queues (SQS + EventBridge) | Fully managed | Ties us to AWS; scheduling/delays less ergonomic; two systems locally |
| Vercel Cron / platform cron + HTTP | Simple | No persistent workers; time limits; at-least-once semantics still needed |
| Inngest / Trigger.dev (hosted workflow) | Great DX | External data processing (PII leaves our region); cost; vendor dependency |

## Consequences
- (+) Mature queue with rate limiting, delays, priorities, metrics. One familiar API.
- (−) One more managed service (Valkey). Mitigated by the outbox + backfill, so Valkey is reconstructable.
- Operations: monitor queue depth/age and failures (NFR-082/083). Graceful shutdown on deploy.
- Security: job payloads contain ids only (no PII) and are re-authorised in handlers.

## Reconsider when
Operating Valkey becomes a burden at small scale → switch to the BullMQ PostgreSQL backend after a load test. Throughput needs exceed a single Redis primary → Redis cluster/sharded queues.

## References
- BullMQ changelog (v6): https://docs.bullmq.io/changelog · Going to production: https://docs.bullmq.io/guide/going-to-production · Job ids: https://docs.bullmq.io/guide/jobs/job-ids · Deduplication: https://docs.bullmq.io/guide/jobs/deduplication · Retries: https://docs.bullmq.io/guide/retrying-failing-jobs · PostgreSQL backend: https://docs.bullmq.io/guide/postgresql
- pg-boss: https://github.com/timgit/pg-boss
