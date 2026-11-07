# Metrics Dictionary and KPI Mathematics

> Status: Phase 0 draft. **These definitions are the contract for every dashboard.** Changing a definition needs a doc change, a version bump (`kpi_definitions_version`), and a release note. KPIs affect employee evaluation, so ambiguity is a defect.

## 1. Ground rules

1. **Time zone.** All periods are evaluated in the organisation's time zone (default `Asia/Kolkata`). "Today" means the org's local calendar day. Data is stored in UTC (`timestamptz`).
2. **Periods.** Selectable: today, yesterday, this/last week (Mon–Sun), this/last month, custom range (max 366 days). Ranges are half-open: `[start, end)`.
3. **Scope.** Every KPI is computed inside the viewer's permission scope (own/team/org) and the selected filters. A user never sees a figure computed over records they cannot drill into.
4. **Two lenses, never mixed in one ratio:**
   - **Activity lens** ("what happened in the period"): counts of events whose timestamp falls in the period, attributed to the **actor** of the event.
   - **Cohort lens** ("how well did leads convert"): a set of leads defined by an *entry* event in the period (created or assigned). We measure whether a *milestone* was reached **within a fixed maturity window** after entry (default 30 days for contact/qualify/visit, 90 days for booking; configurable per org).
5. **Maturity.** A cohort ratio is reported as *final* only for cohort members whose window has fully elapsed. Members still inside their window are shown as "in progress" and excluded from the final ratio. This stops a lead assigned yesterday being compared with one assigned three months ago.
6. **Exclusions (all KPIs unless stated):** deleted leads; leads marked `is_test`; merged-away leads (counted once, on the surviving lead); leads with `contact_status = INVALID` are excluded from conversion denominators but reported separately as "invalid leads".
7. **Milestones use the first-reached timestamps** (`first_contacted_at`, `qualified_at`, `first_visit_scheduled_at`, `first_visit_completed_at`, `won_at`, `lost_at`), not the current stage. A lead that reached Site Visit Completed and then went to Nurture still counts as visited.
8. **Missing data is not zero.** Provider-dependent KPIs show "—" with a coverage note when integration data is unavailable for the scope.

## 2. Attribution of leads to people when ownership changes

Each lead's ownership is a series of **assignment spells** from `LeadAssignmentHistory`: `(lead, user, team_at_time, started_at, ended_at)`.

| Question | Rule |
|---|---|
| Who gets credit for an activity (call, visit done)? | The **actor** who performed it, regardless of current owner |
| Who gets credit for a milestone (qualified, visited, won)? | The owner whose spell contains the milestone timestamp (the **milestone owner**) |
| Which team gets credit? | `team_at_time` on that spell, not the user's current team |
| Per-user cohort denominator | Spells **started** in the period for that user. A lead reassigned within the period counts once for each user who held it |
| Short spells | Spells shorter than the "grace period" (default 24 h) that ended by reassignment **without any interaction by that user** are excluded from that user's denominator, so misassignment corrections don't penalise anyone |
| Org-level cohort | Each lead counts once, regardless of reassignments |

## 3. Metrics

Notation: `P` = selected period; `S` = scope (own/team/org + filters); `W` = maturity window.

### Lead volume

| # | KPI | Lens | Definition (numerator / denominator) | Source | Notes / exclusions |
|---|---|---|---|---|---|
| K01 | **Total leads received** | Activity | Count of `LeadEnquiry` with `received_at ∈ P`, in `S` | LeadEnquiry | Also shown as **New unique leads** = leads with `created_at ∈ P`. Repeat enquiries on an existing lead count in K01 but not in "new unique" |
| K02 | **Leads assigned** | Activity | Count of assignment spells with `started_at ∈ P` (org view: distinct leads) | LeadAssignmentHistory | Excludes system re-assignments caused by merge |
| K03 | **Leads currently unassigned** | Snapshot | Count of open leads with `owner_user_id IS NULL` now | Lead | Also show **median age in queue**. Ignores P |

### Calling and contact

Measurement levels, from weakest to strongest evidence:

| Level | Event | Evidence |
|---|---|---|
| L0 | Call-button click | `CallIntent` row. The user tapped Call/WhatsApp. **Not a call** |
| L1 | Manually logged attempt | `Interaction` with `source = MANUAL` |
| L2 | Provider-confirmed attempt | `Interaction` with `source = PROVIDER` and a provider call id |
| L3 | Connected | Outcome group `CONNECTED` (manual) or provider status answered/completed |
| L4 | Meaningful conversation | Connected **and** (provider duration ≥ 30 s, configurable) **or** manual outcome in {`CONNECTED_INTERESTED`, `CONNECTED_CALL_BACK`, `CONNECTED_NOT_INTERESTED`, `CONNECTED_ALREADY_BOUGHT`} |

| # | KPI | Lens | Definition | Source | Notes |
|---|---|---|---|---|---|
| K04 | **Call-button clicks** | Activity | Count of `CallIntent` with `created_at ∈ P`, by channel | CallIntent | Labelled "Call intents (taps)". Never presented as calls |
| K05 | **Logged call attempts** | Activity | Count of `Interaction` channel ∈ {phone, WhatsApp call}, `source = MANUAL`, `occurred_at ∈ P` | Interaction | Self-reported |
| K06 | **Provider-confirmed call attempts** | Activity | Count of `Interaction` with `source = PROVIDER`, `occurred_at ∈ P` | Interaction | "—" if no provider is active for the scope in P |
| K07 | **Connected calls** | Activity | Count of interactions with outcome group `CONNECTED`. Shown split as provider-verified vs self-reported | Interaction | Never summed into one number without the split visible |
| K08 | **Call connection rate** | Activity | K07 / (K05 + K06), computed **separately** per source type (manual / provider) | Interaction | Hidden if denominator < 20 (low-sample guard) |
| K08b | **Outcome logging rate** | Activity | Call intents followed by a logged interaction on the same lead by the same user within 2 h / K04 | CallIntent, Interaction | Adoption metric. Not a performance metric |
| K09 | **Leads contacted** | Cohort | Leads in cohort with `first_contacted_at` ≤ entry + W / cohort size | Lead | Cohort entry = assignment spell start (per user) or `created_at` (org) |
| K09b | **First-contact time (speed to lead)** | Cohort | Median and p75 of (`first_contacted_at` − first assignment `started_at`), in **working hours** of the owner (excluding non-working days and approved leave) | Lead, Leave, Org settings | Leads never contacted shown separately |

### Funnel and conversion

| # | KPI | Lens | Definition | Source | Notes |
|---|---|---|---|---|---|
| K10 | **Qualified leads** | Activity / Cohort | Activity: leads with `qualified_at ∈ P`. Cohort: qualified within W / cohort | Lead, StageHistory | |
| K11 | **Site visits scheduled** | Activity | Count of `SiteVisit` created with `created_at ∈ P` (excluding visits later deleted as erroneous) | SiteVisit | Reschedules don't create new visits |
| K12 | **Site visits completed** | Activity | Count of `SiteVisit` with `status = ATTENDED` and `attended_at ∈ P`, credited to the visit's assigned user | SiteVisit | Multiple properties in one visit = 1 visit |
| K12b | **Visit show-up rate** | Activity | Visits attended / (visits attended + no-show + customer-cancelled within 24 h), by `scheduled_for ∈ P` | SiteVisit | |
| K13 | **Lead-to-site-visit conversion** | Cohort | Cohort leads with `first_visit_completed_at` ≤ entry + W(30 d) / matured cohort size | Lead | **Headline KPI** |
| K14 | **Lead-to-booking conversion** | Cohort | Cohort leads with `won_at` ≤ entry + W(90 d) / matured cohort size | Lead | **Headline KPI** |
| K15 | **Booking conversion rate (visit-to-booking)** | Cohort | Leads whose first visit was completed in P and that reached `won_at` within 60 d after it / leads with first visit completed in P (matured) | Lead | |
| K16 | **Lost-lead rate** | Cohort | Cohort leads with `lost_at` within W(90 d) / matured cohort size. Plus **lost reasons distribution** (count by reason, activity lens) | Lead, StageHistory | Reopened leads still count as lost-at-least-once. A "currently lost" view is also provided |
| K17 | **Conversion by lead source** | Cohort | K13 and K14 grouped by first-touch `source_id`. Optional "any-touch" view by enquiry sources | Lead, LeadEnquiry | Sources with cohort < 20 flagged low-sample |

### Follow-ups and tasks

| # | KPI | Lens | Definition | Source | Notes |
|---|---|---|---|---|---|
| K18 | **Follow-ups due** | Activity | Open or completed follow-up tasks with `due_at ∈ P`, credited to the task's assignee (current assignee for open tasks; assignee at completion/cancellation for closed tasks) | Task | Task reassignments are recorded in LeadActivity/AuditLog but the model holds no task-assignment history. If due-time attribution is disputed in the pilot, add `TaskAssignmentHistory` (Phase 4 change, no KPI formula change) |
| K19 | **Overdue follow-ups** | Snapshot | Open follow-up tasks with `due_at` < now − grace (default 1 h) | Task | Tasks of users on approved leave on the due date are reported in a separate "on leave" column, not as overdue for that user |
| K19b | **Follow-up timeliness** | Activity | Follow-ups with `due_at ∈ P` completed within due + grace / K18 | Task | |
| K20 | **Task completion rate** | Activity | Tasks with `due_at ∈ P` and status `DONE` / tasks with `due_at ∈ P` excluding `CANCELLED` with reason "No longer relevant" | Task | Manager-created tasks can be reported separately |

### Revenue

| # | KPI | Lens | Definition | Source | Notes |
|---|---|---|---|---|---|
| K21 | **Bookings (won deals)** | Activity | Deals reaching `BOOKED` with `booked_at ∈ P`, excluding deals later `CANCELLED` (shown separately as "cancelled bookings") | Deal | Value = sum of `deal_value` |
| K22 | **Expected brokerage** | Snapshot / Activity | Sum of `expected_amount` on brokerage records for deals booked (not cancelled), with `expected_on ∈ P` or "all outstanding" | Brokerage | INR, decimal; no floats |
| K23 | **Closed (collected) brokerage** | Activity | Sum of `BrokeragePayment.amount` with `received_on ∈ P` (net of reversals) | BrokeragePayment | Credited to deal owner(s) per split; unsplit → deal owner |
| K24 | **Brokerage outstanding** | Snapshot | Expected − received for non-written-off records | Brokerage | |

## 4. Fair comparison rules (shown in the UI)

- Leaderboards and per-user tables show **cohort size** and **matured share** next to each ratio. Ratios with denominator < 20 are greyed with "low sample".
- Default per-user comparison uses **working days available** (calendar working days minus approved leave) for activity counts: "calls per working day", not raw totals.
- Users who joined, changed team or were on leave during P are flagged.
- Provider-confirmed and self-reported metrics are never ranked together.
- Unassigned queue time is attributed to the **team/manager**, not the eventual executive.

## 5. Implementation guidance (for Phase 4)

- All KPI SQL lives in one module (`reporting/kpis`) as named, tested query functions. Tiles and drill-downs call the same function, so their counts match by construction.
- Each KPI function has fixture-based tests covering reassignment, leave, maturity windows, merges and time-zone day boundaries (23:30 IST vs 18:00 UTC).
- Snapshot KPIs are computed live. Heavy cohort KPIs may use nightly materialised aggregates (`kpi_daily_*` tables) plus a live "today" delta. Introduce this only when p95 > 2 s (see NFRs).
