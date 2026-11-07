# CBR Property CRM: Phase 0 Blueprint

> **Status (2026-10-20): Phase 1 approved work complete, awaiting review.** Read **[PHASE-1-REPORT.md](PHASE-1-REPORT.md)**. Gate decisions: [PHASE-1-GATE-REVIEW.md](PHASE-1-GATE-REVIEW.md). The Phase 0 decision register and readiness checklist are in [PHASE-0-FINAL-REVIEW.md](PHASE-0-FINAL-REVIEW.md).

## 1. What this is

**CBR Property CRM** is a sales CRM for Indian real estate brokerages (resale, rental, new projects, commercial). It covers:
- lead import and distribution;
- calling (phone and WhatsApp) and follow-ups;
- call scripts;
- tasks and leave cover;
- property matching, site visits, deals and brokerage;
- role-based dashboards with explicitly defined KPIs;
- audit history throughout.

**Business goal:** more lead → site visit → booking conversions, no lead leakage, salesperson accountability, and trustworthy management visibility. Details: [vision-and-scope](product/vision-and-scope.md).

## 2. Repository state discovered (2026-10-19)

- `C:\Users\aDMIN\Desktop\CRM` was **empty**: no application code, no Next.js, no package manifest, **not a git repository**. No existing conventions or files needed preserving.
- Tooling on the machine: Node **24.20.0**, npm 11.19.0, **pnpm 12.9.1**, git 2.55, Docker 29.7. **psql not installed** (Docker Postgres will be used locally).
- Phase 0 added only the `docs/` tree.

## 3. Document map

| Area | Documents |
|---|---|
| Product | [vision-and-scope](product/vision-and-scope.md) · [assumptions-and-open-decisions](product/assumptions-and-open-decisions.md) · [functional-requirements](product/functional-requirements.md) (FR-001…FR-172) · [user-personas-and-roles](product/user-personas-and-roles.md) (permission matrix) · [workflows](product/workflows.md) (A–H) · [lead-lifecycle](product/lead-lifecycle.md) · [metrics-and-kpis](product/metrics-and-kpis.md) · [non-functional-requirements](product/non-functional-requirements.md) |
| Architecture | [system-architecture](architecture/system-architecture.md) · [module-boundaries](architecture/module-boundaries.md) · [domain-model](architecture/domain-model.md) (**also the data dictionary**; consolidated to avoid two drifting copies) · [database-design](architecture/database-design.md) · [erd.mmd](architecture/erd.mmd) |
| Security & compliance | [security-and-threat-model](architecture/security-and-threat-model.md) · [compliance-and-regulatory-notes](architecture/compliance-and-regulatory-notes.md) (added; not legal advice) |
| Integrations | [integration-strategy](architecture/integration-strategy.md) · [calling-and-whatsapp-research](architecture/calling-and-whatsapp-research.md) |
| Delivery | [deployment-and-operations](architecture/deployment-and-operations.md) · [testing-strategy](architecture/testing-strategy.md) · [repository-structure](architecture/repository-structure.md) (incl. code conventions) · [phase-roadmap](architecture/phase-roadmap.md) · [risk-register](architecture/risk-register.md) |
| Review | [PHASE-0-FINAL-REVIEW](PHASE-0-FINAL-REVIEW.md) · [PHASE-1-GATE-REVIEW](PHASE-1-GATE-REVIEW.md) · [S1 report](architecture/spikes/S1-report.md) · [S2 report](architecture/spikes/S2-report.md) |
| Decisions | [ADR-0001 architecture style](architecture/adr/ADR-0001-architecture-style.md) · [ADR-0002 database & ORM](architecture/adr/ADR-0002-database-and-orm.md) · [ADR-0003 authentication](architecture/adr/ADR-0003-authentication.md) · [ADR-0004 multi-tenancy & permissions](architecture/adr/ADR-0004-multi-tenancy-and-permissions.md) · [ADR-0005 background processing](architecture/adr/ADR-0005-background-processing.md) · [ADR-0006 calling strategy](architecture/adr/ADR-0006-calling-integration-strategy.md) · [ADR-0007 deployment](architecture/adr/ADR-0007-deployment-strategy.md) |

## 4. Architecture at a glance

- **Modular monolith** in one TypeScript repo, deployed as **web** (Next.js 16.4.x App Router, pinned at or above the 16.4.1 security floor) and **worker** (BullMQ 6) from the same image.
- **PostgreSQL 18 + Prisma 7.** Keys are UUIDv7, money is `numeric(15,2)` INR, times are `timestamptz` UTC with the org time zone, and phones are E.164 text.
- **Tenant isolation:** `org_id` everywhere, plus **PostgreSQL RLS** (fail-closed, transaction-local `app.org_id`), composite tenant FKs, and a `withTenant()` gateway. Own/team/org scoping is enforced in module commands.
- **Better Auth** handles authentication, while authorisation uses our own **fixed roles + scoped permission catalog** stored in tables.
- **Transactional outbox → BullMQ on Valkey**: idempotent jobs, Job Schedulers, and a reminder backfill sweep.
- **S3-compatible private storage** with presigned uploads/downloads. No binaries in the DB.
- **Hosting:** DigitalOcean Bengaluru (BLR1) is the pilot **candidate** within a provisional ₹15,000/month ceiling. The estimate is ≈ ₹7,600/month with a single database node; DB HA would exceed the ceiling. The deployment is containerised with Terraform. AWS/GCP Mumbai are conditional alternatives, and no migration is planned.
- **Calling:**
  - Phase 3 has `tel:`/`wa.me` launchers (tap = intent, not a call) plus manual outcome logging.
  - Phase 6 adds Indian cloud telephony with verified webhooks, and WhatsApp Cloud API messaging.
  - WhatsApp business calling comes only after a successful PoC.

### Domain modules
identity-access · organizations · audit · notifications · files · leads · lead-imports · assignments · communications · scripts · tasks · leave · properties · site-visits · deals · reporting · integrations

### Role hierarchy
Platform Super Admin (separate from all company roles; no implicit tenant data access; owner-approved, time-boxed support grants) · Company **Owner** (owner-only actions: ownership, Owners/Admins, support access, org deletion, erasure, security policy) → Company **Admin** (day-to-day administration) → **Sales Manager** (team scope) → **Sales Executive** (own scope). **HR/Ops** (optional) sees people and leave only, with no customer data. OD-03 accepted as planning default.

## 5. Phases

| Phase | Theme | Key exit criterion |
|---|---|---|
| 0 | Blueprint (this) | Approval + open decisions answered/defaulted |
| 1 | Foundation: **spikes S1 (RLS) + S2 (identity) first**, then auth, orgs, teams, permissions, audit, worker, CI, staging | S1/S2 PASS; isolation + permission suites green; restore drill done |
| 2 | Lead management: import, dedup, lists, assignment | 100k-row crash-safe import ≤ 10 min, zero duplicates |
| 3 | Salesperson workspace + basic calling + scripts + follow-ups (**MVP**) | Pilot daily use ≥ 80%, outcome logging ≥ 70% |
| 4 | Dashboards, tasks/meetings, reminders, escalation, leave, **basic site visits** | KPI tiles = drill-downs; reminders ≤ 60 s; ≥ 90% visits closed out within 24 h |
| 5 | Properties, matching, property-linked visits, deals, brokerage | Funnel and money reconcile |
| 6 | Telephony, WhatsApp, webhooks, inbound leads | ≥ 99.5% event completeness after reconciliation |
| 7 | AI, automation, custom roles, hardening | External pen-test clean; load at base ×2 |

## 6. Most important decisions

1. Sales stage, interaction outcome, ownership and contactability are **separate concepts** ([lead-lifecycle](product/lead-lifecycle.md)).
2. Call evidence levels L0–L4 are kept distinct. **A tap is never a call; missing data is never fabricated.**
3. KPIs use cohort + maturity windows and assignment-spell attribution, so comparisons between salespeople are fair ([metrics-and-kpis](product/metrics-and-kpis.md)).
4. Lead uniqueness: one open lead per phone per org. Repeat enquiries attach as `LeadEnquiry`.
5. Every use case is one DB transaction including audit and outbox writes.
6. The platform operator is a DPDP **processor**: no use of tenant data for our own purposes.

## 7. Decisions

**Accepted as planning defaults (2026-10-19, subject to final sign-off):**
- OD-01: basic site visits in Phase 4.
- OD-03: Owner/Admin split.
- OD-13: Mailpit locally, production email provider evaluated but not selected.
- OD-14: Pune, Maharashtra pilot, subject to a willing brokerage.
- OD-15: DigitalOcean Bengaluru candidate within ₹15k/month, subject to a priced estimate.
- OD-16: one-brokerage pilot first.

**Still needing business-owner attention:**
- Name the pilot brokerage (OD-14).
- Confirm availability/RPO/RTO targets (OD-02).
- Approve the production email account (OD-13).

The remaining open decisions have documented defaults ([register](product/assumptions-and-open-decisions.md), [final review §2](PHASE-0-FINAL-REVIEW.md)).

**Legal review required before the pilot uses real customer data** (compliance notes §8):
- personal-SIM calling under TRAI TCCCPR (risk R-02, high);
- the DPA and breach-notice terms;
- the lawful basis for imported leads;
- call recording.

## 8. Recommended start for Phase 1 (only after explicit approval)

1. Scaffold the toolchain:
   - Next.js 16.4.2 (security floor ≥ 16.4.1), TypeScript strict, Node 24 LTS, pnpm 12 (with `allowBuilds` and `minimumReleaseAge`);
   - Prisma pinned to 7.10.1;
   - Docker Compose with `postgres:18`, Valkey and Mailpit (MinIO images were withdrawn from Docker Hub; local object storage is decided in Phase 2, gate review D5).
2. Run **Spike S1 (tenant isolation, 18 pass/fail criteria)** and **Spike S2 (identity/organisation, 8 criteria)** from [PHASE-0-FINAL-REVIEW.md §7](PHASE-0-FINAL-REVIEW.md). No other module is built until both pass.
3. Build identity-access, organizations and audit, then the worker skeleton with outbox and email adapter, then CI and staging in the approved hosting.

## 9. Phase 0 completion checklist

- [x] Repository inspected and state documented (§2)
- [x] Vision and scope explicit
- [x] Functional requirements with IDs, priorities, phases and acceptance criteria; MVP distinguished
- [x] Roles and permission matrix; platform admin separated from org admin
- [x] Multi-tenant isolation requirements (NFR-040/041, ADR-0004, database-design §2)
- [x] Lead lifecycle; stage vs outcome distinction
- [x] Import, dedup, assignment, reassignment and audit workflows
- [x] Phone vs WhatsApp calling: separate capabilities, approaches and requirements
- [x] Conceptual domain model and relationships; Mermaid ERDs
- [x] KPI definitions with formulas, sources and attribution rules
- [x] Security, privacy and threat model; compliance notes with confirmed vs needs-legal-review labels
- [x] Hosting, database, queue, storage and monitoring approaches
- [x] Repository structure and code conventions
- [x] All 8 phases with dependencies and exit criteria
- [x] ADRs with trade-offs and references
- [x] Unverified external capabilities explicitly labelled
- [x] Risks and open decisions listed and prioritised
- [x] Cross-document consistency review done (links checked; terms aligned)
- [x] Final review completed: [PHASE-0-FINAL-REVIEW.md](PHASE-0-FINAL-REVIEW.md) (decision register, re-verification, S1/S2 gates)
- [x] **Business-owner written approval to start Phase 1** (2026-10-19, with conditions; see [PHASE-1-GATE-REVIEW §1](PHASE-1-GATE-REVIEW.md))
- [x] **No production CRM modules implemented** (Phase 1 so far: scaffold, `withTenant()` gateway, env validation, UUIDv7 helper and the S1/S2 spikes only)
