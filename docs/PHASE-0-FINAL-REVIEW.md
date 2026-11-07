# CBR Property CRM: Phase 0 Final Review

> Review date: **2026-10-19** · Scope: documentation only. No code, scaffolding, packages, git repository, schemas or migrations were created.
> **Phase 1 has not started. It requires explicit written approval from the business owner.**

## 1. Executive summary

The Phase 0 blueprint was re-read end to end, re-verified against current official sources, and corrected where it was inconsistent. The intended architecture is **unchanged**:
- modular monolith (Next.js App Router + TypeScript), with a separate background worker;
- PostgreSQL 18 + Prisma 7;
- server-enforced permissions;
- tenant isolation via PostgreSQL RLS **and** scoped application queries;
- transactional outbox;
- private object storage;
- adapter-based calling/messaging integrations.

The review made these material changes:
1. **Six business decisions recorded as accepted planning defaults:** OD-01 (basic site visits in Phase 4), OD-03 (Owner/Admin split), OD-13 (Mailpit locally + provider evaluation), OD-14 (Pune pilot, configurable), OD-15 (DigitalOcean Bengaluru candidate, ₹15,000/month provisional ceiling), OD-16 (single-brokerage pilot first). Each carries its stated conditions. **None is marked as a final business-owner sign-off.**
2. **Tenant isolation gate strengthened:** the RLS design now covers child tables, pre-tenant lookups (session, webhook, share and invitation tokens) and platform-scoped tables. Spike **S1** has explicit pass/fail criteria (§7) and is a hard gate in the roadmap.
3. **Identity spike S2 defined.** Better Auth's organisation plugin was checked against our role model. It fits for roles, but has **no team roles**, **allows multiple roles per member**, and defaults to 48-hour invites and a 100-member limit. Our own team-lead model and a single-role guard remain necessary.
4. **Version facts updated:**
   - Next.js 16.4.2 current, with **≥ 16.4.1 as the security floor** after the 14 Oct 2026 advisory.
   - Node 24 LTS.
   - pnpm 12 (`onlyBuiltDependencies` was removed and replaced by `allowBuilds`).
   - Prisma 7.10.1. `prisma@latest` now resolves to an 8.0 RC, so the version must be pinned.
5. **Calling research tightened:**
   - India availability of WhatsApp business-initiated calling remains **inferred, not confirmed**.
   - Neither shortlisted telephony provider (Exotel, Smartflo) documents webhook signing, so reconciliation becomes mandatory before provider data counts as "verified".
6. **Hosting claims qualified:** DigitalOcean is a candidate, AWS migration is **conditional, not planned**, and alternative Indian-region providers are listed. **New finding:** the ₹15,000/month ceiling is met only *without* database HA (≈ ₹7.6k vs ≈ ₹27.8k with HA). Pilot NFRs were adjusted, and the business owner must accept this or raise the budget (§2.2).

**Readiness verdict:** the blueprint is **ready for approval to begin Phase 1**, conditional on the items in §9. Phase 1 must start with spikes S1 and S2, and no CRM functional module may be built until both pass.

## 2. Decision register (OD-01 … OD-16)

Legend:
- **Owner** = needs business-owner approval; **Arch** = the technical architect can decide.
- **Blocks P1?** = must be settled before Phase 1 can start or exit.
- **Status** values: *Accepted (planning default)* = taken from the business brief of 2026-10-19 and still subject to the stated conditions and final sign-off; *Open (default proposed)* = no business answer yet.

| ID | Existing question (from assumptions-and-open-decisions.md) | Documented recommendation (before review) | Alternatives | Recommended default (now) | Impact | Decided by | Blocks P1? | Safe to defer? | Status | References |
|---|---|---|---|---|---|---|---|---|---|---|
| OD-01 | Should basic site visits come before full property inventory? | (b) Phase 4 | (a) Phase 5; (c) Phase 3 | **Basic visits in Phase 4** (schedule, assignee, status, reschedule, cancel/no-show, completion, visit-level outcome). Property links, matching, deals in Phase 5 | Headline KPI (lead→visit) available one phase earlier; small model change (visit without property) | Owner | No | n/a (decided) | **Accepted (planning default)** | FR-150–152, FR-157; roadmap Ph 4/5; domain-model SiteVisit; workflows D |
| OD-02 | Confirm success metrics and NFR targets (availability, RPO/RTO, performance) and KPI maturity windows (30/90 days) | As documented | Stricter/looser targets | Keep documented targets as provisional | Drives infra cost and test thresholds | Owner (targets) + Arch (validation) | **Partly**: RPO/RTO and availability needed for Phase 1 exit (restore drill) | KPI windows can wait to Phase 4 | Open (default proposed) | vision §7; NFR §1–3; metrics §1 |
| OD-03 | Split "Company Super Admin" into Owner + Admin? | Yes | Single admin role | **Yes**: Owner-only actions defined (roles §2.3); Platform Super Admin stays separate | Shapes seed roles, permission matrix, Better Auth role mapping | Owner | **Yes** (needed at start) | n/a | **Accepted (planning default)** | user-personas-and-roles §2.1–2.3, §4; ADR-0004 |
| OD-04 | Is a break-glass platform access process needed? | No for pilot | Two-admin break-glass with owner alert | **No for pilot.** Support grants only | Affects platform admin tooling and audit | Owner | No | **Yes** (revisit before second tenant) | Open (default proposed) | roles §3; threat T18 |
| OD-05 | May orgs add custom sub-statuses? | Tags | Sub-status field; none | **Tags** (no KPI impact) | Lead UI/filtering | Arch (with product) | No | Yes (Phase 2) | Open (default proposed) | lead-lifecycle §2.1 |
| OD-06 | Handle owner-side enquiries (sellers/landlords) in the lead model? | Same Lead with `transaction_type` SELL/LET_OUT | Separate owner-lead entity | Same Lead, revisit in Phase 5 | Lead form, KPIs (exclude owner-side from buyer funnel if needed) | Owner (business process) | No | Yes (Phase 2) | Open (default proposed) | lead-lifecycle §4 |
| OD-07 | Model new-development projects? | Project entity as Should in Phase 5 | Not needed | Project as Should in Phase 5 | Property model, scripts targeting | Owner | No | Yes (Phase 5) | Open (default proposed) | FR-145; domain-model Project |
| OD-08 | Multi-sheet XLSX imports? | Let user choose sheet | First sheet only | Choose sheet | Import UX | Arch | No | Yes (Phase 2) | Open (default proposed) | workflows A |
| OD-09 | UI languages beyond English? | English only, strings externalised | Hindi/Marathi at launch | English only; externalise strings from Phase 1. Pune pilot may value Marathi later | i18n plumbing cost is small if done early | Owner | No (externalising strings is an Arch default) | Yes (Phase 3) | Open (default proposed) | NFR-093 |
| OD-10 | Which RERA data to hold and which states? | Agent RERA no. per state + project RERA id (Phase 5) | Full compliance module | Default plus **Maharashtra (MahaRERA) first** given the Pune pilot | Property/share templates; legal review | Owner + legal | No | Yes (Phase 5) | Open (default proposed) | compliance §5 |
| OD-11 | Introduce a Person/Contact entity across leads? | Later | Now | Later | Data model for repeat customers | Arch | No | Yes (Phase 5 review) | Open (default proposed) | domain-model §3 |
| OD-12 | Telephony provider and WhatsApp BSP | Shortlist Exotel + Smartflo; BSP per PoC | MyOperator, Ozonetel, Plivo; Meta direct | Unchanged; PoC-1…5 first | Phase 6 cost and data quality | Owner (commercial) + Arch (PoC) | No | **Yes** (Phase 6) | Open (default proposed) | calling research §2, §5; ADR-0006 |
| OD-13 | Transactional email provider | Amazon SES ap-south-1 or similar; decide in Phase 1 | See §2.1 | **Mailpit locally (accepted)**; production recommendation in §2.1, **not yet selected** | Invitations/resets depend on it; DPDP sub-processor | Arch (shortlist) + Owner (account/billing) | Needed **before staging exit** of Phase 1, not before start | Until Phase 1 staging | **Accepted (planning default)** for local; production selection open | integration-strategy §7–8 |
| OD-14 | Target states for go-to-market | Confirm pilot city first | Other cities | **Pune, Maharashtra**, subject to a willing brokerage. Cities/localities remain org-configurable data; nothing hard-coded | Locality seed data, MahaRERA, language | Owner | No | n/a | **Accepted (planning default)**, conditional on pilot brokerage | lead-lifecycle §4; compliance §5 |
| OD-15 | Hosting budget; does any target customer mandate AWS? | DO BLR1 unless AWS mandated | AWS Mumbai; others in §2.2 | **DigitalOcean Bengaluru as candidate**, provisional ceiling **₹15,000/month** (excl. telephony, WhatsApp, taxes, variable third-party costs), **subject to a priced estimate** in Phase 1. AWS Mumbai is an alternative only when justified | Infra design, cost, ops effort | Owner (budget) + Arch (estimate) | **Yes**: priced estimate needed before staging is provisioned | No | **Accepted (planning default)**, conditional | ADR-0007; deployment §2 |
| OD-16 | Internal pilot first or SaaS from day one? | Internal pilot first, multi-tenant throughout | SaaS from day one | **Pilot with one brokerage**; multi-tenant isolation and org-specific config kept; self-service onboarding, billing and broad launch deferred until the pilot validates workflow and costs | Removes billing/onboarding from Phases 1–5 | Owner | Yes (scope) | n/a | **Accepted (planning default)** | vision §5; roadmap |

### 2.1 OD-13: transactional email evaluation

- **Accepted:** Mailpit for local development and tests, with email always behind the `EmailSender` adapter.
- **Evaluated** (integration-strategy §8): Amazon SES ap-south-1 (≈ $1 per 10k, India region, sandbox exit ≈ 96 h); Zoho ZeptoMail India DC (≈ ₹150 per 10k, INR billing); Postmark ($15); Resend ($20); Brevo; SendGrid. Only SES and ZeptoMail offer India data location.
- **Recommendation:** Amazon SES ap-south-1, with ZeptoMail India DC as the alternative.
- **Not selected yet.** Selection follows a staging deliverability seed test and business approval of the account/billing owner, before Phase 1 staging exit.

### 2.2 OD-15: hosting evaluation summary

- **Candidate:** DigitalOcean Bengaluru. BLR1 offers App Platform (web + worker components), Managed PostgreSQL 15–18, Managed Valkey and Spaces. PITR is 7 days and PgBouncer is available. `doadmin` has Bypass RLS, so a dedicated app role is mandatory (S1-01, S1-18).
- **Budget finding (material):**
  - DigitalOcean is removing standby nodes from Standard Edition (new accounts 15 Oct 2026, all accounts 30 Nov 2026). Database HA now needs Advanced Edition (≥ $130 per node).
  - Estimates at ₹88/USD before GST:

    | Configuration | Estimate |
    |---|---|
    | Pilot without DB HA | ≈ **₹7,600/month** (smallest ≈ ₹6,300) |
    | With HA | ≈ **₹27,800/month**, which **exceeds the ₹15,000 ceiling** |

  - **Proposed:** run the pilot on a single DB node with PITR, nightly off-site dumps, restore drills and a 99.5% availability target. NFR-020/022, R-12 and ADR-0007 are updated to match.
  - **Business-owner decision needed:** accept no-HA for the pilot, or raise the budget.
- **Alternatives** verified to have India regions with managed PG 18 and Redis/Valkey: AWS Mumbai/Hyderabad, GCP Mumbai/Delhi, Azure Central/South India (partly verified). Akamai, Vultr and E2E are partly verified. Oracle has PG 17 only. Railway, Render and Fly have no India region.
- **Nothing beyond DigitalOcean was priced.** AWS is conditional, not planned. Details: deployment-and-operations §2–2.1.

## 3. Defaults vs. business-owner approvals

**Require business-owner sign-off before or during Phase 1:**
- OD-03 (role split, accepted as planning default).
- OD-15 (budget ceiling and hosting, after the priced estimate), **including acceptance of a pilot without database HA** (99.5% target, RTO ≤ 4 h).
- OD-16 (pilot strategy, accepted).
- OD-14 (named pilot brokerage).
- OD-02 (availability/RPO/RTO targets).

**Require business-owner input later:** OD-01 (accepted), OD-04, OD-06, OD-07, OD-09, OD-10, OD-12 (commercial terms).

**Architect may decide** (documented defaults stand unless challenged): OD-05, OD-08, OD-11, the OD-13 shortlist, and the OD-12 PoC design.

**Legal review (not a business default):** compliance notes §8, especially personal-SIM calling under TRAI TCCCPR (R-02), the DPA, and the lawful basis for imported leads. Needed **before the pilot uses real customer data**, not before Phase 1 starts.

## 4. Changes made during this review

| # | File(s) | Change | Reason |
|---|---|---|---|
| 1 | functional-requirements | FR-150–152 moved to Phase 4 as **basic** visits; new **FR-157** (property-linked visits, Phase 5) | OD-01 |
| 2 | lead-lifecycle, workflows (D), vision-and-scope | Automatic Site-Visit stage from Phase 4; Workflow D phase split | OD-01 consistency |
| 3 | domain-model, erd.mmd, module-boundaries | SiteVisit can exist without properties (`||--o{`), visit-level outcome fields; site-visits → properties dependency marked Phase 5/optional | OD-01; previous ERD required ≥ 1 property per visit, which contradicted basic visits |
| 4 | phase-roadmap | Phase 4/5 scope, DB and acceptance lists; Phase 0 exit; **Phase 1 gated on S1 + S2**; measurable exit criteria replacing "qualitative" ones | §5, §7 of review brief |
| 5 | user-personas-and-roles | New §2.3 responsibility split with **Owner-only actions**; new `org.security_policy.manage` (Owner only); OD-03 marked accepted | OD-03 |
| 6 | database-design §2 | Coverage rule for child tables + CI catalog check; SECURITY DEFINER pre-tenant lookups; platform-table policies; link to S1 | Gap: session/webhook/share/invite resolution needs a lookup before tenant context, and was undocumented |
| 7 | metrics-and-kpis K18 | Attribution changed to the task's current/closing assignee; note on adding TaskAssignmentHistory if disputed | K18 referenced "assignee at due time", which the data model cannot reconstruct |
| 8 | ADR-0002 | Prisma 7 PG 18 support and support-window evidence; `prisma@latest` = RC warning | Re-verification |
| 9 | ADR-0003 | Organisation-plugin fit table (multi-role, no team roles, 48 h invites, 100-member limit) | Re-verification |
| 10 | ADR-0007, deployment-and-operations §2/§2.1/§3/§5, NFR-020/022, risk R-12, assumptions A-13, README | Hosting: DO as **candidate**, ₹15k provisional ceiling, cost estimate, single-node pilot DB (HA exceeds budget), nightly off-site dumps, PgBouncer transaction mode + no `doadmin`, AWS conditional, alternative providers compared | OD-15; removed the unqualified "only DO and AWS" claim; topology previously assumed a standby node |
| 11 | integration-strategy §8 (new), assumptions | Email adapter + provider evaluation; Mailpit for local/test | OD-13 |
| 12 | calling-and-whatsapp-research §1.1 (new), integration-strategy §5 | Second-pass verification: +91 still unverified; no webhook signing at Exotel/Smartflo; retries; correlation fields | Re-verification |
| 13 | security-and-threat-model T21, repository-structure | pnpm `allowBuilds` (replaces removed `onlyBuiltDependencies`), Node 24 LTS, version pins | Re-verification |
| 14 | assumptions-and-open-decisions, PHASE-0-README | Decision statuses, Pune pilot, budget, links to this review | §2–3 of review brief |

**Checked and found consistent (no change needed):**
- Stage vs outcome separation (lead-lifecycle §1, §3; KPIs).
- CallIntent (L0) vs Interaction evidence levels (metrics §3, domain model, ADR-0006).
- Ownership history (LeadAssignmentHistory with exclusion constraint; KPI attribution §2).
- Platform admin vs Owner (roles §3 + §2.3).
- Calling/WhatsApp items labelled VERIFIED/PREREQ/UNCERTAIN.
- All relative links resolve (link check run after edits).

## 5. Remaining risks and unresolved questions

| Ref | Item | Next action |
|---|---|---|
| R-02 | TRAI exposure of personal-SIM calling | Legal opinion before pilot uses real leads |
| R-03 | DPDP readiness (main obligations ~13 May 2027; shortening proposed, not notified) | Re-check gazette at each phase gate |
| R-05 | Executive adoption of manual logging | Phase 3 pilot metric K08b ≥ 70% |
| R-06 | Prisma 7 + RLS ergonomics and pool pressure | Spike S1 |
| R-07 | Better Auth organisation-plugin fit | Spike S2 |
| R-08 | KPI disputes in evaluations | HR sign-off before KPIs are used in appraisals |
| R-13 | Framework advisories (two critical Next.js RCEs on 14 Oct 2026) | Pin ≥ 16.4.1; patch within 48 h of advisories |
| New | No named pilot brokerage yet (OD-14 condition) | Business owner to confirm before Phase 2 (real import files needed, R-09) |
| New | ₹15k/month ceiling is only met **without database HA** (estimate ≈ ₹7.6k vs ≈ ₹27.8k with HA) | Business owner to accept no-HA pilot or raise budget; confirm with first staging bill |
| New | Telephony webhooks unsigned at both shortlisted providers | PoC-2 spoofing tests; reconciliation mandatory |

## 6. Facts still requiring verification

| Area | Item | Status | How to verify |
|---|---|---|---|
| WhatsApp | +91 on Meta's supported business-number country-code list for business-initiated calls | UNVERIFIED (inferred from exclusion list) | Written BSP/Meta confirmation; PoC-4 |
| WhatsApp | India per-minute calling rate and INR messaging rates | UNVERIFIED | Meta INR rate-card CSV / BSP quote |
| WhatsApp | Exotel WhatsApp calling GA | UNVERIFIED (Beta per Dec 2025 blog) | Exotel sales confirmation |
| Telephony | Exotel webhook IP ranges; Smartflo "Headers" as real HTTP headers; Smartflo `custom_identifier` on `/v1/click_to_call` | UNVERIFIED | Provider support + PoC-1/2 |
| Telephony | Exotel recording-retention default per plan | Conflicting docs | Contract |
| Hosting | Advanced Edition (HA) in BLR1; App Platform worker persistence semantics; creating a non-BYPASSRLS app role in practice; GST treatment | PG 18, PITR 7 d, PgBouncer, Valkey `noeviction` verified; rest UNVERIFIED | S1-18 on staging; first bill |
| Hosting | Exact monthly price at ₹ exchange rate | Estimate only | Priced estimate (OD-15) |
| Stack | Node 26 support in Prisma 7 | UNVERIFIED | Stay on Node 24 LTS |
| Stack | Prisma 8 GA date | UNVERIFIED | Not needed (Prisma 7 pinned) |
| Regulatory | DPDP Act commencement notification G.S.R. 843(E) text; any timeline compression | NEEDS-LEGAL-REVIEW | eGazette check |
| Regulatory | CNAP circular (secondary source) | Secondary only | Provider/operator confirmation |

## 7. Tenant-isolation spike (S1) and identity spike (S2): pass/fail criteria

S1 runs **first** in Phase 1, on local Docker `postgres:18` (tag verified available) and then repeated on the staging managed database. Results are recorded in `docs/architecture/spikes/S1-report.md`. **Every criterion must pass. Any failure blocks further modules.** RLS must not be weakened to make the ORM easier. If Prisma cannot meet a criterion, the remedy is a different data-access approach for that path (ADR-0002 "reconsider"), not a weaker policy.

### S1 setup (minimum)
- Roles:
  - `crm_migrator`: schema owner.
  - `crm_app`: the runtime `LOGIN` role. It owns no objects and has `NOSUPERUSER NOBYPASSRLS NOCREATEROLE NOCREATEDB`. On DigitalOcean it is created by `doadmin`, which itself has Bypass RLS and is never used by the app.
  - `crm_platform`.
  - A definer role for pre-tenant functions.
- Representative tables:
  - `organization`, `user`, `organization_membership`, `team`, `team_membership`;
  - `lead`, `lead_assignment_history`, `task`, `interaction`, `audit_log`;
  - a child table without a direct FK to org (e.g. `import_row`) to prove the coverage rule.
- `withTenant(ctx, fn)` wrapper: interactive transaction → `set_config('app.org_id', $org, true)` and `set_config('app.user_id', $user, true)` → callback → commit/rollback. Documented API and its failure behaviour.
- Access paths exercised:
  - Prisma client queries;
  - Prisma `$queryRaw` tagged-template SQL;
  - a Next.js-style Server Action handler;
  - a Route Handler;
  - a BullMQ-style worker handler.

  These can be exercised as test harness functions. Full Next.js scaffolding is not required for S1. The real app paths are re-tested in Phase 1 once scaffolded.

### S1 pass/fail criteria

| # | Criterion | Pass condition |
|---|---|---|
| S1-01 | Role hardening | Catalog query shows `crm_app`: `rolsuper = false`, `rolbypassrls = false`, owns **no** tables, and has no `CREATE` on schema `public` |
| S1-02 | RLS enabled and forced | Every table with an `org_id` column has `relrowsecurity = true` and `relforcerowsecurity = true` (automated catalog test, zero exceptions) |
| S1-03 | Fail closed | As `crm_app` with no `app.org_id`: `SELECT` on every tenant table returns 0 rows; `INSERT`/`UPDATE`/`DELETE` affect 0 rows or raise; nothing errors open |
| S1-04 | Tenant reads | With org A context, querying by known org B ids via ORM and raw SQL returns not found (0 rows) for every representative table |
| S1-05 | Tenant writes | With org A context: inserting a row with `org_id = B` fails (`WITH CHECK`); updating/deleting B's rows affects 0 rows; changing a row's `org_id` from A to B fails |
| S1-06 | Composite FK | Inserting a task (org A) referencing a lead of org B fails at the FK, even when executed by `crm_migrator` (structural guarantee) |
| S1-07 | Transaction-local context | After `withTenant` commits **and** after it rolls back (thrown error), the same pooled connection shows `current_setting('app.org_id', true)` empty/NULL |
| S1-08 | Pool leakage under concurrency | 50 concurrent `withTenant` calls alternating orgs A/B/C over a pool of 5 connections, 1,000 iterations: every query returns only rows of its own org; **0 leaks** |
| S1-09 | Outside-wrapper access blocked | Lint rule rejects importing the raw Prisma client outside `src/platform/db`. A raw-client query at runtime returns 0 tenant rows (fail closed) |
| S1-10 | Server Action path | Harness Server Action builds context from a (mock) session and only sees its org. Calling it with a forged org id in input has no effect (org comes from session, not input) |
| S1-11 | Route Handler path | Same as S1-10 for a Route Handler; a webhook-style handler resolves org only via `resolve_webhook_connection(token)` |
| S1-12 | Worker path | A job payload with `orgId` runs under `withTenant`. A job whose payload org mismatches the referenced entity's org finds 0 rows and fails safely |
| S1-13 | Pre-tenant functions | Each SECURITY DEFINER function returns only its minimum columns, for exactly the matching token/user, has fixed `search_path`, and cannot be used to enumerate other orgs (negative tests) |
| S1-14 | Platform tables | Users read only their own `user` row; `organization` visible only for current org; `audit_log` rows with NULL org invisible to `crm_app` |
| S1-15 | Scope layer (own/team/org) | Repository functions with scope predicates: a Sales Executive sees only own + delegated leads; a Sales Manager sees led teams only; an Admin sees the org. Tested with ≥ 2 teams, overlapping membership, a reassigned lead, an expired delegation |
| S1-16 | Ownership history | Overlapping assignment spells for one lead are rejected by the exclusion constraint |
| S1-17 | Performance sanity | Lead list query with RLS + scope on 250k seeded leads p95 ≤ 500 ms locally; RLS overhead vs. same query as owner without RLS ≤ 15% |
| S1-18 | Staging parity | S1-01, -02, -03, -07, -08 re-run on the **managed staging database** (DigitalOcean or chosen provider) and pass, proving the provider permits the role setup |

### S2: identity and organisation spike (Better Auth 1.7.x)

| # | Criterion | Pass condition |
|---|---|---|
| S2-01 | Auth basics | Email/password sign-in, sign-out-all, password reset (single-use, 30 min), session revocation on suspend, TOTP 2FA enrolment work with Prisma 7 + PG 18 |
| S2-02 | Role mapping | OWNER/ADMIN map to plugin `owner`/`admin`; SALES_MANAGER, SALES_EXECUTIVE, HR_OPS defined via access control; **multi-role assignment is rejected** by hooks |
| S2-03 | Owner invariants | Last Owner cannot leave/be demoted; only Owner deletes org; Admin cannot grant Owner/Admin |
| S2-04 | Invitations | 7-day expiry configured; email must match; acceptance creates membership with our role and optional team |
| S2-05 | Teams | Team-lead relationship works from **our** `team_membership.team_role`; no scope decision reads plugin team data |
| S2-06 | Active org | Active org in session; switching org changes `withTenant` context; no data from the previous org appears afterwards |
| S2-07 | Tables under RLS | Plugin-created org-owned tables (member, invitation, team…) either carry `org_id` + RLS, or are accessed only via pre-tenant definer functions. Documented decision |
| S2-08 | Platform admin | A platform admin has no membership and is denied tenant data; a support grant enables time-boxed read access, audited |

If S2-02, S2-05 or S2-07 cannot pass cleanly, the fallback in ADR-0003 applies: Better Auth core only, with our own membership/invitation tables.

## 8. Phase 1 scope and exclusions

**In scope** (after approval), in this order:
1. Scaffolding: Next.js 16.4.2 (≥ 16.4.1), React 19, TypeScript strict, Node 24 LTS, pnpm 12, ESLint/Prettier, Tailwind 4 + shadcn/ui, `src/env.ts`, Docker Compose with Postgres 18 / Valkey / MinIO / **Mailpit**.
2. **Spikes S1 and S2 (gate).**
3. identity-access, organizations (incl. teams, settings), audit.
4. Platform admin (orgs, support grants).
5. Outbox + worker skeleton + email adapter (Mailpit locally, chosen provider in staging).
6. App shell (responsive, org switcher), Sentry, pino, health check, CI with isolation + permission-matrix suites.
7. Staging in the approved hosting provider; priced estimate; restore drill.

**Explicitly excluded from Phase 1:**
- leads, imports, assignment, calling, scripts, tasks, site visits, dashboards, leave, properties, deals;
- any telephony/WhatsApp integration;
- self-service sign-up, billing/subscriptions;
- AI;
- production launch with real customer data.

## 9. Final readiness checklist

| # | Item | State |
|---|---|---|
| 1 | Repository state documented (empty, no git, toolchain recorded) | ✅ |
| 2 | OD-01…OD-16 register with status, owner, blocking and deferral | ✅ (§2) |
| 3 | Six business decisions recorded as accepted planning defaults with conditions | ✅ |
| 4 | Owner/Admin/Platform separation and owner-only actions | ✅ |
| 5 | Basic visits Phase 4 / property-linked Phase 5 everywhere | ✅ |
| 6 | Tenant-isolation design covers all org-owned entities incl. child and pre-tenant paths | ✅ |
| 7 | S1/S2 pass/fail criteria defined and roadmap-gated | ✅ |
| 8 | Stack versions re-verified (Next.js, Node, pnpm, Prisma, Better Auth, Postgres image) | ✅ |
| 9 | Hosting qualified; ₹15k ceiling recorded as assumption needing a priced estimate | ✅ (estimate itself pending) |
| 10 | Email: Mailpit local; production provider evaluated, **not selected** | ✅ / pending selection |
| 11 | Calling/WhatsApp unverified items labelled | ✅ |
| 12 | Phase exit criteria measurable | ✅ |
| 13 | Links checked | ✅ |
| 14 | No code, packages, git init, schemas or migrations created | ✅ |
| 15 | **Business-owner written approval to start Phase 1** | ✅ Approved 2026-10-19 with conditions ([PHASE-1-GATE-REVIEW §1](PHASE-1-GATE-REVIEW.md)) |
| 16 | Named pilot brokerage (OD-14 condition) | ⏳ Pending (needed before Phase 2) |
| 18 | Business owner accepts no-HA pilot database within ₹15k, or raises budget (OD-15) | ✅ Accepted 2026-10-19 for the controlled pilot (99.5%, restore ≤ 4 h subject to testing, RPO to be measured, full cost estimate before provisioning) |
| 17 | Legal review engaged (compliance §8) | ⏳ Pending (needed before real data) |
