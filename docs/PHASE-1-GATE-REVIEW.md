# CBR Property CRM: Phase 1 Gate Review (Steps 1–4)

> **Status (2026-10-20): gate review answered.** The owner decided D1–D5 on 2026-10-19 (§6), and Phase 1 continued under those conditions. Results: [PHASE-1-REPORT.md](PHASE-1-REPORT.md).
> **No real customer data** has been used. All tests use synthetic data on local Docker databases. **No hosting infrastructure** has been provisioned.

## 1. Approval recorded

The business owner approved Phase 1 on 2026-10-19 under these conditions. They are binding for Phase 1.

| Decision | Recorded as |
|---|---|
| Pilot database | **Accepted:** single-node PostgreSQL, no standby, for the controlled pilot only. Reassess HA if customer requirements, criticality or operating evidence justify it (OD-15, risk R-12) |
| Budget | Provisional ₹15,000/month, excluding telephony, WhatsApp, taxes and variable third-party costs. A **full cost estimate** (app, database, workers, cache/queue, storage, email, monitoring) is required **before provisioning production infrastructure** |
| Availability / recovery | 99.5% availability. Restore service within **4 h, subject to successful testing**. 7-day recovery window, subject to provider PITR. Encrypted off-site backups. Documented recovery procedure |
| RPO | **Not assumed** from the 7-day PITR window. It must be measured and documented. NFR-021 and database-design §12 were reworded accordingly |
| Execution order | Step 1 scaffold → Step 2 S1 → Step 3 S2 → **Step 4 stop and report** → Step 5 only after S1 and S2 pass |
| Out of scope | Phase 2 and later features; production launch; real customer leads |
| Before live customer data | Isolation + RBAC tests pass; restore demonstrated with the 4 h target tested; effective RPO, recovery process and limitations documented; security controls and legal/regulatory review complete (calling channels, personal data). Until then: synthetic or anonymised data only |

## 2. What was done

### Step 1: repository and local environment

- **Git** initialised on branch `main`. **Nothing committed yet**: commits are made only on your instruction.
- **Next.js 16.4.2 App Router** scaffold (React 19.3.1, Tailwind 4.3.3). Health route `/api/health`. The production build succeeds.
- **TypeScript strict:** `strict`, `noUncheckedIndexedAccess`, `exactOptionalPropertyTypes`, `noImplicitOverride`, `verbatimModuleSyntax`. ESM.
- **ESLint** (Next.js core-web-vitals + TypeScript), with two architecture guards:
  - raw DB clients are allowed only in `src/platform/db`;
  - the auth library is allowed only in `src/platform/auth`.
  - **Prettier** is configured.
- **pnpm supply-chain policy** (`pnpm-workspace.yaml`):
  - `minimumReleaseAge` of 7 days, with named, justified exceptions;
  - `strictDepBuilds`, with an `allowBuilds` allow-list.
  - The install passed with no violations.
- **Docker Compose** for local services only:
  - `postgres:18.6-trixie` with the role-creation script;
  - `valkey/valkey:9.0.6-alpine` (noeviction, AOF);
  - `axllent/mailpit:v1.31.5`.
  - Every image is pinned to an exact tag, and every port is bound to 127.0.0.1 only.
- `src/env.ts`: Zod-validated server environment. It refuses an owner or admin database user (`postgres`, `doadmin`, `crm_migrator`) as `DATABASE_URL`.
- `src/lib/uuidv7.ts`: RFC 9562 UUIDv7 generator.

**Pinned versions:**

| Package | Pinned | Note |
|---|---|---|
| next / eslint-config-next | 16.4.2 | Security floor ≥ 16.4.1. Age-rule exception (security release) |
| react / react-dom | 19.3.1 | Same-day security release (back-ported to 19.1/19.2). Age-rule exception |
| prisma / @prisma/client / @prisma/adapter-pg | 7.10.1 | Approved pin (`latest` is an 8.0 RC). Age-rule exception |
| better-auth | 1.7.11 | Version ADR-0003 was reviewed against; fixes `exactOptionalPropertyTypes` typing. Age-rule exception |
| pg | 8.23.1 | |
| zod | 4.6.6 | |
| typescript | **6.0.3** | **Deviation:** TypeScript 7.0.2 (the native compiler) is current, but typescript-eslint supports only `< 6.1` |
| eslint | **9.39.5** | **Deviation:** ESLint 10 is current, but the React/import/a11y plugins used by `eslint-config-next` support only ESLint ≤ 9 |
| vitest | 5.0.3 | |
| pnpm (`packageManager`) | **12.12.1** | **Deviation:** 12.14.0 is 4 days old; 12.12.1 meets the 7-day rule |
| Node | 24.x (`.nvmrc`, `engines`) | Machine has 24.20.0 |

**Other Step 1 deviations:**
- **No local object storage.** MinIO images are no longer published on Docker Hub. File uploads are not needed until Phase 2, so the choice is deferred: §3, D5.
- **The Mailpit UI is on port 54025.** Windows reserves ports 57993–58092 on this machine.
- **shadcn/ui is not initialised yet.** It arrives with the app shell in Step 5. Tailwind 4 is in place.

### Step 2: S1 tenant isolation

**17 of 18 PASS, S1-18 NOT RUN.** Full report: [spikes/S1-report.md](architecture/spikes/S1-report.md).
- Cross-org reads and writes were blocked through the ORM, raw SQL, the Server Action, Route Handler, webhook and worker paths, and the pre-tenant definer functions.
- The concurrency test ran 50,000 transactions over a pool of 5 connections, with 10% rollbacks, and found **0 leaks**.
- On 250,000 leads, list p95 was 11–30 ms against a 500 ms limit. RLS overhead was ≤ 6.2% at p50, with identical query plans.
- **A mutation check proved the suite catches leaks.** A permissive policy and a session-level context were each detected and fail the suite.
- **S1-18** (repeat on the managed staging database) could not run, because no staging database exists. See D1.

### Step 3: S2 identity and organisation

**8 of 8 PASS, using the Better Auth organization plugin** (not the fallback). Full report: [spikes/S2-report.md](architecture/spikes/S2-report.md).
- Proven:
  - email/password with verification;
  - sign-out-all;
  - 30-minute, single-use password reset;
  - session revocation on suspend;
  - TOTP enrolment and sign-in.
- Single-role enforcement works in three layers: a hook, a request guard and a database CHECK.
- Owner invariants hold, including Admin-on-Admin protection.
- Invitations: 7-day expiry, a verified matching email, and team placement in **our** table.
- The active org drives `withTenant`, and membership is re-checked on every request.
- Platform admins are denied tenant data unless the Owner approves a grant. Grant access is time-boxed, audited in both logs, and **database-enforced read-only**.

**Totals:** 149 tests (96 S1, 45 S2, 8 unit). They pass from a freshly created database volume. Typecheck, lint, Prettier and `next build` are clean.

## 3. Decisions requested

| # | Decision | Options | Recommendation |
|---|---|---|---|
| **D1** | **S1-18 staging parity cannot run without a managed database.** The gate rule says every S1 criterion must pass before further modules | (a) Authorise a **small, short-lived managed PostgreSQL 18 instance** (DigitalOcean BLR1) only to run S1-18. This needs your DigitalOcean account/API token, and the cost estimate first if you treat it as infrastructure under §1 of the approval. (b) Accept S1 as passed **locally**, start Step 5 locally, and make S1-18 a **hard gate before any staging deploy or real data** | **(b)**. Every Step 5 module is built and tested locally first, and the provider-specific risk (role creation by `doadmin`) does not change local design. If S1-18 later fails, the remedy is a hosting change (ADR-0007), not a code change. I will produce the full cost estimate before any provisioning |
| **D2** | `crm_auth` role for Better Auth: the library reads memberships/invitations across orgs; business code stays strictly per-org ([S2 §3.1](architecture/spikes/S2-report.md)) | A: `crm_auth` (implemented). B: ADR-0003 fallback, our own membership/invitation tables (+3–5 days). C: relax `crm_app` policies (**rejected**) | **A** |
| **D3** | Invitation link carries the invitation id instead of a hashed token ([S2 §3.2](architecture/spikes/S2-report.md)) | Accept with the proven mitigations / build our own invitation tokens | **Accept for the pilot**, recorded in domain-model.md |
| **D4** | Version deviations: TypeScript 6.0.3, ESLint 9.39.5, pnpm 12.12.1, and the four age-rule exceptions | Accept / require different pins | **Accept.** Revisit when typescript-eslint supports TypeScript 7 and the Next.js lint plugins support ESLint 10 |
| **D5** | Local S3-compatible storage (MinIO images withdrawn) | SeaweedFS, Garage, RustFS, or a pinned MinIO build from another registry | **Decide in Phase 2** (first file upload). Not needed for Phase 1 |

## 4. Conditions before live customer data

| Condition | Status |
|---|---|
| Tenant isolation and RBAC tests pass | Isolation **passed locally**. S1-18 is pending. The RBAC permission-matrix suite is part of Step 5 |
| Backup restore demonstrated; 4 h restore target tested | **Not started.** Needs staging/production hosting |
| Effective RPO, recovery process and limitations documented | **Not started.** RPO will be **measured** in the restore drill, not inferred from PITR retention |
| Security controls + legal/regulatory review (calling channels, personal data) | **Not started.** Legal review is owner-initiated (compliance notes §8) |
| Full cost estimate before production provisioning | **Not started.** It will precede any provisioning |

## 5. Next permitted step

**None until you respond.** With D1(b), D2(A), D3 and D4 accepted, Step 5 builds the foundations your approval names, locally and with synthetic data:
- identity;
- organisation;
- membership;
- permissions;
- profile;
- audit.

The other Phase 1 items in [final review §8](PHASE-0-FINAL-REVIEW.md#8-phase-1-scope-and-exclusions) need your confirmation that they are covered by this approval:
- worker/outbox and email adapter;
- app shell;
- CI;
- staging and the restore drill.

Phase 2 features remain excluded.

## 6. Owner decisions recorded (2026-10-19)

| # | Decision |
|---|---|
| D1 | Local S1 results accepted to continue development; **S1 is not marked fully passed**. S1-18 on a managed database is mandatory before the staging application is deployed or real data is used. Provisioning that database needs a complete cost estimate and approved spend first. Use synthetic data and keep the results |
| D2 | Separate least-privileged Better Auth role approved. Its access is limited to auth/organisation/membership/invitation tables, with no CRM data, audit or operational teams. No superuser or BYPASSRLS. Cross-org access must be documented, and role escalation and org isolation tested, with app-level permission checks preserved |
| D3 | Invitation ids approved, provided that: invitations expire after 7 days; the invitee is signed in with a verified, matching email; `requireEmailVerificationOnInvitation: true`; ids are unpredictable; creation, lookup and acceptance are rate-limited; listing and admin access are restricted; cancellation is supported and expired/accepted invitations are handled safely; and no sensitive URLs are logged |
| D4 | Dependency versions approved (TypeScript 6.0.3, ESLint 9.39.5, pnpm 12.12.1, plus the security-patched and approved pins). Lockfile committed, exceptions documented, checks run after changes, no unbounded ranges or silent prereleases |
| D5 | File storage deferred to Phase 2. No withdrawn MinIO images and no unreviewed substitute in Phase 1 |

The approved remaining Phase 1 scope:
- foundations;
- app shell;
- worker, outbox and Mailpit;
- CI and security regression tests;
- staging configuration and preparation of the managed-DB tests;
- backup/restore testing and RPO measurement;
- a complete cost estimate before any paid infrastructure.
