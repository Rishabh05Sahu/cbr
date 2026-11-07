# Security Architecture and Threat Model

> Status: Phase 0 draft. Method: STRIDE-style threat list over the assets and trust boundaries below. Each threat lists its controls and the phase in which they must exist. Regulatory context: [compliance-and-regulatory-notes.md](compliance-and-regulatory-notes.md).

## 1. Assets (by sensitivity)

| Asset | Sensitivity | Why |
|---|---|---|
| Lead PII (name, phones, email, budget, notes) | **High** | Customer privacy (DPDP); commercial value; leakage is a core business fear |
| Call recordings, interaction notes | **High** | Voice and conversation content |
| Property owner contacts | **High** | The brokerage's inventory moat |
| Deal values, brokerage, payments | High | Financial and confidential |
| Employee data (leave, performance KPIs) | Medium–High | HR privacy; monitoring concerns |
| Credentials, sessions, API keys, provider secrets | **Critical** | Full compromise path |
| Audit log | High | Integrity is what matters |

## 2. Trust boundaries

1. Browser ↔ web (public internet). 2. Providers ↔ webhook endpoints (public internet). 3. Web/worker ↔ PostgreSQL/Redis/object storage (private network). 4. Tenant ↔ tenant (logical, inside the DB). 5. Platform staff ↔ tenant data. 6. Salesperson ↔ their own device (outside our control once data is displayed).

## 3. Threats and controls

| # | Threat | Scenario | Controls | Phase |
|---|---|---|---|---|
| T1 | **Cross-organisation leakage** | Missing `org_id` filter in a new query; job runs without tenant context; cache key without org | RLS on all tenant tables with FORCE and fail-closed setting; `withTenant` the only DB entry point (lint); composite tenant FKs; no tenant data in Next.js data cache; cross-tenant test suite in CI (NFR-041); jobs carry `orgId` and run through `withTenant` | 1 |
| T2 | **Unauthorised lead access (in-tenant)** | Executive edits URL to another executive's lead id; IDOR in Server Action | Authorisation inside every Server Action and query (Next.js guidance: Server Actions are reachable by direct POST); scope predicates in repositories; return 404 (not 403) for out-of-scope ids; permission matrix tests | 1–2 |
| T3 | **Privilege escalation** | Admin grants self Owner; user changes own role via crafted request; HR accesses leads | Role-change rules in the command (admin cannot grant Owner/Admin); re-authentication for role/ownership changes; roles seeded read-only; permission catalog in code; matrix tests | 1 |
| T4 | **Forged assignment changes** | Executive reassigns leads to self; client submits a stale version | Permission check on **both** source and target scope; optimistic lock; assignment history immutable; audit + manager notification on reassignment | 2 |
| T5 | **Unauthorised / mass export** | Departing employee exports database; screen-scrapes lists | Export permission off by default except Owner; async exports with row cap, watermark (requester + time in file), single-use 15-min links, audit + owner notification; list page size cap 200; per-user **anomaly alert** on unusual lead-view volume (e.g. > 3× 30-day p95) (Phase 4); optional phone masking + audited reveal with daily caps. Note: masking is a deterrent. A user who can call a lead can see the number on their dialer | 2–4 |
| T6 | **Malicious import files** | Zip bomb XLSX, formula injection, huge rows, macro files, XML entity attacks | Size cap before processing; magic-byte type check; reject `.xlsm/.xls`; streaming parser with row/cell/char limits and decompression ratio cap; parse in worker (isolated from web); never evaluate formulas; **CSV/Excel injection protection on export**: prefix cells starting with `= + - @ \t \r` with `'` | 2 |
| T7 | **Injection** (SQL, XSS, header) | Raw SQL with interpolation; rich-text scripts; notes rendered as HTML | Prisma parameterisation; `$queryRaw` only via tagged templates (lint bans `$queryRawUnsafe`); Zod validation for every input; React escaping; scripts' rich text sanitised server-side (allow-list) and rendered via a safe renderer; CSP with nonces | 1 |
| T8 | **Insecure file upload/download** | Upload HTML/SVG served inline → stored XSS; guessable URLs; public buckets | Private buckets; presigned URLs with short TTL; `Content-Disposition: attachment` for documents; images re-encoded (strips EXIF, neutralises polyglots); SVG not accepted; separate download origin/domain if inline display needed; malware scan (Should) | 2/5 |
| T9 | **Secrets exposure** | Provider key in client bundle; `.env` committed; secrets in logs | Only `NEXT_PUBLIC_*` reach the browser, and that prefix is reserved for non-secrets (lint/CI check: allow-list of public vars); `server-only` import guard on modules reading `process.env`; secret store in hosting platform; integration secrets encrypted at app level (AES-256-GCM, key versioning, rotation runbook); gitleaks in CI; log redaction | 1 |
| T10 | **Weak session handling** | Session fixation, stolen cookies, sessions surviving deactivation | Auth library sessions with HttpOnly/Secure/SameSite=Lax cookies; DB-backed sessions revocable instantly; rotation on login and privilege change; idle + absolute timeouts; deactivation revokes sessions; 2FA for Owner/Admin enforceable; Server Actions CSRF protections (Origin check), `allowedOrigins` configured behind proxies | 1 |
| T11 | **Forged / replayed webhooks** | Attacker posts fake "call completed 30 min" events to inflate KPIs | Per-connection secret path token; signature verification (HMAC, constant-time); dedup on event id; timestamp tolerance; IP allow-list where providers publish ranges; reconciliation with provider CDR API; provider-verified figures shown separately from manual | 6 |
| T12 | **Duplicate event processing** | Provider retries; worker crash after side effect | Unique event keys; idempotent handlers; deterministic job ids; monotonic state transitions | 2/6 |
| T13 | **Excessive access to call records/recordings** | All managers can hear all calls; recordings downloaded and shared | Recording permissions off by default; listen = streamed short-lived URL, audited per playback; download only Owner (cfg); retention 90 days default; recordings disabled until org confirms legal review and configures announcement | 6 |
| T14 | **Unauthorised employee monitoring** | Using CRM data for surveillance beyond sales (location, personal calls) | No device location tracking; only CRM-initiated activity is recorded; no reading of personal call logs; employee-facing transparency page ("what is recorded about you"); KPI definitions published; HR role cannot see activity data | 1/4 |
| T15 | **Accidental disclosure of customer contacts** | Owner contact shown in a property share; screenshots; wrong recipient | Share pages expose only approved fields; owner contact separate permission; phone masking option; WhatsApp share messages built from templates without PII of other customers | 3/5 |
| T16 | **Abuse of automated communications** | Bulk WhatsApp templates without opt-in; bulk calling from personal SIMs (TRAI UTM consequences) | Consent and contact-status checks in the send command (server); per-org/per-user daily send caps; no auto-dialler feature; templates need admin approval; opt-out keywords processed automatically; complaint/quality signals monitored | 6 |
| T17 | **Insufficient backups / recovery** | Ransomware or operator error deletes data | PITR; isolated backup copies with object lock; least-privilege DB roles (app cannot DROP); quarterly restore drills; infra-as-code for rebuild | 1 |
| T18 | **Platform staff overreach** | Support engineer browses customer leads | No implicit access; support-access grants approved by owner, time-boxed, audited in both logs; production DB access only via bastion with SSO + session recording; break-glass process (OD-04) | 1 |
| T19 | **Account takeover via password reset** | Email enumeration, token reuse | Generic responses; single-use hashed tokens with 30 min TTL; rate limits; notify user on password change | 1 |
| T20 | **Denial of service / resource abuse** | Expensive dashboard queries; import floods; webhook floods | Rate limits (NFR-046); statement timeouts; queue concurrency caps; per-org import limits; page size caps; upstream WAF/CDN rate limiting | 1–4 |
| T21 | **Supply-chain compromise** | Malicious npm dependency; framework CVE (e.g. Next.js Oct 2026 RCE advisory) | Lockfile + pnpm 12 supply-chain settings in `pnpm-workspace.yaml`: `minimumReleaseAge` (default 1440 min since pnpm 11) and `allowBuilds` allow-list with `strictDepBuilds` (`onlyBuiltDependencies` was **removed in pnpm 11**; verified 2026-10-19); Renovate with grouped updates; `pnpm audit`/OSV scan in CI; pin `next >= 16.4.1` (security floor); SBOM per release | 1 |

## 4. Server-side authorisation requirements for sensitive operations

Every one of these goes through `authorize(ctx, permission, resource)` in the module command, never only in UI: lead read/update/stage/assign/reassign/bulk/import/export/merge/archive/delete/reveal phone; interaction create/edit; recording listen/download; script manage; task create-for-others; leave approve; delegation; property owner contact; deal/brokerage changes; org settings; role/membership changes; integration configuration; audit read; support-access approval; data-principal requests.

## 5. Environment variables policy

| Class | Prefix/location | Examples | Rules |
|---|---|---|---|
| Public (browser) | `NEXT_PUBLIC_*` | `NEXT_PUBLIC_APP_URL`, `NEXT_PUBLIC_SENTRY_DSN` (DSN is designed to be public) | Allow-listed in `src/env.ts`; CI fails on any other `NEXT_PUBLIC_` variable |
| Server-only config | plain env | `DATABASE_URL`, `REDIS_URL`, `S3_BUCKET`, `AUTH_SECRET`, `NEXT_SERVER_ACTIONS_ENCRYPTION_KEY`, `APP_ENCRYPTION_KEYS` | Validated at boot by a Zod schema (`src/env.ts`); module imports `server-only` |
| Per-org integration secrets | DB, encrypted (`IntegrationConnection.secrets_ciphertext`) | Provider API tokens, webhook secrets | Decrypted only in worker/webhook path, never logged, never returned to the UI (UI shows "•••• set on 12 Oct") |

`NEXT_SERVER_ACTIONS_ENCRYPTION_KEY` must be set and identical across all web instances (Next.js self-hosting guidance), so multiple instances can decrypt Server Action closures.

## 6. Rate limiting and abuse controls

Implemented in Redis with sliding windows, keyed by IP + account/org/user:
- Auth: see NFR-046; lockout escalation with email notification.
- Sensitive actions: exports, phone reveals (daily cap), bulk reassign (per hour), invitations (per day).
- Imports: per org concurrency 1 running + 3 queued; per hour 10.
- Webhooks: per connection; excessive invalid signatures → alert + temporary block.
- Public share links: per token and per IP.

## 7. Audit catalogue (minimum)

| Category | Actions |
|---|---|
| Auth/security | login success/failure, logout-all, password reset/change, 2FA enable/disable, session revoked |
| Membership & roles | invite, accept, role change, suspend, deactivate, team membership changes, ownership transfer |
| Leads | create (source), stage change, owner change (single/bulk), contact detail change, contact status change, merge, archive, delete/erasure, **phone reveal**, **export** (with filters + row count), import (counts) |
| Lead access (justified subset) | Viewing a lead **outside own scope via org-wide permission** by non-owners is logged as `lead.viewed` (sampled to 1 per user/lead/day). This gives anomaly detection without logging every page view |
| Communications | recording played/downloaded, integration connected/changed/disabled, webhook signature failures (security log) |
| Money | deal booked/cancelled, brokerage expected change, payment recorded/reversed |
| Configuration | org settings, custom fields, lost reasons, assignment rules, scripts published |
| Platform | org created/suspended, support access requested/approved/used/revoked, break-glass |
| Data-principal | access request fulfilled, erasure executed |

## 8. Consent and contact preferences

- `ConsentRecord` (append-only) per lead, channel and purpose, with basis and evidence.
- `contact_status` on the lead (`OK`, `DO_NOT_CONTACT`, `INVALID`) is the fast check. It is derived/updated in the same transaction as consent withdrawal.
- Imports require the uploader to **attest the lawful source** of the data (stored on the job and as consent basis `IMPORT_ATTESTATION`).
- WhatsApp API sends require an opt-in record for that channel. Business-initiated WhatsApp calls require a current call permission (from Meta's API, cached with expiry).
- Opt-out signals (WhatsApp "STOP", verbal DNC outcome) automatically set DO_NOT_CONTACT for that channel/purpose.

## 9. Security operations

- Incident response runbook with **two clocks**: CERT-In reporting within **6 hours** of noticing a reportable incident, and DPDP Board report within **72 hours** of awareness (the Fiduciary, i.e. the brokerage, reports; we as processor must notify the tenant promptly; contractual target ≤ 24 h, proposed). Applicability of each is in compliance notes.
- Security contact and CERT-In point of contact designated before production launch.
- Annual third-party penetration test before base-workload scale. An internal test is required before the first pilot.
- Vulnerability disclosure page (`/.well-known/security.txt`).
