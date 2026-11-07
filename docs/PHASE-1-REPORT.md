# CBR Property CRM: Phase 1 Report

> **Date:** 2026-10-20. **Scope:** the Phase 1 work approved on 2026-10-19 ([gate review §6](PHASE-1-GATE-REVIEW.md#6-owner-decisions-recorded-2026-10-19)).
> **Not done, by design:**
> - no paid infrastructure provisioned;
> - no staging application deployed;
> - no real customer data;
> - no Phase 2 features;
> - **no Git commits yet**: at your request, commits are made at the end, once you confirm the author identity (§8).

## 1. Implemented foundations and their tests

| Area | What exists | Main tests |
|---|---|---|
| **Identity** | Email/password with verification. Invitation-only sign-up (closed for everyone else). Password reset (30 min, single use, revokes sessions). TOTP 2FA with backup codes. Sign out everywhere. Session revocation on suspend/remove | Integration `members.test.ts`; e2e `auth-routes.test.ts` (real sign-up → email → verify → accept; reset via email) |
| **Organisations** | Platform-provisioned orgs (name, slug, status, time zone, locale); settings page; org suspension by the platform | `teams-settings-audit.test.ts`, `platform-support.test.ts` |
| **Membership** | Single role per member (DB CHECK + library hooks + request guard). Invite / cancel / accept with optional team. Role change. Suspend / reactivate / remove (= deactivate, history kept). HR profile fields. Owner-only rules for Owners/Admins | `members.test.ts`, `cross-org-isolation.test.ts`, e2e `route-isolation.test.ts` |
| **Permissions** | Code catalog for the Phase 1 permissions × 5 roles with OWN/TEAM/ORG scope; `authorize()` in every module function; read-only support role; page guard (404) | Unit `permissions.test.ts` (approved matrix), integration + e2e role tests |
| **Teams** | Teams, members, team leads as history spells; TEAM scope from led teams | `teams-settings-audit.test.ts` |
| **Profiles** | Own name and mobile (normalised to E.164) | Unit `profile.test.ts`, integration, e2e |
| **Audit** | Append-only org audit for every change (people, roles, teams, settings, invitations, support access); platform audit; keyset pagination; secret-key filtering | `teams-settings-audit.test.ts`; DB denies UPDATE/DELETE |
| **Support access** | Platform request → Owner approval → time-boxed (≤ 72 h), **read-only**, audited in both logs; Owner can revoke | `platform-support.test.ts`, e2e |
| **App shell** | Responsive shell, permission-filtered navigation, org switcher, sign-in / 2FA / reset / invitation pages, settings pages, platform console, error/404 pages; security headers (CSP, HSTS, frame-ancestors none, nosniff) | e2e page tests |
| **Worker / outbox / email** | Transactional outbox (same transaction as the change), relay via definer functions, BullMQ with idempotent job ids, event handlers under `withTenant(event.org)`, email adapter (SMTP → Mailpit locally) | `worker-outbox.test.ts`; e2e emails delivered by the **real worker process** |
| **CI / security regression** | `.github/workflows/ci.yml`: checks, secrets scan, integration + e2e + spikes on Compose services, Docker builds; actions pinned to SHAs | Not run on GitHub yet (no remote); every step was run locally |
| **Deployment artefacts** | Dockerfile (web / worker / migrate targets, non-root); managed-DB role bootstrap SQL; staging runbook | Images built locally; web container smoke-tested; bootstrap SQL run in a throwaway PG 18.6 |

**Test totals (final run, 2026-10-20):** see §1.1.

### 1.1 Final verification run

`pnpm build` + `build:worker`, then lint, typecheck and Prettier (all clean), then every test project in one run. Log: `spikes/results/phase1-full-run.log`.

| Project | Tests | Result |
|---|---|---|
| unit (permission matrix, env, logger redaction, templates, phone, UUIDv7) | 75 | pass |
| integration (production schema: roles/RLS/escalation, members, invitations, teams, settings, profile, audit, support, platform, cross-org, outbox/worker/email) | 94 | pass |
| e2e (built server + real worker: auth routes, pages, Server Actions, isolation, CSRF, rate limits, email flows) | 53 | pass |
| S1 spike (incl. 50,000-transaction concurrency, 0 leaks; 250k-lead performance: p95 ≤ 32 ms, RLS overhead p50 +4.2%) | 96 | pass |
| S2 spike | 45 | pass |
| **Total** | **363 / 363** | **pass** |

**D3 logging check:** the run log contains the web server's and worker's output. It has 0 occurrences of reset tokens, invitation URLs or reset links.

## 2. S1 / S2 results and unresolved findings

- **S1:**
  - 17/18 pass locally, re-run in the final run.
  - **Not fully passed (D1):** S1-18 needs the managed database.
  - The new production schema adds its own RLS coverage, role-hardening and escalation tests (`db-roles.test.ts`).
- **S2:** 8/8 pass; D2 and D3 implemented as approved.
- **Findings during Phase 1 (fixed, each with a regression test):**
  1. **Closed sign-up bypass.** The first implementation used an async-context "provisioning" flag that **leaked through pooled connections**, so self-service sign-up still worked. Replaced with the library's `validateUserInfo` gate (ADR-0008 #2).
  2. **CSRF checks silently disabled by environment.** Better Auth turns off origin/CSRF checks when `NODE_ENV=test` or `TEST` is set. Now forced on in config (ADR-0008 #3); the e2e suite proves a cross-origin request is refused.
  3. **Library errors not mapped.** The library's error class exists in more than one module copy, so `instanceof` failed and the invite page crashed instead of answering "not available". Fixed with a structural check.
  4. **India's time zone rejected.** The runtime's zone list names India `Asia/Calcutta`, so the org's own default `Asia/Kolkata` failed validation. Fixed.
  5. **Test-validity bug.** Mixed-case test emails made some "not on page" checks vacuous; fixed, and those checks now bite.
- **Mutation checks:** the suites were run against deliberately broken code and policies, which were then reverted. All were caught:

  | Deliberate break | Tests failed |
  |---|---|
  | `authorize()` removed from suspend/remove | 4 real-route tests |
  | Permissive RLS policy on teams | 5 isolation tests |
  | (Phase 1 gate) permissive lead policy | 6 tests |
  | (Phase 1 gate) session-level tenant context | 3 tests |

- **Unresolved:**
  - S1-18 (managed DB, after approved spend);
  - PgBouncer transaction pooling with Prisma (verify in S1-18);
  - whether the load balancer's `X-Forwarded-For` can be trusted for rate-limit keys (staging check, runbook §4.3);
  - email provider still unselected (OD-13);
  - 2FA *enforcement* for Owner/Admin is not built. It is a security-policy setting (`org.security_policy.manage`); recommend it before real data.

## 3. Actual-application-route isolation coverage

The suites run against the **built production server** (`next build`, standalone, `NODE_ENV=production`) and the real worker. Pages are fetched, and Server Actions are invoked over HTTP exactly as the browser does.

| Route class | Covered |
|---|---|
| App pages (6) | For an org-A Owner, no org-B data on any page. Members page scoped by role. Audit/support pages 404 for roles without permission. `/platform` 404 for non-platform users |
| Server Actions (all mutating actions) | 11 actions called with org-B ids from an org-A session → `NOT_FOUND`, org B unchanged. Role matrix: executive/manager/HR refused for invite, role change, suspend and team management. Admin refused on Owner/Admin. Platform actions refused for customers. Switching to a non-member org refused. No session → refused. Cross-origin action → rejected by the framework |
| Session integrity | Forged active org in the session → pages redirect, actions refused. Suspension via the real route ends the victim's session immediately |
| Auth routes (`/api/auth/*`) | 13 org-admin/user-mutation endpoints → 404. CSRF (cross-origin, cookie-bearing) → 403. Sign-in rate limit → 429 at the 11th attempt. Sign-up without invitation creates nothing. Invitation and reset flows end to end through Mailpit |
| Platform support | No grant → no data; approved grant → read-only data, audited; writes refused |

**Not covered yet:** the same suites against **staging** (runbook §4). That is a precondition for real data.

## 4. RPO and recovery-test results

Full details: [recovery-test-results.md](architecture/recovery-test-results.md). All results so far are **local** (method validation).

| Test | Result |
|---|---|
| Logical backup/restore (138 MB synthetic DB) | dump 1.6 s, restore 2.3 s; 9 tables identical; RLS/policies/grants/definer owners intact; restored DB fails closed. **PASS** |
| PITR (WAL archive, crash mid-write) | **Measured RPO 10.8 s** (41 committed rows lost; bounded by the 30 s archive timeout); recovery 2.2 s; point-in-time target exact. **PASS** |

**Key point for the owner:** the 7-day PITR window is how far back we can restore. It is **not** the data-loss window. The managed provider's real RPO and the 4 h end-to-end recovery are measured on staging (runbook §3) before real data.

## 5. Remaining gates (before staging deploy and real customer data)

| Gate | Blocks | Owner action |
|---|---|---|
| G1 Approve the hosting spend ([estimate](architecture/hosting-cost-estimate.md)) | Any provisioning | **Decision needed** |
| G1a Confirm DB HA pricing in the DigitalOcean panel (finding below) | Choice of single-node vs HA | Decision after confirmation |
| G2 S1-18 on the managed DB | Staging app deploy | Engineering, after G1 |
| G3 Real-route isolation suites against staging | Real data | Engineering |
| G4 Managed restore drill: RPO measured, 4 h RTO tested, documented | Real data | Engineering |
| G5 Legal/regulatory review (calling channels incl. personal-SIM calling, DPDP, DPA, lawful basis for imported leads, recording) | Real data | **Owner to engage counsel** |
| Email provider selection (OD-13) | Staging email | **Decision needed** (SES ap-south-1 recommended) |
| Named pilot brokerage (OD-14) | Phase 2 | **Owner** |
| 2FA enforcement for Owner/Admin (recommended) | Real data (recommended) | Approve as Phase 1 hardening |

## 6. Complete proposed hosting cost estimate

[hosting-cost-estimate.md](architecture/hosting-cost-estimate.md). Recommended setup: DigitalOcean BLR1 App Platform + managed PostgreSQL 18 (single node) + Valkey + Spaces + registry + monitoring + email + domain, **plus a staging environment**.

| | USD/month | ₹/month |
|---|---|---|
| Production | 92.82 | 8,823 |
| Staging | 40.15 | 3,816 |
| **Total before tax** | **132.97** | **12,639** (within ₹15,000) |
| With 18% GST (outside the ceiling) | 156.90 | 14,914 |

**Finding:** DigitalOcean's current documentation prices a **Standard-plan standby node at the same price as the primary**. That would make production DB high availability ≈ +₹2,900/month (≈ ₹15,533 total pre-tax; ≈ ₹12,670 if staging runs only when needed). The Phase 0 basis for accepting no HA was the ≈$260 Advanced Edition. **Please let us confirm this in the control panel before you decide HA vs single node.** The approved single-node decision stands until then.

## 7. Changes to the approved architecture or dependencies

All are recorded with trade-offs in [ADR-0008](architecture/adr/ADR-0008-phase-1-implementation-decisions.md):
1. Auth-library org-admin HTTP endpoints disabled; one authorised, rate-limited, audited Server Action path per mutation.
2. Closed sign-up via `validateUserInfo`; platform owner provisioning writes via `crm_auth`.
3. Origin/CSRF checks forced on.
4. "Remove member" = deactivate (rows never deleted).
5. Permission catalog in code; `Role`/`RolePermission` tables deferred to custom roles (Phase 7). This changes the ADR-0004 wording.
6. Shared Valkey rate limiter for library endpoints and Server Actions.
7. Auth emails queued directly (not via the outbox), with short retention in Valkey.
8. Support access read-only in Phase 1 even for WRITE grants.
9. Platform "open org for support" via the platform user's session row; grant still required.
10. shadcn/ui deferred; hand-written Tailwind primitives.
11. One Docker image with web / worker / migrate targets.
12. Outbox relay through definer functions.

**Dependencies added** (exact pins, all ≥ 7 days old):
- runtime: `bullmq` 6.3.12, `ioredis` 5.11.1, `nodemailer` 10.1.0, `pino` 10.4.0;
- dev: `@types/nodemailer` 8.0.2, `esbuild` 0.28.2;
- build script for `msgpackr-extract` **denied**.

The D4 pins are unchanged.

## 8. Git

**Nothing is committed yet**, as you asked. The global Git author on this machine is "Your Name" <rishabh@affex.health>, which looks like a placeholder. Please confirm the author identity. The prepared plan, after a final diff review, is four commits:
1. Phase 0 docs;
2. Phase 1 scaffolding;
3. S1/S2 proofs of concept and gate review;
4. Phase 1 foundations, tests, CI, deployment and recovery artefacts, and this report.

Excluded from Git:
- `.env`, Docker volumes, `.next/`, `dist/`;
- generated Prisma clients, `node_modules/`;
- local logs and results (the JSON recovery results are kept).
