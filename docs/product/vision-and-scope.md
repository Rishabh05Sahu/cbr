# CBR Property CRM — Vision and Scope

> Status: Phase 0 draft for review · Last updated: 2026-10-19 · Owner: Product/CTO

## 1. What we are building

**CBR Property CRM** is a sales CRM built for Indian real estate brokerages. One system covers the whole brokerage sales flow:

lead capture and import → distribution to salespeople → calling and follow-ups → requirement qualification → property matching → site visits → negotiation → booking → brokerage collection,

plus the management layer around it: teams, permissions, call scripts, tasks, leave cover, dashboards, KPIs and audit history.

It covers resale, rental, primary (new-project) residential and commercial enquiries.

## 2. Business outcome

> Increase lead-to-site-visit and lead-to-booking conversion, prevent lead leakage, improve salesperson accountability, and give management reliable visibility into the complete sales pipeline.

| Outcome | How the product supports it | How we will know |
|---|---|---|
| More site visits and bookings | Fast first contact, scheduled follow-ups, scripts, property matching, visit tracking | Lead→visit and lead→booking conversion (see [metrics-and-kpis.md](metrics-and-kpis.md)) by cohort |
| No lead leakage | Every lead has an owner or sits in a visible unassigned queue; neglected leads escalate; exports and number reveals are permissioned and audited | Unassigned-lead age, overdue follow-ups, uncontacted leads older than SLA |
| Salesperson accountability | Activity history per lead, manual and provider-confirmed call records kept separate, assignment history | Per-user activity and conversion figures, adjusted for lead age |
| Management visibility | Role-scoped dashboards with fixed KPI definitions and drill-down to the underlying records | Dashboards match drill-down counts exactly |

## 3. Target users

- **Brokerage owners/directors** (Company Owner/Admin): run the business and need visibility and control.
- **Sales managers/team leads**: run a team of 3–15 executives.
- **Sales executives**: make calls all day, mostly on a mobile phone, often in the field.
- **HR/operations staff**: manage leave and staff records without seeing customer data.
- **Platform operators** (us): run the SaaS and onboard brokerages. They do **not** get automatic access to customer data.

See [user-personas-and-roles.md](user-personas-and-roles.md).

## 4. Product principles

1. **Mobile-first for executives, desktop-rich for managers.** The executive's lead workspace must work one-handed on a phone browser.
2. **Never fake data.** A tap on the call button is not a call. Missing provider data stays missing; it is never estimated.
3. **The server is the source of truth for permissions.** Hiding something in the UI is a convenience, not a control.
4. **Everything important leaves a trail.** Ownership changes, stage changes, exports, imports and administrative actions are audited.
5. **Tenant isolation is non-negotiable.** One brokerage can never see another's data, including through platform staff, background jobs or reports.
6. **Integrations are adapters.** Calling, WhatsApp, AI and portals plug in behind stable internal interfaces. The core CRM works without any of them.
7. **Prefer boring, operable technology.** A modular monolith, PostgreSQL and a single queue. Add complexity only when measurements justify it.

## 5. Scope

### 5.1 In scope for the product roadmap (Phases 1–7)

Identity and access · organisations and teams · lead import · lead management and lifecycle · assignment and workload · calling (native dialer and WhatsApp launch first, provider integrations later) · call scripts · tasks, meetings and follow-ups · leave planner · notifications · dashboards and KPIs · property inventory and matching · site visits · deals and brokerage · communication integrations · automation and AI extensions · audit and compliance.

### 5.2 First usable release (end of Phase 3, "MVP")

A brokerage can:
- onboard users and teams with roles,
- import leads from Excel/CSV with validation and duplicate handling,
- assign and reassign leads with history,
- let executives work leads from a phone browser: call via the native dialer or WhatsApp, log outcomes and notes, update requirements and stage, and schedule follow-ups,
- use published call scripts,
- see a basic "my day" list of due and overdue follow-ups.

Dashboards, leave, escalation, notifications and **basic site visits** follow in Phase 4 (OD-01, accepted as planning default 2026-10-19). Property inventory, matching, property-linked visits and deals follow in Phase 5.

### 5.3 Explicitly out of scope (for now)

- Native iOS/Android apps. We ship a responsive web app first; a PWA is evaluated in Phase 7.
- Accounting/GST invoicing. Brokerage is tracked, but invoices are produced in the brokerage's accounting system.
- A public property listing website or portal syndication.
- Scraping property portals. Portal leads come in only through supported interfaces or exports, subject to their terms.
- Payroll and full HRMS. Only leave is in scope.
- Automated outbound dialling or campaigns. These carry regulatory risk (TRAI TCCCPR) and are evaluated separately.
- Microservices.

## 6. Market assumptions (to validate)

- Brokerages already keep leads in Excel/Google Sheets and portal dashboards (99acres, MagicBricks, Housing.com), and get them from Facebook/Instagram lead ads and walk-ins. **Bulk import is the first adoption hook.**
- Executives call from their personal or company SIM. Customers in India answer WhatsApp calls readily, and WhatsApp is often preferred over voice calls.
- Lead leakage (executives taking leads with them when they leave) is a real management concern.

## 7. Success criteria for the first pilot brokerage (proposed)

- 100% of incoming leads are in the CRM within 24 hours of receipt (import or entry).
- At least 90% of leads assigned within 1 working hour.
- At least 80% of executives log outcomes for at least 80% of their call intents (measures adoption).
- Management uses the dashboard weekly in place of Excel reports.

These are proposals awaiting confirmation from the business (OD-02).
