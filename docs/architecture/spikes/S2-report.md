# Spike S2: Identity and Organisation (Better Auth 1.7.11) — Results

> **Result (2026-10-19): 8 of 8 criteria PASS** on local PostgreSQL 18.6 with Prisma 7.10.1. This uses the **organization plugin**, not the ADR-0003 fallback.
> Two design decisions made to get there need review before Phase 1 Step 5 (§3): a dedicated `crm_auth` database role, and invitation links that carry the invitation id.
> No security requirement was weakened. All data is synthetic.

## 1. What was built

| Item | Location |
|---|---|
| Better Auth config: email/password, email verification, reset, TOTP 2FA, organization plugin, telemetry off | `spikes/s2-identity/auth/auth.ts` |
| Role mapping and access control (`owner`, `admin`, `sales_manager`, `sales_executive`, `hr_ops`) | `spikes/s2-identity/auth/roles.ts` |
| Schema: Better Auth models mapped to our tables (`member` → `organization_membership`, `organizationId` → `org_id`), plus our `team`, `team_membership`, `support_access_grant`, `audit_log`, `lead` | `spikes/s2-identity/prisma/schema.prisma` |
| RLS / grants / CHECKs / definer functions | `spikes/s2-identity/prisma/migrations/0002_identity_security/migration.sql` |
| Session → `RequestContext` resolver (membership re-checked on every request; support-grant path) | `spikes/s2-identity/harness/request-context.ts` |
| Commands: suspend member, approve support grant, team-lead scope | `spikes/s2-identity/harness/commands.ts` |
| UUIDv7 generator (production code) | `src/lib/uuidv7.ts` |
| Tests (5 files, 45 tests) | `spikes/s2-identity/tests/` |

## 2. Results

Run: `pnpm spike:s2:test`. Every negative test asserts the **specific** error, for example `OWNER_ONLY_ROLE`, `YOU_CANNOT_LEAVE_THE_ORGANIZATION_AS_THE_ONLY_OWNER` or `organization_membership_single_role`. A rejection can therefore not pass for an unrelated reason.

| # | Criterion | Result | Evidence |
|---|---|---|---|
| S2-01 | Auth basics | **PASS** | Sign-up needs email verification (`EMAIL_NOT_VERIFIED` before). Wrong password rejected; password stored hashed. **Sign-out-all** revokes every session (0 rows left). **Reset:** token TTL = 1,800 s, single use (second use `INVALID_TOKEN`), expired token rejected, old sessions revoked, unknown email sends nothing. **Suspend** → our command sets membership `SUSPENDED` and deletes all the user's sessions; the old cookie → `UNAUTHENTICATED`; after re-login the org → `MEMBERSHIP_INACTIVE`. **TOTP:** enrol → verify first code → `twoFactorEnabled`; secret encrypted at rest; password-only sign-in returns `twoFactorRedirect` with no session; wrong code rejected; correct code → session. All on Prisma 7.10.1 + PG 18.6 |
| S2-02 | Role mapping | **PASS** | Creator = plugin `owner`. Roles resolve to `OWNER`, `ADMIN`, `SALES_MANAGER`, `SALES_EXECUTIVE`, `HR_OPS`. **Multi-role rejected:** arrays, comma lists and unknown roles on add-member, update-role and invite (`ROLE_POLICY`), plus a database `CHECK` if the library is bypassed |
| S2-03 | Owner invariants | **PASS** | Last Owner cannot leave or demote themselves. Only the Owner deletes the org. Admin cannot grant Owner/Admin by role change or invitation (`OWNER_ONLY_ROLE`). Admin cannot demote, remove (by id or email) or suspend another Admin. Admin can manage non-admin roles. Sales/HR roles cannot change roles. With two Owners, one may step down. Users cannot self-create orgs (pilot, OD-16) |
| S2-04 | Invitations | **PASS** | Expiry = 7 days. A different verified user → `YOU_ARE_NOT_THE_RECIPIENT_OF_THE_INVITATION`. The matching user with an **unverified** email is rejected. On acceptance: membership with our role, status `ACTIVE`, **and our `team_membership`** for the invited team. Expired → rejected. A team from another org → composite FK violation |
| S2-05 | Teams | **PASS** | Plugin teams are disabled: no team endpoints, no plugin team tables. Team-lead scope comes from our `team_membership.team_role`; ending the lead spell removes it |
| S2-06 | Active org | **PASS** | Active org is held in the session. Switching A → B changes the `withTenant` context; B sees only B leads. A non-member cannot activate an org; a **forged** `active_org_id` → `NOT_A_MEMBER` (membership re-checked each request). Removal takes effect on the next request |
| S2-07 | Tables under RLS | **PASS — decision needed (§3.1)** | Every table is ENABLE+FORCE RLS, including auth tables. Plugin org-owned tables (`organization_membership`, `invitation`) carry `org_id` and a `crm_app` tenant policy. `crm_app` has **no** privileges on `session`, `account`, `verification` or `two_factor`, and cannot insert memberships or invitations. `crm_auth` has **no** privileges on business tables. Without context, `crm_app` sees 0 memberships/invitations |
| S2-08 | Platform admin | **PASS** | Platform user (`platform_role`, no membership) cannot activate a customer org; forged active org → denied. An unapproved grant → denied. **Only the Owner approves** (Admin → `Forbidden`). An approved READ grant → read access to that org only, enforced as a **database read-only transaction** (write → "read-only transaction"). Audited in the org log (`approved`, `used`) and the platform log (`used`). Another org → denied. Expired or revoked → denied. Grants longer than 72 h are rejected by a CHECK |

## 3. Design decisions that need review

### 3.1 `crm_auth`: a dedicated database role for the authentication library (S2-07)

**Problem.** Better Auth must read and write memberships and invitations *before* any org context exists, and across orgs. Examples are "which orgs is this user in?", "accept this invitation" and "list members for the org admin". If it ran as `crm_app`, RLS would hide those rows (correctly) and the plugin would not work.

**Options:**

| Option | Isolation property | Cost |
|---|---|---|
| **A. `crm_auth` role (implemented)** | Business code (`crm_app`) keeps strict per-org RLS on memberships/invitations and has no access at all to credentials/sessions. The auth library's role can read all orgs' memberships/invitations and all auth tables, but **no business tables** (leads, teams, audit, grants). The lint rule allows the library only in `src/platform/auth` | One more DB role and connection pool. Better Auth's cross-org access is trusted library code, with checks proven by S2-02–S2-06 |
| B. ADR-0003 fallback: Better Auth core only, our own membership/invitation tables | Memberships/invitations only reachable through `crm_app` + definer functions (as in S1) | We re-implement what S2 shows the plugin already does correctly: active org, invitations, owner invariants, role checks. Estimated +3–5 days, plus our own security tests |
| C. Run Better Auth as `crm_app` with relaxed policies | **Rejected:** weakens RLS for all business code | — |

**Recommendation: A.** It keeps the tenant boundary intact for all business code, and confines the library's broader access to its own tables. Under option A, ADR-0003 and ADR-0004 must record `crm_auth`; this is done (status: proposed, pending your decision). Staging must create the role, as part of S1-18.

### 3.2 Invitation link carries the invitation id

The domain model says invitation tokens are stored hashed. The plugin instead uses the invitation **id** as the link token. Mitigations proven in S2-04:
- the ids are UUIDv7 (74 random bits);
- acceptance requires a signed-in user whose **verified** email matches;
- expiry is 7 days;
- `cancelPendingInvitationsOnReInvite` is on.

The residual risk is that someone with database read access sees ids in plain text, but they would still need the invitee's mailbox. **Recommendation:** accept for the pilot, and record the change in domain-model.md.

### 3.3 Smaller deviations recorded

- **Membership role is a single text code** with a CHECK, not `role_id` → `Role` table. `RolePermission` will key on `(org_id, role_code)`. Custom roles are Phase 7 (FR scope unchanged).
- **The owner-only check for Admins lives in a request-level `before` hook**, because the plugin's `organizationHooks` do not receive the acting user. It depends on Better Auth endpoint paths (`/organization/update-member-role`, `/invite-member`, `/remove-member`). Tests catch path changes on upgrade.
- **Team membership on invitation acceptance is written by our code, in a separate transaction** (`afterAcceptInvitation`, as `crm_app`). If that write fails, the membership exists without the team. The Step 5 design should make this idempotent or retryable.
- **Password minimum length is set to 12.** Confirm against NFR-046 in Step 5.

## 4. Known limitations

1. **Emails are captured in memory**, not sent. Mailpit and the email adapter come with the worker and outbox in Step 5.
2. **Tests call `auth.api` directly**, without the Next.js handler. Cookie flags (`Secure`/`HttpOnly`/`SameSite`), CSRF/origin checks and **rate limiting** (NFR-046) apply at the HTTP handler and are not yet tested.
3. **Not exercised:** 2FA *enforcement* for Owner/Admin (a security-policy feature), backup-code use, and 2FA lockout.
4. **Better Auth logs its own warnings** ("Invalid password", "User not found") to the console. These must be routed to pino with PII redaction.
5. **Connection budget.** Two runtime pools (`crm_app` + `crm_auth`), plus the worker, on a single small managed node (connection limits are low) make PgBouncer, already planned, necessary.
6. **Better Auth 1.7.11 is 0 days old.** It is pinned under an explicit `minimumReleaseAge` exception because it is the version ADR-0003 was reviewed against. 1.8 is in beta.

## 5. Next permitted step

See the [gate review](../../PHASE-1-GATE-REVIEW.md). Step 5 may start only after S1 and S2 are accepted.
