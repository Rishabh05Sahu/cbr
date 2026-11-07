# Functional Requirements

> Status: Phase 0 draft · Priority: **Must** (needed for that phase's exit), **Should** (planned in that phase, can slip one phase), **Could** (nice to have) · Phase numbers follow [phase-roadmap.md](../architecture/phase-roadmap.md). Phases 1–3 make up the first usable release (MVP).

Actor codes: PA Platform Admin · OW Owner · AD Admin · SM Sales Manager · SE Sales Executive · HR HR/Ops · SYS system.

## 1. Identity and account management (IAM)

| ID | Requirement | Actor | Business reason | Pri | Ph | Depends on | Acceptance criteria |
|---|---|---|---|---|---|---|---|
| FR-001 | Users sign in with email + password. Optional email OTP/magic link (Should). | All | Secure access | Must | 1 | — | Valid creds → session; invalid → generic error; 5 failures/15 min → throttled; audit `auth.login.*` |
| FR-002 | Users sign out from the current device and "all devices". | All | Lost phones are common | Must | 1 | FR-001 | Sign-out-all revokes every session within 1 minute |
| FR-003 | Password reset via single-use, time-limited (30 min) email link. | All | Account recovery | Must | 1 | FR-001 | Link works once; old sessions revoked on reset; response does not reveal whether the email exists |
| FR-004 | Org admins invite users by email with a role and optional team. Invites expire after 7 days. | OW, AD | Onboarding | Must | 1 | FR-001 | Invite accepted → membership created with that role; expired/revoked invites fail |
| FR-005 | User membership states: `INVITED`, `ACTIVE`, `SUSPENDED`, `DEACTIVATED`. | OW, AD | Staff turnover | Must | 1 | FR-004 | Suspended/deactivated users lose access immediately (sessions revoked); their data remains; deactivation prompts reassignment of open leads/tasks |
| FR-006 | Two-factor authentication (TOTP) is available; orgs can enforce it for Owner/Admin. | OW, AD | Protect high-privilege accounts | Should | 1 | FR-001 | When enforced, admin login without 2FA is blocked until enrolled |
| FR-007 | Users view and edit their profile: name, phone, photo, language, notification preferences. | All | Basic hygiene | Must | 1 | — | Email change requires re-verification |
| FR-008 | Idle session timeout (default 12h, org-configurable 1–72h) and absolute lifetime of 30 days. | SYS | Shared devices | Must | 1 | FR-001 | Expired session redirects to login without losing unsaved form drafts where feasible |
| FR-009 | One user may belong to more than one org (e.g. a consultant) and switch between them. | All | Multi-tenant readiness | Should | 1 | Org model | Active org shown at all times; data never mixes between orgs |

## 2. Organisation, teams and access (ORG)

| ID | Requirement | Actor | Business reason | Pri | Ph | Depends on | Acceptance criteria |
|---|---|---|---|---|---|---|---|
| FR-020 | Platform admins create, suspend and reactivate organisations and assign the first owner. | PA | SaaS operation | Must | 1 | — | Suspended org: users cannot log in; data retained |
| FR-021 | Platform admins cannot read tenant customer data without an approved support-access grant. | PA, OW | Trust and privacy | Must | 1 | FR-020 | Automated test: platform admin requesting a lead → 403; grant flow works and is audited |
| FR-022 | Owners/admins create teams, set team leads, and add/remove members. | OW, AD | Team structure | Must | 1 | FR-004 | A user may be in multiple teams; a team may have multiple leads |
| FR-023 | Role assignment uses the fixed system roles. | OW, AD | Access control | Must | 1 | — | Admins cannot grant Owner/Admin; only an owner can |
| FR-024 | All permission checks are enforced on the server, per the matrix in [user-personas-and-roles.md](user-personas-and-roles.md). | SYS | Security | Must | 1 | — | Permission matrix test suite passes in CI |
| FR-025 | Org settings: name, logo, time zone (default Asia/Kolkata), working days/hours, currency (INR), phone masking, session policy. | OW, AD | Configuration | Must | 1 | — | Changes audited |
| FR-026 | Custom roles built from catalog permissions. | OW | Flexibility | Could | 7 | FR-024 | — |
| FR-027 | Ownership transfer between users. | OW | Continuity | Should | 1 | — | Requires re-authentication; audited |

## 3. Audit (AUD)

| ID | Requirement | Actor | Business reason | Pri | Ph | Depends on | Acceptance criteria |
|---|---|---|---|---|---|---|---|
| FR-030 | Append-only audit log of sensitive actions (see security doc §7). | SYS | Accountability | Must | 1 | — | Audit rows cannot be updated/deleted by the application DB role |
| FR-031 | Owners/admins search the audit log by actor, action, entity and date. | OW, AD | Investigations | Must | 1 | FR-030 | Paginated; results limited to their org |
| FR-032 | Each lead shows an activity timeline (calls, notes, stage, ownership, tasks, visits). | SE, SM, AD | Context for calls | Must | 2 | — | Chronological, attributed, scope-checked |

## 4. Lead import (IMP)

| ID | Requirement | Actor | Business reason | Pri | Ph | Depends on | Acceptance criteria |
|---|---|---|---|---|---|---|---|
| FR-040 | Upload `.xlsx` or `.csv` up to 20 MB / 100,000 rows (configurable per plan). The browser uploads directly to object storage via a presigned URL. | OW, AD | Brokerages live in Excel | Must | 2 | Storage | Larger or wrong-type files rejected before processing; macro-enabled formats (`.xlsm`) rejected |
| FR-041 | Preview the first 50 rows and map columns to lead fields. Saved mapping templates per source. | OW, AD | Each portal exports differently | Must | 2 | FR-040 | Auto-suggest mapping by header name; required fields must be mapped to continue |
| FR-042 | Row validation: required fields, phone validity, enums, budget numbers ("1.2 Cr", "85 L" parsed), dates. | SYS | Data quality | Must | 2 | FR-041 | Each invalid row has a machine code + human message |
| FR-043 | Phones normalised to E.164 with default region IN. Raw value retained. | SYS | Dedup and dialling | Must | 2 | — | "098765 43210", "+91-9876543210" and "9876543210" all map to `+919876543210` |
| FR-044 | Duplicates within the file are detected and handled per the chosen policy. | SYS | Dedup | Must | 2 | FR-043 | Policy options: keep first / keep last / merge into first |
| FR-045 | Duplicates against existing open leads follow the org duplicate policy (lead-lifecycle §5): attach enquiry (default), skip, or update empty fields only. | OW, AD | Prevent double work | Must | 2 | FR-043 | Never overwrites non-empty existing fields silently; report shows each match |
| FR-046 | Import runs as a background job with progress (rows processed/total, valid, invalid, duplicates). | SYS | Large files | Must | 2 | Queue | UI polls/streams progress; navigating away does not stop it |
| FR-047 | Downloadable rejected-rows report (original columns + error column) as CSV/XLSX. | OW, AD | Fix and re-upload | Must | 2 | FR-042 | Report re-uploadable after correction |
| FR-048 | Imports are retry-safe: a crash or retry never creates duplicate leads. | SYS | Integrity | Must | 2 | FR-046 | Kill worker mid-import → resume completes with exact counts (test) |
| FR-049 | Uploading a file with the same content hash as an import from the last 30 days triggers a warning and requires explicit confirmation. | OW, AD | Accidental re-upload | Must | 2 | — | Even if confirmed, row-level dedup prevents duplicate leads |
| FR-050 | Import history with who, when, file, mapping, counts and outcome. Cancel a running import. | OW, AD | Accountability | Must | 2 | — | Cancelled import keeps already-committed rows and reports them |
| FR-051 | Optional assignment at import: to a user, a team queue, round-robin within a team, or leave unassigned. | OW, AD | Fast distribution | Must | 2 | FR-070 | Assignment recorded in assignment history with source `IMPORT` |
| FR-052 | Partial success is normal: valid rows commit even when others fail. A "validate only" dry run is offered. | OW, AD | Usability | Must | 2 | — | Dry run writes no leads |

## 5. Lead management (LEAD)

| ID | Requirement | Actor | Business reason | Pri | Ph | Depends on | Acceptance criteria |
|---|---|---|---|---|---|---|---|
| FR-055 | Create a lead manually with duplicate check before save. | SE, SM, AD | Walk-ins, referrals | Must | 2 | FR-043 | Duplicate → shown to user, who can attach an enquiry instead (if in scope) or request access |
| FR-056 | Lead list with filters (stage, owner, team, source, intent, follow-up due, created/assigned date, city, budget, property type), search (name, phone fragment, email), sort and cursor pagination. | All sales | Daily work | Must | 2 | — | Results scope-filtered; p95 < 500 ms at base workload |
| FR-057 | Lead detail workspace: summary, requirements, timeline, tasks, call actions, script panel. | SE | Core workflow | Must | 2/3 | — | Usable at 360 px width |
| FR-058 | Update requirements and stage per lifecycle rules. | SE, SM | Qualification | Must | 2 | — | Invalid transitions rejected server-side with reason |
| FR-059 | Notes with author/time. Editable for 15 minutes, then immutable (corrections appended). | SE, SM | Context | Must | 2 | — | — |
| FR-060 | Phone masking (org setting): numbers shown masked in lists. Reveal is an explicit, logged action. | OW | Leakage deterrence | Should | 3 | — | Reveal creates audit row; daily reveal cap configurable |
| FR-061 | Archive/restore leads. Hard delete only for data-principal erasure requests by Owner. | OW, AD | Hygiene and privacy | Must | 2 | — | Hard delete removes PII, keeps anonymised aggregates |
| FR-062 | Merge two leads (possible duplicates). | AD, SM | Data quality | Should | 2 | — | Timeline, enquiries, tasks moved; merged lead tombstoned with pointer |
| FR-063 | Bulk actions on a selection or filter: assign, change team, add tag, archive. | AD, SM | Efficiency | Must (assign) / Should (others) | 2 | — | Processed as a job above 500 records; audited as one bulk action with item list. **Status (2026-10-26): partially implemented.** Built: bulk assign (M3) and bulk archive of a selection of up to 100 leads, all or nothing, audited as one action (M5). **Deferred until after the initial pilot (owner decision):** archive by filter and background jobs above 500 records. Change team and add tag are not built |
| FR-064 | Custom lead fields. | OW, AD | Fit varied businesses | Should | 2 | — | ≤30 fields; validated server-side |
| FR-065 | Contact status / Do-not-contact: blocks call buttons and messaging with a visible banner. | SE, SYS | Compliance | Must | 3 | — | DNC leads cannot be messaged via integrations; manual call shows warning requiring confirmation |
| FR-066 | Lead export (CSV/XLSX) as an async job with row cap, watermark and audit. | OW (AD cfg) | Reporting/backup | Should | 2 | — | Download link expires in 15 min; one-time download |

## 6. Assignment and workload (ASG)

| ID | Requirement | Actor | Business reason | Pri | Ph | Depends on | Acceptance criteria |
|---|---|---|---|---|---|---|---|
| FR-070 | Manual assign/reassign with optional reason (reason required for reassign). | AD, SM | Control | Must | 2 | — | Concurrent reassignments: last committed wins only if based on current version (optimistic lock), else conflict error |
| FR-071 | Assignment history: from, to, by, when, reason, source. | All | Accountability | Must | 2 | — | Immutable |
| FR-072 | Unassigned queue per org and per team, with age. | AD, SM | No leakage | Must | 2 | — | Sort by oldest |
| FR-073 | Round-robin assignment within a team, skipping users on approved leave or inactive. | SYS | Fairness | Should | 2 (basic) / 4 (leave-aware) | FR-110 | Deterministic, concurrency-safe pointer per team |
| FR-074 | Rule-based assignment (source, city/locality, budget band, language, project) → team or user, with priority order and fallback queue. | AD | Specialisation | Should | 4 | FR-073 | Rule evaluation logged on the lead |
| FR-075 | Notify the new owner on assignment (in-app; push/email per preference). | SYS | Speed to lead | Must (in-app) | 2 | Notifications | Bulk assignment sends one digest, not N notifications |
| FR-076 | Neglect escalation: lead not contacted within N working hours of assignment, or follow-up overdue more than M hours → notify manager; optional auto-return to queue. | SYS | Leakage | Should | 4 | FR-106, FR-118 | Configurable SLA; escalation logged; no duplicate escalations |
| FR-077 | Deactivating a user forces a decision on their open leads/tasks (reassign to user/team queue). | AD | Continuity | Must | 2 | FR-005 | User cannot be deactivated with orphaned open leads unless they go to queue |
| FR-078 | Workload view: open leads, overdue follow-ups, and today's tasks per executive. | SM, AD | Balancing | Should | 4 | — | — |

## 7. Calling and communication (CALL)

| ID | Requirement | Actor | Business reason | Pri | Ph | Depends on | Acceptance criteria |
|---|---|---|---|---|---|---|---|
| FR-080 | "Call" button opens the device dialer (`tel:`) with the lead's number. | SE | Core workflow | Must | 3 | — | Records a `CallIntent` (click) only. Never records a call |
| FR-081 | "WhatsApp" button opens WhatsApp to the lead's chat (`wa.me`). The user then calls or messages inside WhatsApp. | SE | Customer preference | Must | 3 | — | Records `CallIntent` with channel WhatsApp. Never claims a call happened |
| FR-082 | On return to the CRM after a call intent, prompt the user to log the outcome (pre-filled channel/time). | SE | Data capture | Must | 3 | FR-080 | Prompt shown if intent < 2 h old and unlogged; dismissible; unlogged intents are counted |
| FR-083 | Manual interaction log: channel, direction, outcome, approximate duration (optional), notes, next action. | SE | Accountability | Must | 3 | — | Marked `source = MANUAL`; logged within 1 tap of the lead page |
| FR-084 | Requirement updates and next follow-up can be set in the same "log outcome" sheet. | SE | Speed | Must | 3 | — | One submit, one transaction |
| FR-085 | Unified communication timeline across channels. Manual vs provider-confirmed entries are visually distinct. | All sales | Trust in data | Must | 3 | — | Badge "Logged by user" vs "Verified by provider" |
| FR-086 | Cloud telephony click-to-call (call bridging) with provider status callbacks, duration and (optionally) recording. | SE | Verified activity | Should | 6 | Provider PoC | Events reconcile to the interaction; idempotent webhooks |
| FR-087 | WhatsApp Business Platform messaging (templates, session messages, delivery status). | SE | Engagement | Should | 6 | Meta onboarding | Opt-in checked before template sends |
| FR-088 | WhatsApp Business Calling via API, if available for Indian numbers. | SE | Verified WhatsApp calls | Could | 6 | Research doc | Feature-flagged; disabled unless verified |
| FR-089 | Recordings: access per permission, retention policy, playback audited. | OW | Coaching/QA | Could | 6 | Legal review | Never enabled without org-level legal confirmation checkbox + customer notice config |

## 8. Scripts (SCR)

| ID | Requirement | Actor | Business reason | Pri | Ph | Depends on | Acceptance criteria |
|---|---|---|---|---|---|---|---|
| FR-095 | Create/edit scripts with sections: opening, qualification questions, pitch points, objection handling (objection → response), closing/next step. | OW, AD | Consistent pitch | Must | 3 | — | Rich text, limited formatting (sanitised) |
| FR-096 | Scripts target projects, transaction type, property type, language, or source. The lead page suggests the best match. | SE | Relevance | Should | 3 | — | Deterministic match order, documented |
| FR-097 | Draft → Published → Archived, with immutable published versions. | OW, AD | Control | Must | 3 | — | Editing published script creates a new draft version |
| FR-098 | The interaction stores the script version shown when it was logged. | SYS | Coaching analysis | Should | 3 | FR-083 | — |
| FR-099 | Script panel opens in a drawer from the lead page (no navigation away). | SE | Usability | Must | 3 | — | — |

## 9. Tasks, meetings, follow-ups (TASK)

| ID | Requirement | Actor | Business reason | Pri | Ph | Depends on | Acceptance criteria |
|---|---|---|---|---|---|---|---|
| FR-100 | Tasks with type (Follow-up, Call, Meeting, Document, Other), due at, priority, assignee, optional lead/property link. | All | Daily work | Must | 3 | — | — |
| FR-101 | "My Day": overdue, due today, upcoming (7 days), sorted by priority then lead intent (Hot first) then due time. | SE | What next | Must | 3 | — | Loads < 1 s p95 |
| FR-102 | Complete, cancel (reason), reschedule (reason when rescheduled more than twice or for overdue). | SE | Accountability | Must | 3 | — | Reschedule count stored |
| FR-103 | Managers create tasks for team members. | SM, AD | Direction | Must | 4 | — | Assignee notified |
| FR-104 | Meetings: start/end, location or link, attendees (internal), linked lead. | SE, SM | Scheduling | Should | 4 | — | Overlap warning for same user |
| FR-105 | Day/week/month calendar views. | All | Planning | Should | 4 | — | — |
| FR-106 | Reminders at configurable offsets (default 15 min before) via in-app and push/email. | SYS | Don't miss follow-ups | Must | 4 | Notifications | Exactly one reminder per task per offset (idempotent job key) |
| FR-107 | Recurring tasks (daily/weekly) for non-lead tasks. | SM | Routine | Could | 4 | — | — |
| FR-108 | At most one open follow-up per lead per assignee is "primary". `Lead.next_follow_up_at` reflects the earliest open follow-up. | SYS | Lists and SLAs | Must | 3 | — | Updated in the same transaction |

## 10. Leave (LEAVE)

| ID | Requirement | Actor | Business reason | Pri | Ph | Depends on | Acceptance criteria |
|---|---|---|---|---|---|---|---|
| FR-110 | Request leave (type, dates, half-day, reason). Withdraw a pending request. | All | Planning | Must | 4 | — | Overlapping requests rejected |
| FR-111 | Approve/reject with comment by the user's team lead, HR, or admin. | SM, HR, AD | Control | Must | 4 | — | Approver cannot approve own leave |
| FR-112 | Leave balances per type per year (optional per org). | HR | Policy | Should | 4 | — | Balance never negative unless policy allows |
| FR-113 | Team availability calendar. | SM, HR | Planning | Must | 4 | — | Shows approved and pending |
| FR-114 | On approval, list the affected follow-ups, meetings and site visits in the leave window. Manager assigns cover (delegation) or reassigns items. | SM, AD | Continuity | Must | 4 | FR-110 | Nothing affected is left unhandled without explicit "keep as is" |
| FR-115 | Delegation: temporary access for a cover user to the absent user's leads, auto-expiring. | SM, AD | Continuity | Should | 4 | — | Actions by the delegate are attributed to the delegate "on behalf of" |
| FR-116 | HR sees affected-work counts, not lead details. | HR | Privacy | Must | 4 | — | Test |

## 11. Notifications (NOTIF)

| ID | Requirement | Actor | Business reason | Pri | Ph | Depends on | Acceptance criteria |
|---|---|---|---|---|---|---|---|
| FR-118 | In-app notification centre with unread count. | All | Awareness | Must | 2 | — | — |
| FR-119 | Web push (PWA) and email channels, per-user preferences, quiet hours. | All | Reach | Should | 4 | — | Push optional; email fallback for critical |
| FR-120 | Digesting and de-duplication (no notification storms on bulk actions). | SYS | Usability | Must | 2 | — | — |

## 12. Dashboards and reports (DASH)

| ID | Requirement | Actor | Business reason | Pri | Ph | Depends on | Acceptance criteria |
|---|---|---|---|---|---|---|---|
| FR-130 | Executive dashboard: today's tasks, overdue, open leads by stage, personal KPIs. | SE | Focus | Must | 4 | Metrics | Values match drill-down |
| FR-131 | Manager dashboard: team KPIs, per-member table, overdue follow-ups, unassigned team queue, upcoming visits. | SM | Team control | Must | 4 | — | Scope = teams led |
| FR-132 | Owner/Admin dashboard: all KPIs in [metrics-and-kpis.md](metrics-and-kpis.md), filterable by date range, team, user, source. | OW, AD | Visibility | Must | 4 | — | p95 < 2 s at base workload |
| FR-133 | Every KPI tile drills down to the record list that produced it. | All | Trust | Must | 4 | — | Count equality test |
| FR-134 | Scheduled report emails (weekly). | OW | Habit | Could | 7 | — | — |
| FR-135 | Report export to CSV. | OW, AD | Offline analysis | Should | 4 | — | Audited |

## 13. Properties (PROP)

| ID | Requirement | Actor | Business reason | Pri | Ph | Depends on | Acceptance criteria |
|---|---|---|---|---|---|---|---|
| FR-140 | Property CRUD with fields from domain model (listing, location, price, type, area, amenities, owner contact, status, responsible agent). | AD, SM, SE(cfg) | Inventory | Must | 5 | — | — |
| FR-141 | Photos (≤20, ≤10 MB each, JPEG/PNG/WebP) and documents (PDF ≤20 MB). Thumbnails generated asynchronously. | AD, SE | Sharing | Must | 5 | Storage | EXIF location data stripped from shared images |
| FR-142 | Owner contact is confidential (separate permission). | OW | Protect inventory | Must | 5 | — | — |
| FR-143 | Match properties to a lead's requirements (filters + score) on demand. | SE | Conversion | Must | 5 | — | Explains why each property matched |
| FR-144 | Share property via WhatsApp/email using a public, expiring, non-guessable link showing approved fields only. | SE | Conversion | Should | 5 | — | Shared links logged on lead timeline; owner contact never exposed |
| FR-145 | Projects (new developments) as property groups with units/configurations. | AD | Primary sales | Should | 5 | — | **OD-07** |

## 14. Site visits, deals, brokerage (DEAL)

Basic site visits (FR-150–FR-152) are Phase 4 (OD-01, accepted 2026-10-19). Property-linked visits, matching and deals are Phase 5.

| ID | Requirement | Actor | Business reason | Pri | Ph | Depends on | Acceptance criteria |
|---|---|---|---|---|---|---|---|
| FR-150 | Schedule a **basic site visit**: lead, date/time, location/meeting point (free text), assigned salesperson. Linking inventory properties is added in Phase 5 (FR-157). | SE, SM | Core conversion | Must | 4 | FR-100 | Lead stage auto-updated to Site Visit Scheduled in the same transaction; reminders created for assignee |
| FR-151 | Visit statuses: Scheduled, Confirmed, Rescheduled (same record, reason + new time, reschedule count), Cancelled, Attended, No-show. Reasons for cancel/no-show. | SE, SM | Tracking | Must | 4 | FR-150 | Invalid status transitions rejected server-side |
| FR-152 | Post-visit outcome at visit level: attended/no-show, interest level, objections, notes, next action. (Per-property feedback arrives with FR-157.) | SE | Insight | Must | 4 | FR-151 | Next action required on Attended; lead stage → Site Visit Completed |
| FR-153 | Deal on a lead + property: value, stage (Negotiation, Booked, Agreement, Registered, Cancelled), history. | SE, SM | Revenue | Must | 5 | — | — |
| FR-154 | Brokerage: expected amount (fixed or % of value), side (buyer/seller/both), invoices raised externally, payments received with dates, status (Expected, Partially received, Received, Written off). | AD | Revenue tracking | Must | 5 | — | Amounts in INR decimals; totals reconcile |
| FR-155 | Channel partner/referral shares. | AD | Payouts | Could | 5 | — | — |
| FR-156 | Won requires deal; Lost requires reason. Reports trace lead→visit→deal→brokerage. | SYS | Funnel integrity | Must | 5 | — | — |
| FR-157 | Property-linked visits: attach one or more inventory properties to a visit, availability check, per-property feedback (liked/disliked, interest, objections). | SE, SM | Match quality | Must | 5 | FR-140, FR-150 | Unavailable property flagged before visit; feedback stored per property |

## 15. Integrations and automation (INT)

| ID | Requirement | Actor | Business reason | Pri | Ph | Depends on | Acceptance criteria |
|---|---|---|---|---|---|---|---|
| FR-160 | Inbound lead API/webhook (authenticated per-org key) for website forms and lead ads. | SYS | Speed to lead | Should | 6 | — | Idempotent by external id |
| FR-161 | Meta Lead Ads integration. | SYS | Common source | Could | 6 | — | — |
| FR-162 | Calendar sync (Google) for meetings/visits. | SE | Convenience | Could | 7 | — | — |
| FR-163 | AI call summary and requirement extraction from notes/recordings, shown as suggestions the user accepts. | SE | Speed | Could | 7 | Recordings, legal | Never auto-overwrites fields |
| FR-164 | Lead prioritisation score with explanation. | SE | Focus | Could | 7 | Data history | — |
| FR-165 | Configurable follow-up automations (if/then rules). | AD | Consistency | Could | 7 | — | — |

## 16. Compliance features (CMP)

| ID | Requirement | Actor | Business reason | Pri | Ph | Depends on | Acceptance criteria |
|---|---|---|---|---|---|---|---|
| FR-170 | Consent records: channel, purpose, source (form, import attestation, verbal), timestamp, evidence reference. Withdrawal is honoured. | SYS | DPDP/TRAI | Must (model) / Should (UI) | 2/3 | — | Import requires uploader attestation of lawful source |
| FR-171 | Data-principal requests: export a lead's data; erase (anonymise) on request; record the request. | OW | DPDP | Should | 4 | — | Erasure completes within configured SLA; audit kept without PII |
| FR-172 | Retention policies per entity (configurable) with scheduled purge/anonymisation. | OW | DPDP | Should | 7 | — | Dry-run report before first purge |
