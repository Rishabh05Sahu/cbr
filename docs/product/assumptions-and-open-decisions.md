# Assumptions and Open Decisions

> Status: Phase 0 final review (2026-10-19). **Assumptions** (A-xx) are what the blueprint currently relies on. **Decisions** (OD-xx) are either accepted planning defaults or open with a recommended default that will be used if no answer arrives by the stated gate.

## 1. Assumptions

| ID | Assumption | Source | Impact if wrong |
|---|---|---|---|
| A-01 | Next.js is the primary framework; responsive web app first (no native apps) | Brief | Native app would add a mobile API surface (Route Handlers), not a redesign |
| A-02 | Multi-tenant ready from day one; one org's users never see another's data | Brief | — (non-negotiable) |
| A-03 | Pilot with one brokerage (proposed market: Pune, Maharashtra) before broad onboarding; multi-tenant architecture throughout | OD-14, OD-16 | See OD-14/16 |
| A-04 | CRM and sales workflows before AI | Brief | — |
| A-05 | Modular monolith with separate worker process | Brief + ADR-0001 | — |
| A-06 | Executives use Android phones (majority) and Chrome; some iPhones | Market | Affects testing devices, `tel:` UX |
| A-07 | Executives call mostly from personal or company SIMs in Phase 3 | Market | Regulatory risk R-02 |
| A-08 | Leads come from portals, social ads, website, referrals, walk-ins; mainly via Excel/CSV initially | Market | Import is the Phase 2 priority |
| A-09 | INR only; org time zone Asia/Kolkata; English UI at launch | Market | Multi-currency would need FX handling (fields already carry currency) |
| A-10 | Workload figures in NFR §1 are planning assumptions | Phase 0 | Re-plan if pilot is much larger |
| A-11 | Org-level phone uniqueness for open leads is the duplicate key | Market | If shared family numbers are common, the policy must allow overrides (merge/dismiss flow exists) |
| A-12 | Brokerage collects brokerage outside the CRM (invoicing in accounting software) | Scope | Invoicing would be a new module |
| A-13 | Hosting in an India region; DigitalOcean Bengaluru is the pilot **candidate** within a provisional ₹15,000/month ceiling, single DB node (no HA) | ADR-0007, OD-15 | If HA or controls are required, budget rises or another provider (AWS/GCP Mumbai) is chosen. No migration is planned |
| A-14 | The brokerage (tenant) is the DPDP Data Fiduciary; CBR platform is a Data Processor | Compliance notes | Needs legal confirmation |
| A-15 | Team sizes 3–15; executives may be in more than one team; teams are flat (no nested teams) | Market | Nested teams would change `team` scope (hierarchy query) |

## 2. Decision register

Status legend:
- **Accepted (planning default)**: taken from the business brief of 2026-10-19 and binding for planning, subject to the listed conditions and the business owner's final sign-off at Phase 1 approval.
- **Open**: recommended default proposed, awaiting an answer by the stated gate.

The full analysis (impact, blocking, deferral, references) is in [PHASE-0-FINAL-REVIEW.md §2](../PHASE-0-FINAL-REVIEW.md).

| ID | Question | Options | Recommended default | Status | Needed by |
|---|---|---|---|---|---|
| OD-01 | Should basic site visits come before full property inventory? | (a) Phase 5 (b) basic visits in Phase 4 (c) Phase 3 | Basic visits (schedule, assignee, status, reschedule, completion, visit-level outcome) in **Phase 4**; property-linked visits, matching, deals in Phase 5 | **Accepted (planning default)** | — |
| OD-02 | Confirm success metrics and NFR targets (availability, RPO/RTO, performance) and KPI maturity windows (30/90 days) | — | Pilot availability 99.5% and restore ≤ 4 h **accepted by the owner 2026-10-19** (subject to testing); RPO target ≤ 15 min **to be measured, not assumed**; KPI windows as documented | **Partly accepted** (availability, RTO); RPO and KPI windows open | Phase 1 exit (measured RPO/RTO); Phase 4 (KPI windows) |
| OD-03 | Split "Company Super Admin" into Owner + Admin? | Yes / No | **Yes**; owner-only actions in roles §2.3; Platform Super Admin separate | **Accepted (planning default)** | — |
| OD-04 | Is a break-glass platform access process needed? | Yes / No | No for pilot; support grants only | Open | Before a second tenant |
| OD-05 | May orgs add custom sub-statuses? | Tags / sub-status field / none | Tags | Open | Phase 2 |
| OD-06 | Handle owner-side enquiries (sellers/landlords) in the lead model? | Same Lead with `transaction_type` / separate entity | Same Lead; revisit Phase 5 | Open | Phase 2 |
| OD-07 | Model new-development projects? | Project entity / not needed | Project as Should in Phase 5 | Open | Phase 5 |
| OD-08 | Multi-sheet XLSX imports? | First sheet / choose sheet | Choose sheet | Open | Phase 2 |
| OD-09 | UI languages beyond English? | Hindi, Marathi… | English at launch; strings externalised from Phase 1 | Open | Phase 3 |
| OD-10 | Which RERA data and which states? | — | Agent RERA no. per state + project RERA id; MahaRERA first (Pune pilot) | Open | Phase 5 |
| OD-11 | Person/Contact entity across leads? | Now / later | Later | Open | Phase 5 review |
| OD-12 | Telephony provider and WhatsApp BSP | Exotel / Smartflo / MyOperator; Meta direct / BSP | Shortlist Exotel + Smartflo; PoCs first | Open | Phase 6 |
| OD-13 | Transactional email provider | SES / ZeptoMail / Postmark / Resend / Brevo / SendGrid | **Mailpit locally (accepted).** Production: recommend Amazon SES ap-south-1, alternative ZeptoMail India DC ([integration-strategy §8](../architecture/integration-strategy.md)). **Not selected yet** | **Accepted (planning default)** for local; production selection Open | Phase 1 staging exit |
| OD-14 | Target states / pilot geography | — | **Pune, Maharashtra**, subject to a willing brokerage; cities/localities configurable, nothing hard-coded | **Accepted (planning default)**, conditional | Named brokerage before Phase 2 |
| OD-15 | Hosting budget; does any target customer mandate AWS? | DO BLR1 / AWS / GCP / others | **DigitalOcean Bengaluru candidate**, provisional ceiling **₹15,000/month** (excl. telephony, WhatsApp, taxes, variable third-party). Estimate ≈ ₹7,600 **without DB HA**; HA ≈ ₹27,800 exceeds the ceiling. AWS only if justified | **Accepted by the owner 2026-10-19**: single-node DB without standby for the controlled pilot; ₹15k/month provisional; **full cost estimate required before provisioning production infrastructure**; reassess HA on customer/criticality/operational evidence | Before staging provisioning |
| OD-16 | Internal pilot first or SaaS from day one? | Pilot / SaaS day one | **One-brokerage pilot**; multi-tenancy and org config retained; self-service onboarding, billing and broad launch deferred | **Accepted (planning default)** | — |

## 3. Decisions taken in Phase 0 (summary)

See ADRs for the full reasoning: modular monolith + worker (ADR-0001); PostgreSQL 18 + Prisma 7 (ADR-0002); Better Auth for authentication with our own authorisation model (ADR-0003); org-scoped RLS + application scope checks + fixed roles in tables (ADR-0004); BullMQ 6 on Redis/Valkey with a transactional outbox (ADR-0005); launch-first calling with provider adapters later (ADR-0006); DigitalOcean BLR1 as pilot candidate with portable containers, no planned migration (ADR-0007).
