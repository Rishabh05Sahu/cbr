# Phased Development Roadmap

> Status: Phase 0 draft. Phases are sequential gates. A phase starts only when the previous phase's exit criteria are met **and** the blueprint owner explicitly approves. Durations are rough estimates for 2–3 engineers and need re-planning at each gate.

## Decide-early items (expensive to change later)

These are fixed in Phase 0/1 and must not drift:
1. **Tenant isolation:** `org_id` on every tenant table, RLS, composite FKs, `withTenant` (ADR-0004).
2. **Identifiers:** UUIDv7 everywhere. Human codes separate.
3. **Permission catalog and scope model** (own/team/org) plus roles stored in tables.
4. **Audit log and activity timeline** shape. Append-only.
5. **Lead ↔ enquiry ↔ assignment-spell** relationships (KPI attribution depends on them).
6. **Interaction model:** manual vs provider evidence, CallIntent separate (calling KPIs depend on it).
7. **Event ownership:** transactional outbox, job idempotency keys.
8. **Time and money types** (`timestamptz` UTC + org TZ; `numeric(15,2)` INR).
9. **Module boundaries** and lint enforcement.

---

## Phase 0: Product specification and architecture (current)

| Item | Detail |
|---|---|
| Objective | A reviewed blueprint that guides all later phases without redesign |
| Included | Requirements, assumptions, roles/permissions, lifecycle, KPIs, workflows, NFRs, architecture, domain model, ERD, security/threat model, compliance notes, integration research, deployment, testing, repo structure, ADRs, risks |
| Excluded | Any application code, scaffolding, migrations, UI, provider accounts |
| Dependencies | — |
| Exit criteria | Final review completed ([PHASE-0-FINAL-REVIEW.md](../PHASE-0-FINAL-REVIEW.md)); OD-01, 03, 13–16 accepted as planning defaults; remaining ODs have documented defaults and deadlines; **explicit written approval to start Phase 1**; legal review engaged for compliance notes §8 |
| Deliverables | `docs/**` |

## Phase 1: Application foundation

| Item | Detail |
|---|---|
| Objective | A secure, multi-tenant skeleton that every later module builds on |
| Included | Repo scaffolding (Next.js 16.4.x ≥ 16.4.1, TS strict, pnpm, ESLint/Prettier, shadcn/ui + Tailwind 4); env validation; Docker Compose local stack; Prisma 7 + PG 18; `withTenant` + RLS + DB roles; Better Auth (email/password, reset, invitations, 2FA option, sessions); organisations, memberships, roles/permission catalog, `authorize`/`scopeFor`; teams & team leads; profiles; org settings (base); audit log + viewer; platform admin area (orgs CRUD) + support-access grants; outbox + BullMQ worker skeleton + email adapter; app shell (responsive nav, org switcher); Sentry, pino, health check; CI pipeline; staging environment; backup/restore drill #1 |
| Excluded | Leads, imports, calling, dashboards |
| Dependencies | Phase 0 approval; OD-03 (accepted); OD-15 (priced estimate within ₹15,000/month or approved exception); OD-13 production provider can be chosen during Phase 1 (Mailpit locally). **Gate: Spike S1 (tenant isolation / RLS) and Spike S2 (identity & organisation model) must both PASS against the criteria in [PHASE-0-FINAL-REVIEW.md §7](../PHASE-0-FINAL-REVIEW.md) before any module beyond identity-access, organizations and audit is built** |
| DB/domain introduced | Organization, OrgSettings, User + auth tables, OrganizationMembership, Invitation, Role, RolePermission, Team, TeamMembership, SupportAccessGrant, AuditLog, OutboxEvent, FileObject (base), Notification (base) |
| Architecture decisions required | ADR-0002/0004 confirmed or revised by S1 results; ADR-0003 confirmed by S2 (Better Auth for authentication; organisation plugin adopted only if it passes S2); ADR-0007 confirmed by a priced deployment estimate |
| Security | T1, T3, T9, T10, T17–T21 controls in place |
| Testing | Tenant isolation suite, permission matrix suite, Server Action exposure test, auth E2E |
| Acceptance | FR-001–FR-009, FR-020–FR-025, FR-027, FR-030–FR-031 pass |
| Exit criteria | S1 and S2 PASS reports committed under `docs/architecture/spikes/`; CI green with isolation + matrix suites (100% of tenant tables covered by the automated RLS catalog check); a staging deploy reachable over HTTPS in an India region; restore drill done with RTO measured ≤ 4 h; zero high/critical vulnerabilities; internal auth security checklist complete; measured staging infra cost within the OD-15 budget or an approved exception |
| Risks | Auth library fit (R-07); RLS + Prisma 7 transaction ergonomics (R-06) |
| Deliverables | Running foundation, ADR updates, runbooks (deploy, restore, incident) |

## Phase 2: Lead management

| Item | Detail |
|---|---|
| Objective | Get all leads into the system cleanly and owned |
| Included | Lead model, sources, custom fields; manual create with dedup; lead list (filters, search, cursor pagination); lead detail (requirements, notes, timeline); stage changes with rules; import (presigned upload, preview, mapping templates, validation, dedup, background chunks, reports, history, cancel, dry run); assignment (manual, bulk, import-time, basic round-robin), reassignment with optimistic locking, assignment history, unassigned queues; deactivation handover; in-app notifications + digests; archive/merge; export job (Should); consent model + import attestation |
| Excluded | Calling UI, scripts, tasks (beyond next follow-up field placeholder), dashboards |
| Dependencies | Phase 1 |
| DB/domain | Lead, LeadSource, LeadEnquiry, LeadNote, LeadStageHistory, LeadActivity, LeadDuplicateMatch, CustomFieldDefinition, ConsentRecord, ImportJob, ImportRow, ImportMappingTemplate, LeadAssignmentHistory, TeamAssignmentState, ExportJob |
| Security | T2, T4, T5, T6, T7, T8 |
| Testing | Import corpus, crash-resume tests, concurrency tests (parallel imports, reassignment races), k6 on 250k leads |
| Acceptance | FR-032, FR-040–FR-066, FR-070–FR-073 (basic), FR-075, FR-077, FR-118, FR-120, FR-170 (model) |
| Exit criteria | 100k-row import ≤ 10 min with exact counts across forced crashes; zero duplicate open leads under concurrent import test; NFR-001/002 met on seeded data; pilot org imports their real data in staging (with their consent) and validates output |
| Risks | Messy real-world files (R-09); duplicate policy disagreements (OD) |

## Phase 3: Salesperson workspace and basic calling (completes MVP)

| Item | Detail |
|---|---|
| Objective | Executives work their day from the CRM on a phone |
| Included | Mobile-first lead workspace; Call (`tel:`) and WhatsApp (`wa.me`) launchers with CallIntent; log-outcome sheet (outcome, notes, requirement edits, next follow-up in one transaction); unlogged-intent prompts; unified timeline with manual/provider badges; contact status / DNC; phone masking + reveal (Should); scripts (CRUD, versions, publish, targeting, drawer); tasks & follow-ups (create, complete, reschedule); My Day; offline-tolerant drafts + idempotent submits |
| Excluded | Provider calling, reminders via push, dashboards, leave |
| Dependencies | Phase 2 |
| DB/domain | CallIntent, Interaction, CallScript, CallScriptVersion, Task (base) |
| Security | T13 (prep), T15, T16 (DNC enforcement) |
| Testing | Playwright on mobile viewports (Pixel/iPhone); field test with pilot executives for one week |
| Acceptance | FR-057, FR-060, FR-065, FR-080–FR-085, FR-095–FR-102, FR-108 |
| Exit criteria | Pilot: ≥ 80% of executives use it daily for 2 weeks; outcome-logging rate (K08b) ≥ 70%; NFR-009 met on a mid-range Android; no P1 bugs open |
| Risks | Adoption (R-05); logging friction |

## Phase 4: Dashboards and team operations

| Item | Detail |
|---|---|
| Objective | Management visibility, team control and basic site visits (OD-01) |
| Included | KPI module (K01–K20 that do not need properties/deals) with drill-downs; role dashboards; manager task assignment; meetings + calendar views; reminders (delayed jobs + backfill sweep); web push + email notifications with preferences; escalation rules (uncontacted SLA, overdue follow-ups); rule-based + leave-aware assignment; workload view; leave (types, requests, approvals, balances, availability calendar, impact scan, delegation); data-principal request tooling; anomaly alert on lead-view volume; report CSV export; **basic site visits** (schedule with free-text location, assigned salesperson, status, reschedule, cancel/no-show, completion, visit-level outcome, reminders, automatic stage updates) |
| Excluded | Property inventory, property-linked visits, matching, deals and brokerage (Phase 5) |
| Dependencies | Phase 3 (activity data); OD-02 (KPI targets) |
| DB/domain | TaskReminder, Escalation, AssignmentRule, Delegation, LeaveType, LeaveRequest, LeaveBalance, NotificationPreference, PushSubscription, SiteVisit (basic), (KpiDailyAggregate if needed) |
| Testing | KPI fixture suites; reminder idempotency; clock-controlled delegation expiry; k6 dashboards |
| Acceptance | FR-074, FR-076, FR-078, FR-103–FR-107, FR-110–FR-116, FR-119, FR-130–FR-133, FR-135, FR-150–FR-152, FR-171; KPIs K01–K13 and K18–K20 |
| Exit criteria | Every KPI tile equals its drill-down in tests; NFR-005 and NFR-007 met; ≥ 90% of pilot site visits recorded in the CRM with a terminal status within 24 h of scheduled time (2-week sample); pilot Owner/Admin opens the dashboard in ≥ 3 of 4 consecutive weeks (usage log) |
| Risks | KPI disputes (R-08); notification fatigue |

## Phase 5: Property inventory and deals

| Item | Detail |
|---|---|
| Objective | Close the loop from lead to revenue: inventory, matching, property-linked visits, deals, brokerage |
| Included | Properties (+projects Should), media pipeline (re-encode, EXIF strip, thumbnails), owner contacts (restricted), matching, share links, property-linked visits and per-property feedback (extends Phase 4 basic visits), deals, brokerage, payments, splits (Could), funnel and source reports (K11–K17, K21–K24), RERA fields (OD-10) |
| Dependencies | Phase 4; OD-07, OD-10 |
| DB/domain | Project, Property, PropertyContact, PropertyMedia, PropertyShare, SiteVisitProperty, VisitFeedback, Deal, DealStageHistory, Brokerage, BrokerageSplit, BrokeragePayment |
| Security | T8, T15 (shares), money audit |
| Acceptance | FR-140–FR-149, FR-153–FR-157 |
| Exit criteria | Funnel report counts (lead → visit → deal → brokerage) match record-level drill-downs exactly on pilot data; money sums reconcile to the paisa in tests; property share links expose zero restricted fields (automated test) |
| Risks | Inventory data quality; scope creep into listing portal |

> **OD-01 (accepted as planning default, 2026-10-19):** basic site visits are delivered in Phase 4. Phase 5 extends them with inventory links and per-property feedback.

## Phase 6: Communication integrations

| Item | Detail |
|---|---|
| Objective | Verified communication data and WhatsApp messaging |
| Included | PoCs 1–5 (calling research §5) **before** build; IntegrationConnection with encrypted secrets; webhook intake pipeline; telephony adapter (1 provider); provider click-to-call; status events; recordings (behind legal gate); reconciliation job; WhatsApp Cloud API messaging (templates, session messages, statuses, opt-in/opt-out); WhatsApp calling **only if PoC-4 passes**; inbound lead API; Meta Lead Ads (Could) |
| Dependencies | Phase 3 interaction model; legal review items 1 and 4; provider contracts (OD-12) |
| DB/domain | CommunicationEvent, OutboundMessage, ProviderReference, WebhookEvent, IntegrationConnection, InboundLeadKey |
| Security | T11, T12, T13, T16 |
| Acceptance | FR-086–FR-089, FR-160–FR-161 |
| Exit criteria | Webhook duplicate/out-of-order tests pass; reconciliation shows ≥ 99.5% event completeness over 2 weeks of pilot; provider-verified KPIs shown separately |
| Risks | Provider reliability/cost (R-04); WhatsApp calling availability (R-01) |

## Phase 7: Automation, AI and production optimisation

| Item | Detail |
|---|---|
| Objective | Leverage data; harden for scale |
| Included | AI summaries/extraction (suggestions only, opt-in, DPDP review); lead prioritisation score with explanations; configurable automations; custom roles; scheduled reports; calendar sync; retention purge jobs; partitioning/replica if triggers met; PWA evaluation; external penetration test; performance tuning to NFR high targets |
| Dependencies | Data history from Phases 3–6; legal review for AI processing location |
| Acceptance | FR-026, FR-134, FR-162–FR-165, FR-172 |
| Exit criteria | External pen-test: zero open critical/high findings; load test at base ×2 meets NFR-001–NFR-008; AI suggestion acceptance rate reported per feature over ≥ 2 weeks |
| Risks | AI accuracy and trust; PII sent to AI providers (R-11) |
