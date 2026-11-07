# ADR-0003: Authentication with Better Auth (self-hosted), authorisation in our own model

- **Status:** **Accepted** (2026-10-20). Spike S2 passed 8/8 with the organization plugin. The owner approved D2 (`crm_auth` role) and D3 (invitation ids, with controls) on 2026-10-19. Implemented in Phase 1; implementation refinements in [ADR-0008](ADR-0008-phase-1-implementation-decisions.md).
- **Date:** 2026-10-19

## Context
We need email/password login, password reset, invitations, revocable sessions, optional TOTP 2FA, multiple orgs per user, and data residency in India. Authorisation needs scopes (own/team/org) that generic RBAC plugins don't model.

## Decision
- Use **Better Auth** (1.7.x stable) for **authentication**: credentials, sessions (DB-backed, revocable), email verification, password reset, the **2FA plugin** (TOTP + backup codes) and the **Prisma adapter**. User data lives in our own PostgreSQL in India.
- Evaluate its **organization plugin** in the spike for orgs/members/invitations/active-org-in-session. If adopted, we store our system role code in the member role and **keep permissions, scopes and teams in our own `identity-access` and `organizations` modules**. If the plugin's model conflicts (e.g. team semantics), we use our own membership/invitation tables and keep only the core auth from Better Auth.
- **Organisation plugin fit (re-verified 2026-10-19 against Better Auth 1.7.11 docs/source):**
  | Our need | Plugin behaviour | Consequence |
  |---|---|---|
  | Roles OWNER, ADMIN, SALES_MANAGER, SALES_EXECUTIVE, HR_OPS | Custom roles via `createAccessControl`; built-in `owner`/`admin` semantics (creator becomes owner; last owner cannot leave; owner-only org deletion by default) | Fits. Map OWNER/ADMIN onto built-in `owner`/`admin` |
  | Exactly one role per membership | Members **may hold multiple comma-separated roles** | Enforce a single role in `beforeAddMember`/`beforeUpdateMemberRole` hooks plus a DB CHECK/test |
  | Own/team/org record scopes | Org-wide RBAC only, no record scope | Scope logic stays in our `authz` module (as planned) |
  | Team leads | Teams supported, but `teamMember` has **no role column** | Keep our own `TeamMembership.team_role`. Do not rely on plugin teams for scope (use plugin teams = disabled, or mirror only) |
  | 7-day invitations | Default 48 h (`invitationExpiresIn`) | Configure 7 days |
  | Orgs up to 500 users | `membershipLimit` default 100 | Raise the limit |
  | Server-side checks only | Client `checkRolePermission` ignores dynamic roles | Never use client checks for authorisation |
  These are confirmed in docs but **not yet exercised**, so Spike S2 (PHASE-0-FINAL-REVIEW §7) must validate them.
- Session → `RequestContext` resolution happens in `src/platform/auth`. Modules never call the auth library directly (enforced by an ESLint `no-restricted-imports` rule since Phase 1 Step 1).
- **Approved (D2, 2026-10-19):** Better Auth connects as a dedicated database role `crm_auth` with RLS policies on its own tables only (auth tables plus `organization`, `organization_membership`, `invitation`). Business code (`crm_app`) keeps strict per-org RLS on memberships/invitations and has no access to credential or session tables. Rationale and alternatives: [S2 report §3.1](../spikes/S2-report.md).
- **S2 configuration findings:**
  - The "Admin cannot add/remove/change Owners or Admins" rule needs a request-level `before` hook, because the plugin's `organizationHooks` do not receive the acting user.
  - A single role is enforced three ways: the plugin hooks, that request guard, and a database CHECK.
  - Telemetry is explicitly disabled.
  - `requireEmailVerificationOnInvitation` is on, because ids are app-generated UUIDv7.

## Alternatives considered
| Alternative | Pros | Cons |
|---|---|---|
| Auth.js / NextAuth v5 | Familiar | v5 still beta (5.0.0-beta.32); project now maintained by the Better Auth team, who recommend Better Auth for new projects |
| Clerk (managed) | Fast, polished orgs/invites UI, managed security | Identity data hosted in the US with no region selection; per-MAU cost; vendor lock-in for a core table |
| Custom (Lucia-style) | Full control | We'd own password reset, 2FA, session security: high-risk code to write |
| Supabase Auth / Cognito | Managed | Couples us to a platform; Cognito UX/customisation effort |

## Consequences
- (+) Data stays in our DB and region. Open source. Active releases. Official successor path for Auth.js.
- (−) We operate auth ourselves (email deliverability, rate limiting, monitoring). Better Auth joined Vercel in Jul 2026, so watch for roadmap/licensing changes (remains OSS per announcement).
- Security: enforce Secure/HttpOnly cookies, session rotation, instant revocation on deactivation, rate limits (NFR-046), 2FA enforceable for Owner/Admin.

## Reconsider when
Enterprise SSO (SAML/OIDC per tenant) becomes a requirement and the library's support is inadequate; a security issue in the library is not addressed promptly.

## References
- Better Auth Auth.js announcement: https://www.better-auth.com/blog/authjs-joins-better-auth · Organization plugin: https://www.better-auth.com/docs/plugins/organization · 2FA: https://www.better-auth.com/docs/plugins/2fa · Prisma adapter: https://www.better-auth.com/docs/adapters/prisma · Joins Vercel: https://better-auth.com/blog/better-auth-joins-vercel
- Clerk security/data location: https://clerk.com/security
- Next.js authentication & data security guide: https://nextjs.org/docs/app/guides/data-security
