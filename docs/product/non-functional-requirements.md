# Non-Functional Requirements

> Status: Phase 0 draft. **All numeric targets are proposed planning assumptions** until confirmed by the business (OD-02) and validated by load tests (Phase 4 and Phase 7). IDs: NFR-xxx.

## 1. Workload assumptions (proposed)

| Dimension | Low (pilot) | Base (12–18 months) | High (design ceiling, no re-architecture) |
|---|---|---|---|
| Organisations | 1–3 | 25 | 300 |
| Users per org | 10–30 | 50 (max 200) | 500 |
| Total active users | 50 | 1,250 | 30,000 |
| Peak concurrent users | 20 | 300 | 5,000 |
| Leads per org (incl. closed) | 50k | 250k | 2M |
| Total leads | 100k | 6M | 100M (needs partition review) |
| Concurrent imports (platform) | 1 | 5 | 30 |
| Import file | ≤ 20 MB / 100k rows | same | plan-based up to 500k rows |
| Interactions + activities per day | 3k | 150k | 3M |
| Dashboard loads per day | 200 | 10k | 200k |
| Provider webhooks per day | 0 | 100k | 3M (bursts 100/s) |
| Notifications per day | 1k | 50k | 1M |
| Object storage | 5 GB | 500 GB | 20 TB (media + recordings) |
| Historical reporting horizon | 3 years online | 3 years online | 3 years online; older data archived |

## 2. Performance (server-side p95 at base workload unless stated)

| ID | Target | Validation |
|---|---|---|
| NFR-001 | Lead list (filtered, 50 rows, cursor page) ≤ 500 ms; search by phone fragment/name ≤ 700 ms | k6 test against 250k-lead org |
| NFR-002 | Lead detail workspace data ≤ 400 ms; timeline first 50 entries ≤ 300 ms | k6 |
| NFR-003 | Save interaction/outcome sheet ≤ 500 ms | k6 |
| NFR-004 | My Day ≤ 1 s | k6 |
| NFR-005 | Dashboard (all tiles) ≤ 2 s for orgs ≤ 250k leads, 90-day range | k6 + EXPLAIN review |
| NFR-006 | Import throughput ≥ 300 rows/s per worker; 100k-row file complete ≤ 10 min | Job benchmark |
| NFR-007 | Reminder delivered within 60 s of scheduled time (p95) | Job latency metric |
| NFR-008 | Webhook acknowledgement (2xx) ≤ 1 s p99. Processing is asynchronous | Synthetic webhooks |
| NFR-009 | Core Web Vitals on a mid-range Android (Moto G-class, 4G): LCP ≤ 2.5 s, INP ≤ 200 ms on lead pages | Lighthouse CI / RUM |
| NFR-010 | No list endpoint returns unbounded rows: hard maximum 200 per page; exports go through jobs | Code review rule + test |

## 3. Availability, reliability, recoverability

| ID | Target |
|---|---|
| NFR-020 | Availability 99.5% monthly for the pilot (single database node, no standby, per OD-15 budget), rising to 99.9% at base (requires database HA) (excluding announced maintenance ≤ 4 h/month, outside 09:00–21:00 IST) |
| NFR-021 | **RPO: target ≤ 15 min, not yet verified.** The effective RPO must be **measured** in the restore drill and documented; a 7-day PITR retention window does not by itself guarantee any RPO (owner condition, 2026-10-19). **RTO ≤ 4 h** pilot (accepted by the owner, subject to successful testing), ≤ 1 h at base |
| NFR-022 | Daily logical backups (our own nightly `pg_dump`, since provider PITR covers only 7 days on the pilot candidate) retained 35 days. Monthly backups retained 12 months, stored in a separate account/bucket with deletion protection |
| NFR-023 | **Restore drill quarterly**, documented with the time taken. A backup is not counted as existing until a restore has been tested |
| NFR-024 | Background jobs are idempotent. At-least-once delivery never produces duplicate business effects |
| NFR-025 | Webhooks are deduplicated by provider event id. Processing failures are retried with exponential backoff, then moved to a failed set with alerting |
| NFR-026 | Graceful shutdown: workers finish or release the current job within 30 s of SIGTERM |
| NFR-027 | Object storage: versioning on for documents/import files; durability per provider SLA |

## 4. Security and organisation isolation

| ID | Requirement |
|---|---|
| NFR-040 | Every tenant-owned table has `org_id NOT NULL` and a PostgreSQL RLS policy. The application connects as a role that is not the table owner and lacks `BYPASSRLS` |
| NFR-041 | Automated cross-tenant tests: for every repository function, a user of org A requesting org B's ids gets not-found. Runs in CI |
| NFR-042 | All authorisation is server-side, following the matrix in [user-personas-and-roles.md](user-personas-and-roles.md) |
| NFR-043 | TLS 1.2+ everywhere. HSTS. Secure, HttpOnly, SameSite=Lax session cookies |
| NFR-044 | Secrets only in the platform secret store. Never in the repo, never in `NEXT_PUBLIC_*` |
| NFR-045 | Integration credentials encrypted at the application level (AES-256-GCM, key from KMS/secret store) in addition to disk encryption |
| NFR-046 | Rate limits: login 5/15 min per account + 20/15 min per IP; password reset 3/h; exports 5/day/user (configurable); imports 10/h/org; public webhooks 50 req/s per provider endpoint |
| NFR-047 | Dependency vulnerability scanning in CI. High/critical findings block release unless waived with a reason |
| NFR-048 | Security headers: CSP (nonce-based), X-Content-Type-Options, frame-ancestors none, Referrer-Policy strict-origin-when-cross-origin |

## 5. Privacy

| ID | Requirement |
|---|---|
| NFR-050 | Data minimisation: only fields with a business purpose. PII is never written to application logs (phone/email redaction in the logger) |
| NFR-051 | Customer data hosted in India (Mumbai/Bangalore region) by default. Not mandated by law for this data (see compliance notes), but chosen for latency and customer trust |
| NFR-052 | Support for data-principal access/erasure requests (FR-171) |
| NFR-053 | Retention: configurable per entity. Default: leads indefinitely while the org is active; recordings 90 days; import files 30 days; rejected-row reports 30 days; audit logs 2 years; security/access logs ≥ 1 year (DPDP Rules 6 & 8(3), CERT-In 180-day minimum — see compliance notes; reconciling short-retention items such as import files with Rule 8(3) is **NEEDS-LEGAL-REVIEW**) |
| NFR-054 | On org termination: export available for 30 days, then deletion within 60 days, with backups expiring on their normal cycle |

## 6. Auditability and data integrity

| ID | Requirement |
|---|---|
| NFR-060 | Audit log is append-only for the application role (INSERT/SELECT only, enforced by grants and trigger) |
| NFR-061 | Audit entries contain actor, on-behalf-of, org, action, entity type/id, before/after (PII-redacted), IP, user agent, request id, timestamp |
| NFR-062 | Money is `numeric(15,2)` with currency code. Floats are never used for money |
| NFR-063 | Phone numbers stored as E.164 text, never numeric |
| NFR-064 | Foreign keys on all relations. Status columns constrained by enums/CHECKs |
| NFR-065 | Optimistic concurrency (`version` column) on Lead, Deal, SiteVisit, Task |

## 7. Maintainability

| ID | Requirement |
|---|---|
| NFR-070 | TypeScript `strict` with `noUncheckedIndexedAccess`. No `any` without a justification comment |
| NFR-071 | Module boundaries enforced by lint rules (no imports of another module's internals) |
| NFR-072 | Each module has unit + integration tests. Coverage ≥ 80% lines for domain services. Coverage is not a goal elsewhere |
| NFR-073 | Every migration is reviewed. Destructive migrations use the expand/contract pattern |
| NFR-074 | ADR required for any change to the decisions in `docs/architecture/adr` |

## 8. Observability

| ID | Requirement |
|---|---|
| NFR-080 | Structured JSON logs (pino) with request id, org id, user id (no PII). Security-relevant logs retained ≥ 1 year (DPDP Rule 6(1)(e)); CERT-In requires ≥ 180 days rolling. See [compliance notes](../architecture/compliance-and-regulatory-notes.md) |
| NFR-081 | Error monitoring (Sentry) for web and worker with release tracking. PII scrubbing enabled |
| NFR-082 | Metrics: HTTP latency/error rate, DB pool saturation, queue depth/age per queue, job failure rate, webhook lag, import throughput |
| NFR-083 | Alerts: error-rate spike, queue age > 5 min (reminders), failed-job count, DB CPU > 80% for 15 min, backup failure, disk > 80% |
| NFR-084 | Uptime checks every 1 min from outside the hosting provider |
| NFR-085 | Clocks synchronised to NTP (managed platforms provide this) |

## 9. Accessibility and responsiveness

| ID | Requirement |
|---|---|
| NFR-090 | WCAG 2.2 AA for core flows (login, lead list, lead workspace, log outcome, My Day) |
| NFR-091 | Fully usable at 360 px width. Touch targets ≥ 44×44 px. Primary actions reachable with the thumb |
| NFR-092 | Supported browsers: latest 2 versions of Chrome (Android/desktop), Safari (iOS ≥ 16.4), Edge, Firefox |
| NFR-093 | Interface language English at launch. Strings externalised so Hindi/Marathi etc. can be added (**OD-09**) |
| NFR-094 | Works on flaky 4G: logging forms keep drafts locally and retry submits idempotently |
