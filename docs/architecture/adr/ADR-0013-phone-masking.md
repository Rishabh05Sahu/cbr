# ADR-0013: Phone masking and reveal auditing (FR-060)

- **Status:** Proposed. Implemented locally (uncommitted) on 2026-10-28; decision 10 amended on 2026-10-29 at the owner's review (exports are masked); awaiting owner review.
- **Date:** 2026-10-28
- **Builds on:** [ADR-0004](ADR-0004-multi-tenancy-and-permissions.md), [ADR-0012](ADR-0012-contact-status.md). Migration `0016_phone_masking`.

## Context
Phase 3 slice 7 (owner approval 2026-10-28) implements FR-060 only. Calling and WhatsApp launchers, call intents, outcomes and the communication timeline are not built.

Sources:
- **FR-060 (Should):** "Phone masking (org setting): numbers shown masked in lists. Reveal is an explicit, logged action." Acceptance: "Reveal creates audit row; daily reveal cap configurable."
- **FR-025:** phone masking is an org setting, and setting changes are audited.
- **Role matrix §4.1:** `lead.reveal_phone` (when masking is enabled) is O / O / T / S; HR and platform staff have none. **§4.6:** phone masking belongs to `org.security_policy.manage`, which is Owner only.
- **Workflow B:** audit event `lead.phone_revealed` (if masking is on); dialling a masked number counts as a reveal.
- **Threat model:** "reveal phone" goes through `authorize` in the module command, never only in the UI; phone reveals have a daily cap; phone reveal is an audited lead event. **T15 / R-10:** masking deters and audits, it does not prevent.
- **lead-lifecycle §6:** personal data shows as "changed" in audit, never as values.

## Decisions

| # | Decision | Source / why | Enforcement / evidence |
|---|---|---|---|
| 1 | **Setting:** `organization.phone_masking` (default **off**) and `phone_reveal_daily_cap` (default **50**, range 1–1000), changed by the Owner only and audited (`organization.phone_masking_updated`). Admins see them read-only. | FR-060, FR-025, §4.6. *Defaults not specified:* off keeps today's behaviour until an Owner opts in. 50 is a starting value the Owner can change. | App `authorize`; DB trigger `organization_security_policy_guard` |
| 2 | **Where numbers are masked:** in every server query that feeds a page: the lead list and queue (`searchLeads`), the lead detail (`getLead`, primary and alternate) and the merge preview (alternate-phone values), and in the Owner's export file (decision 10). Full numbers never leave the server when masking is on, except through a reveal. | FR-060 says "lists"; workflow B ("dialling a masked number") implies the lead page is masked too, and an unmasked detail page would defeat list masking. | Integration test checks that no returned JSON contains the number |
| 3 | **Format:** `+91 ••••••4066` for Indian numbers; other numbers show only their last four digits. | *Not specified.* The last four digits let people tell leads apart without the full number. | Unit tests |
| 4 | **Reveal:** `lead.reveal_phone` in the lead's scope, only while masking is on. It returns the primary and alternate numbers. A failed or refused reveal returns no number. | §4.1; threat model (`authorize` in the command) | App and DB; tests for role, scope, other org, bad id |
| 5 | **Audit:** every reveal inserts a `lead_phone_reveal` row (lead, person, time), and its trigger writes a `lead.phone_revealed` audit row with `{ revealId }` only, never the number. Repeated reveals are recorded separately. The number is read only after the row is written, in the same transaction. | FR-060 ("creates audit row"), workflow B, lead-lifecycle §6 | Triggers; tests |
| 6 | **Daily cap:** per person, per org-local day, counted from that person's reveal rows under a per-person advisory lock, in the app and again in the database. Parallel requests cannot exceed it. | FR-060, threat model | Tests: app refusal, direct insert refused, 6 parallel requests with cap 3 → 3 succeed |
| 7 | **Records are append-only:** no UPDATE or DELETE grant. The actor and time are stamped by RLS, so they cannot be forged or back-dated. Owner/Admin read all reveal rows; others read only their own; HR, support and other orgs read none. Audit rows use the existing append-only `audit_log` (`audit.read`, Owner/Admin). | NFR-060; §4.6 `audit.read` | RLS and grants; tests |
| 8 | **Visibility:** a revealed number exists only in the page's component state (the server action result is not cached and revalidates nothing). It disappears on "Hide number", reload or navigation. | *Not specified.* This is the narrowest option. | Component and browser tests |
| 9 | **Contact status:** revealing never changes the lead (no version change, no contact-status event), and never permits contact. A Do-Not-Contact lead's revealed number is labelled "for reference only". `outboundEligibility` is unchanged: Do-Not-Contact stays a hard block and Invalid stays blocked for integration sends. | FR-065 / ADR-0012 | Tests |
| 10 | **Exports (amended 2026-10-29):** while masking is on, the Owner's CSV export (FR-066) has its `Phone` and `Alternate phone` columns masked in the same format (`loadExportRows` applies `phoneDisplay`; the worker builds the file). With masking off the export is unchanged. The setting is read when the worker builds the file, not when the export is requested: jobs reload state and carry ids, never snapshots (system-architecture, jobs rule 1). The Owner-only permission, requester-only jobs, quota, row cap, watermark, formula neutralising, single-use download and audit entries are unchanged. There is no bulk reveal: full numbers come only from the per-lead, capped, audited reveal. Duplicate detection, phone search, imports and merges still use the stored numbers. | Owner review of FR-060 (2026-10-29): exports must not bypass masking or the reveal cap | Unit tests (`export-rows`); integration test `export-masking` (generated file, download, job rows, audit rows) |

## Known limitations
- **Enforcement is in the application.** Masking is applied in the module queries, the same layer as the scope rules. `crm_app` can still SELECT the phone columns, because duplicate detection, imports, merges and exports need them. The database enforces the reveal record, cap and audit, not the masking itself.
- **Exports:** the masking applies to the file built while it is on. A file built before an Owner turned masking on keeps full numbers until it expires (at most 15 minutes to download, purged within an hour of the request). The export's search filter still matches full numbers (phone search is unchanged), so a filtered export can confirm that a number belongs to a lead without showing it. The org-termination "full data export" in the role list is not built; when it is, it needs its own decision.
- **Import screens and the problems CSV** show column headings, row numbers and messages, never cell values (unchanged). The **create-lead** duplicate message never shows the existing lead's number.
- **No reveal from the list:** reveal is on the lead page only.
- **Refused reveals** (over the cap, out of scope) are not logged as audit events. The threat model's anomaly alerts are not built.
- **Workflow B's "dialling a masked number counts as a reveal"** applies when the call launcher (FR-080) exists. The launcher must take the number through `revealLeadPhone`, or through an equivalent that records a reveal, and must call `assertOutboundAllowed`.
- **Legal gate G5 stays open** (B1 personal SIMs, A3 DND scrubbing). Masking does not resolve it.
