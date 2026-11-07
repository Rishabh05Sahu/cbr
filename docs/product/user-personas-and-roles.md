# User Personas, Roles and Permission Model

> Status: Phase 0 draft · Related: [ADR-0004](../architecture/adr/ADR-0004-multi-tenancy-and-permissions.md), [security-and-threat-model.md](../architecture/security-and-threat-model.md)

## 1. Personas

| Persona | Typical context | Primary goals | Key frustrations today |
|---|---|---|---|
| **Rakesh, brokerage owner** | Owns a 25-person brokerage in Pune; laptop and phone | Know where every lead stands, who is performing, and how much brokerage is coming | Excel sheets passed around on WhatsApp; leads disappear when staff leave |
| **Priya, sales manager** | Runs 8 executives; mostly in the office | Distribute leads fairly, catch neglected leads, plan site visits | No visibility until the weekly meeting; follow-ups missed |
| **Amit, sales executive** | On the road, calls 60–120 leads a day from an Android phone | A clear "who do I call next" list; quick logging; scripts for new projects | Logging is slow; loses track of call-backs |
| **Neha, HR/operations** | Office | Approve leave and track team availability | Leave tracked in chat; visits booked on leave days |
| **Platform operator** (CBR staff) | Runs the SaaS | Onboard orgs, fix configuration, keep the platform healthy | Must not see customer data without authorisation |

## 2. Role model decision

**Recommendation: fixed system roles backed by a code-defined permission catalog, stored in data tables so custom roles can be added later without schema change.** See ADR-0004.

- Permissions are strings in the form `resource.action[:scope]`, defined in code (one catalog, versioned with the app).
- Each permission check resolves to a **scope**: `own`, `team` or `org`.
- Phase 1 seeds the system roles listed below into `Role`/`RolePermission` for each organisation. These roles are read-only for customers.
- Custom roles (an org admin builds a role from catalog permissions) are a **Could** for Phase 7. Because the tables already exist, no migration of the authorisation model will be needed.
- A user has **exactly one org role per organisation membership**. Team leadership is a separate fact (`TeamMembership.role = LEAD`) that widens `team` scope. It is not a separate permission set.

### 2.1 Roles

| Code | Role | Level | Summary |
|---|---|---|---|
| `PLATFORM_ADMIN` | Platform Super Admin | Platform | Manages organisations, plans, platform health. **No implicit tenant data access.** |
| `PLATFORM_SUPPORT` | Platform Support (optional) | Platform | Read-only org configuration; tenant data only through a support-access grant |
| `ORG_OWNER` | Company Super Admin / Owner | Organisation | Everything in the org, plus ownership transfer, org deletion, approval of support access, and managing admins |
| `ORG_ADMIN` | Company Admin | Organisation | Everything the owner can do except ownership/deletion/support approval |
| `SALES_MANAGER` | Sales Manager / Team Lead | Team | Leads, activities and reports for the teams they lead |
| `SALES_EXECUTIVE` | Sales Executive | Own | Their assigned leads, own tasks, own KPIs |
| `HR_OPS` | HR / Operations | Org (people only) | Users' leave and availability. **No customer, call or deal data.** |

The brief listed "Company Super Admin" as one role. It is split into Owner and Admin (**OD-03, accepted as planning default 2026-10-19**). Every brokerage needs at least one account that cannot be locked out and alone approves support access, ownership changes and destructive actions. Day-to-day administration is delegated to Admins. See §2.3.

### 2.2 Scope definitions (authoritative)

A lead is **in scope** for a user when the user's permission scope covers it:

| Scope | Lead is visible when… |
|---|---|
| `own` | `lead.owner_user_id = me` **or** I hold an active `Delegation` from the owner (leave cover) **or** I am the assignee of an open `SiteVisit` for the lead (read-only, visit fields only) |
| `team` | `own` **or** `lead.owner_user_id` is a member of a team I lead **or** `lead.team_id` is a team I lead (including the team's unassigned queue) |
| `org` | Any lead in my organisation |

The same scope rules apply to entities that hang off a lead (interactions, notes, tasks, site visits, deals) unless noted otherwise. Users' own tasks are always visible to them.

**Team membership changes are not retroactive.** When an executive moves teams, their *current* leads move with them to the new team's manager's scope. Historical KPI attribution uses assignment history (see metrics doc), not current team.

### 2.3 Responsibility split (OD-03 accepted as planning default, 2026-10-19)

| Level | Holds | Can do (summary) | Cannot do |
|---|---|---|---|
| **Platform Super Admin** (CBR platform operator) | `platform_role`, no org membership | Create/suspend organisations, assign the first Owner, view org metadata and platform health, request support access | Read or change any organisation's leads, interactions, deals, exports or settings without an Owner-approved support grant. Not an org role and never shown in org user lists |
| **Company Owner** (≥ 1 per org; last Owner cannot be removed or demoted) | Org role `ORG_OWNER` | Everything Admin can do, **plus owner-only actions**: transfer ownership; add/remove/demote Owners and Admins; approve/revoke platform support access; delete or terminate the organisation and request full data export; hard-delete leads for erasure requests; enable call recording (after confirming legal review); change security policy (2FA enforcement, session limits, export enablement for Admins/Managers, phone masking); view/download recordings where enabled | — |
| **Company Admin** (day-to-day administrator) | Org role `ORG_ADMIN` | Users (invite, suspend, deactivate, change roles up to Sales Manager/Exec/HR), teams, lead import/assign/reassign org-wide, scripts, org configuration (stages labels, lost reasons, custom fields, SLAs, assignment rules), integrations, properties, deals and brokerage, reports, audit log | Owner-only actions above; grant Owner/Admin |
| **Sales Manager / Team Lead** | `SALES_MANAGER` + `team_role = LEAD` on ≥ 1 team | Team-scoped leads, assignment/reassignment within led teams, team tasks, approve team leave, delegations, team dashboards; imports/exports only if enabled by Owner | Org settings, users/roles, integrations, other teams' data |
| **Sales Executive** | `SALES_EXECUTIVE` | Own leads (plus delegated and assigned-visit access), own tasks, interactions, scripts (read), personal KPIs, leave requests | Assign/reassign, imports, exports, org/team data |
| **HR / Operations** (optional) | `HR_OPS` | Leave policy, approvals, availability, people profiles (HR fields), invitations/deactivation if enabled | Any lead, interaction, recording, deal or sales report data |

A person needing both sales and HR duties gets the sales role. HR permissions are granted through the HR-level settings (`cfg`), not by combining roles, so the "one role per membership" rule holds.

## 3. Platform administration separation

- Platform users are `User` rows with a `platform_role`. They have **no `OrganizationMembership`** in customer orgs by default.
- Platform screens are a separate route group (`/platform`) with separate authorisation and a separate audit stream.
- Platform admins can see org metadata: name, plan, user count, lead count, storage use, job health. They cannot see lead PII, interactions, recordings, deals or exports.
- **Support access**: a platform user requests access to org X for a reason, a scope (read-only or read-write) and a duration of at most 72h. The org owner approves in-app. While it is active, the platform user acts with an org-scoped read-only (default) role. Every request is audited in both the org and platform audit logs. The grant expires automatically and the owner can revoke it at any time.
- Break-glass access (owner unreachable, legal obligation) requires two platform admins plus a mandatory reason. It produces an alert to the org owner. **OD-04**: confirm whether this is needed at all.

## 4. Role-permission matrix

Legend: **O** = org-wide · **T** = team scope · **S** = own (self) scope · **—** = not permitted · **cfg** = allowed only if an org setting enables it · **G** = only with a support-access grant.

### 4.1 Leads and lead data

| Permission | Platform Admin | Owner | Admin | Sales Manager | Sales Exec | HR/Ops |
|---|---|---|---|---|---|---|
| `lead.read` | G | O | O | T | S | — |
| `lead.create` (manual entry) | — | O | O | T | S (auto-assigned to self) | — |
| `lead.update` (requirements, contact details, notes) | — | O | O | T | S | — |
| `lead.update_stage` | — | O | O | T | S | — |
| `lead.reveal_phone` (when masking enabled; each reveal audited and counted against the Owner's daily cap, ADR-0013) | — | O | O | T | S | — |
| `lead.archive` / restore | — | O | O | T (cfg) | — | — |
| `lead.delete` (hard delete for erasure requests only) | — | O | — | — | — | — |
| `lead.merge` (resolve duplicates) | — | O | O | T | — | — |
| `lead.lift_do_not_contact` (FR-065; setting a contact status is `lead.update`. Owner decision 2026-10-28, ADR-0012) | — | O | O | — | — | — |
| `lead.assign` (from unassigned queue) | — | O | O | T | — | — |
| `lead.reassign` (change existing owner) | — | O | O | T (within own teams) | — | — |
| `lead.bulk_update` | — | O | O | T (cfg) | — | — |
| `lead.import` | — | O | O | cfg (imports into own teams) | — | — |
| `lead.export` | — | O | cfg | cfg (T) | — | — |
| `lead.view_assignment_history` | G | O | O | T | S (own leads) | — |
| `lead.view_activity_timeline` | G | O | O | T | S | — |

Exports are asynchronous. They are rate-limited, capped in rows, watermarked with the requester's identity and audited. See the threat model.

### 4.2 Calling, communications and scripts

| Permission | Platform Admin | Owner | Admin | Sales Manager | Sales Exec | HR/Ops |
|---|---|---|---|---|---|---|
| `interaction.create` (log call/WhatsApp/meeting outcome) | — | O | O | T | S | — |
| `interaction.read` | G | O | O | T | S | — |
| `interaction.edit` (own entries, within 24h; later edits audited) | — | O | O | T | S | — |
| `recording.listen` (when recordings exist) | — | O | cfg | cfg (T) | cfg (S) | — |
| `recording.download` | — | cfg | — | — | — | — |
| `script.read` (published) | — | O | O | O | O | — |
| `script.manage` (create, edit, publish, archive) | — | O | O | cfg | — | — |
| `integration.manage` (provider credentials, webhooks) | — | O | O | — | — | — |

### 4.3 Tasks, meetings, site visits

| Permission | Platform Admin | Owner | Admin | Sales Manager | Sales Exec | HR/Ops |
|---|---|---|---|---|---|---|
| `task.read` | — | O | O | T | S (assigned to me) | — |
| `task.create` for self | — | ✓ | ✓ | ✓ | ✓ | ✓ (non-lead tasks) |
| `task.create` for others | — | O | O | T | — | — |
| `task.update/complete/reschedule` | — | O | O | T | S | S (own) |
| `site_visit.manage` | — | O | O | T | S | — |
| `site_visit.read` | — | O | O | T | S + assigned visits | — |

### 4.4 People, teams, leave

| Permission | Platform Admin | Owner | Admin | Sales Manager | Sales Exec | HR/Ops |
|---|---|---|---|---|---|---|
| `user.invite` | — | O | O | — | — | cfg |
| `user.deactivate/suspend` | — | O | O | — | — | cfg |
| `user.change_role` | — | O (any) | O (not Owner/Admin) | — | — | — |
| `team.manage` (create, members, leads) | — | O | O | — | — | — |
| `team.read` | — | O | O | T | own teams | O (names, members only) |
| `profile.read` | — | O | O | T | S | O (HR fields) |
| `leave.request` | — | ✓ | ✓ | ✓ | ✓ | ✓ |
| `leave.approve` | — | O | O | T | — | O |
| `leave.read` | — | O | O | T | S | O |
| `leave.manage_policy` (types, balances) | — | O | O | — | — | O |
| `delegation.manage` (leave cover) | — | O | O | T | — | — |

HR/Ops sees that a site visit or follow-up is *affected* by leave, as a count per user. They do not see the lead details. Reassigning the affected work is a sales manager/admin action.

### 4.5 Properties, deals, brokerage

| Permission | Platform Admin | Owner | Admin | Sales Manager | Sales Exec | HR/Ops |
|---|---|---|---|---|---|---|
| `property.read` (non-confidential fields) | — | O | O | O | O | — |
| `property.read_owner_contact` | — | O | O | O | cfg (own listings) | — |
| `property.manage` | — | O | O | O (cfg) | own listings (cfg) | — |
| `property.share_with_lead` | — | O | O | T | S | — |
| `deal.read` | — | O | O | T | S | — |
| `deal.manage` | — | O | O | T | S (cannot mark Won without manager approval if cfg) | — |
| `brokerage.read` | — | O | O | T | S (own deals) | — |
| `brokerage.manage` (record payments) | — | O | O | — | — | — |

### 4.6 Reporting, configuration and governance

| Permission | Platform Admin | Owner | Admin | Sales Manager | Sales Exec | HR/Ops |
|---|---|---|---|---|---|---|
| `report.read` | platform metrics only | O | O | T | S | leave reports only |
| `report.export` | — | O | O | cfg (T) | — | leave only |
| `org.settings.read` (organisation name, time zone and locale, read-only) | G (read-only support grant) | O | O | O | O | O |
| `org.settings.manage` (stage labels, custom fields, lost reasons, SLAs; also **viewing** the phone-masking status and the daily reveal limit, owner decision 2026-10-30) | — | O | O | — | — | — |
| `org.security_policy.manage` (2FA enforcement, session limits, phone masking, export enablement, call-recording enablement) | — | O | — | — | — | — |
| `assignment_rule.manage` | — | O | O | cfg (T) | — | — |
| `audit.read` | platform audit only | O | O | T (lead history only) | — | — |
| `org.delete` / ownership transfer | — | O | — | — | — | — |
| `support_access.approve` | — | O | — | — | — | — |
| `organization.manage` (create, suspend org, plans) | ✓ | — | — | — | — | — |

## 5. Enforcement rules

1. Every Server Action, Route Handler, job handler and report query calls the authorisation service. Checking in the UI alone never counts as enforcement.
2. Authorisation runs **twice**: (a) `can(actor, permission)` decides whether the action is allowed at all; (b) the data-access layer applies the scope filter to the query (`WHERE org_id = :org AND <scope predicate>`), so you cannot read records you can't see.
3. PostgreSQL row-level security enforces `org_id` isolation as a second line of defence (ADR-0004). Own/team scoping is enforced in the application layer.
4. Background jobs carry `org_id` and `actor_user_id` (or `system`). They re-check authorisation when they act for a user (for example, an export).
5. Unknown permissions are denied by default. Adding a permission to the catalog without granting it to a role grants it to nobody.
6. Permission tests: an automated matrix test runs every permission × role × scope combination against seeded fixtures. Adding a permission without updating the matrix fails CI.
