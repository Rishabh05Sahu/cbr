# Risk Register

> Status: Phase 0 · Likelihood/Impact: L/M/H · Priority = combined. Reviewed at every phase gate.

| ID | Risk | L | I | Priority | Mitigation | Owner | Validate by |
|---|---|---|---|---|---|---|---|
| R-01 | WhatsApp business-initiated calling is **not actually available** for our +91 number, or needs prerequisites we can't meet (2,000/day messaging tier, WebRTC softphone on mobile) | M | M | **High** | Treat it as optional. Phase 3 uses the app launcher. PoC-4 before any build. BSP confirmation in writing | CTO | Phase 6 PoC |
| R-02 | **TRAI TCCCPR exposure**: executives calling leads from personal SIMs is treated as unregistered telemarketing → SIM barring/disconnection | M | H | **High** | Legal opinion; consent capture; no bulk-dial features; provider calling via registered entity as the scalable path; org policy setting; training note | Product + legal | Before pilot |
| R-03 | DPDP compliance gaps when obligations commence (~May 2027, possibly earlier) | M | H | **High** | Compliance features in Phases 2–4; DPA template; gazette check at every gate | Product + legal | Phase 4 exit |
| R-04 | Telephony provider webhooks unreliable or unsigned → wrong KPIs | M | M | Medium | Reconciliation job; provider PoC with 200 calls; show coverage; never fabricate | Eng | Phase 6 PoC |
| R-05 | **Low executive adoption** (logging feels like overhead) → manual data sparse → dashboards meaningless | H | H | **High** | One-tap logging sheet; auto-prompt after call intent; My Day value for execs; adoption metric K08b visible to managers; pilot feedback loop in Phase 3 | Product | Phase 3 exit |
| R-06 | Prisma 7 + RLS ergonomics (interactive transactions per request, pool pressure, extension caveats) | M | M | Medium | Phase 1 spike; `withTenant` abstraction hides details; load test; fallback: raw `pg` for hot paths, or Drizzle for the module (ADR-0002 reconsideration) | Eng lead | Phase 1 week 1 |
| R-07 | Auth library mismatch (Better Auth org plugin vs our role/scope model; churn after Vercel acquisition) | L | M | Low–Med | Use Better Auth for authentication; keep authorisation in our own tables; spike in Phase 1; abstraction in `platform/auth` | Eng lead | Phase 1 |
| R-08 | KPI disputes affect employee evaluations / morale | M | H | **High** | Published metrics dictionary, fairness rules, low-sample guards, manual vs verified separation; HR sign-off before KPIs are used in evaluations | Product | Phase 4 |
| R-09 | Real-world import files far messier than expected (merged cells, multiple sheets, mixed formats) | H | M | High | Collect 10+ real (anonymised) files from pilot in Phase 1; dry-run mode; mapping templates | Product | Phase 2 start |
| R-10 | Lead leakage despite controls (photos of screens, dialer history) | H | M | Medium | Set expectations: controls deter and audit, they don't prevent; masking + reveal audit + export controls + anomaly alerts | Product | Ongoing |
| R-11 | AI features send PII to third parties | M | H | Medium | Org opt-in, data minimisation, provider DPA, India/approved region processing, legal review | CTO | Phase 7 |
| R-12 | Single-region outage or **single DB node failure** (pilot has no standby, OD-15 budget) | M | H | **High** | 7-day PITR + nightly off-site dumps; DR runbook; RTO ≤ 4 h; quarterly restore drill; buy HA (Advanced Edition or another provider) before a second brokerage or if the pilot SLA demands it | CTO | Restore drills |
| R-13 | Framework security advisories (e.g. Next.js Oct 2026 critical RCE/DoS) | M | H | High | Pin ≥ 16.4.1; advisory watch; patch ≤ 48 h; minimal attack surface (no SVG optimisation, no `use cache` for tenant data) | Eng lead | Continuous |
| R-14 | Scope creep (portal, accounting, HRMS) delays MVP | M | M | Medium | Explicit exclusions in each phase; change requests via ADR/OD | Product | Each gate |
| R-15 | Small team operating Redis + workers + DB | M | M | Medium | Managed services; BullMQ PostgreSQL backend or pg-boss as fallback to drop Redis (ADR-0005) | CTO | Phase 1 |
| R-16 | Provider/messaging costs exceed budget (WhatsApp price changes Oct 2026, INR migration by 31 Dec 2026) | M | M | Medium | Per-org cost visibility; provider features optional and plan-gated; quotes before Phase 6 | Business | Phase 6 |
| R-17 | Dependency on business answers (open decisions) stalls phases | M | M | Medium | Documented defaults; decision deadlines tied to gates | Product | Phase 0 review |
