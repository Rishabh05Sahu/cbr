# ADR-0027: Android app (Flutter) on the same backend

- **Status:** Accepted on 2026-11-21. The owner approved the app design (21 screens, by role) and chose Flutter. Slice 1 (this API) is implemented; the Flutter app follows in `mobile/`.
- **Date:** 2026-11-21
- **Amends:** assumption A-01 and vision §5.3 ("no native apps"); system-architecture §3.1 ("no parallel REST API"), for the app only.
- **Keeps:** ADR-0003 (Better Auth, sessions in the database), ADR-0004 (permissions, RLS), ADR-0006 (no call-log reading), ADR-0013 (phone masking), ADR-0025 (call intents).

## Context
Sales executives make 60–120 calls a day from Android phones and want a Play Store app. The website uses Server Actions with cookie sessions, so it has no API a native app can call. A-01 already said that a native app means "a mobile API surface (Route Handlers), not a redesign".

## Decisions

| # | Decision | Why |
|---|---|---|
| 1 | **Flutter app** in `mobile/` in this repository. Android app ID `com.crystalbricks.crm`. Android first; iOS is not planned. | Owner's choice. Keeping it in this repository means an API change and the app change that uses it ship together. |
| 2 | **Same database and business logic.** `/api/v1/*` route handlers are thin: they resolve the caller with `resolveRequestContext` (the same as pages and actions) and call the existing `src/modules/*` functions. No business rule is duplicated in the app or in the routes. | One set of rules and one set of RLS policies for both clients. |
| 3 | **Bearer tokens via the Better Auth `bearer` plugin, signed tokens only** (`requireSignature`). The app signs in through the normal `/api/auth/*` endpoints with `Origin: cbrcrm://app` (a trusted origin), and gets the token from the `set-auth-token` response header. The token is the signed session token, so revocation, the 7-day expiry, sign-out and "end other sessions" all work unchanged. | No second session system. The 2FA hooks and rate limits apply as they are. |
| 4 | **The token header goes only to the app.** `route-handler.ts` removes `set-auth-token` from every `/api/auth` response unless the request's Origin is `cbrcrm://app`. A browser cannot send that Origin. | On the website the session stays in an httpOnly cookie, out of reach of page scripts. |
| 5 | **`/api/v1` accepts the bearer token only.** Requests without `Authorization: Bearer` are refused with 401, and cookies are never passed to the auth layer. | A browser's ambient cookie can never act through `/api/v1`, so there is no CSRF surface and no origin check is needed. |
| 6 | **Same 2FA rule.** The app does the TOTP step (`/two-factor/verify-totp`, carrying only the short-lived two-factor cookie). Owners and Admins without an authenticator get `TWO_FACTOR_REQUIRED` and are sent to the website to enrol. Enrolment, recovery codes and security settings stay on the website. | Item D unchanged, and the security-sensitive setup screens are not duplicated. |
| 7 | **Response format** is the same `{ ok, data | error: { code, message, fieldErrors? } }` envelope as Server Actions (`runAction`), with HTTP status by code: 401 UNAUTHENTICATED, 403 FORBIDDEN / TWO_FACTOR_REQUIRED / NO_ORG_ACCESS, 404 NOT_FOUND, 409 CONFLICT, 422 VALIDATION_FAILED / RULE_VIOLATION, 429 RATE_LIMITED, 503 UNAVAILABLE. Every response is `private, no-store`. | The app shows the same messages as the website. |
| 8 | **Platform support grants are web-only.** A support context is refused on `/api/v1`. | The support console and its audit trail live on the website. |
| 9 | **Lead text search spends the organisation's search budget** in the route (the proxy does not run for `/api`), and fails closed exactly as on the website. | M6 P-E applies to every client. |
| 10 | **Calls:** the app records a call intent, opens `tel:` / `wa.me`, and offers the outcome sheet when it returns to the foreground (FR-082). It never reads the call log (ADR-0006; also Play policy). | Same evidence levels as the website. |

## Slice 1 endpoints (this change)
`GET /me` (user, memberships, active org with role, time zone and permission scopes; works before an organisation is chosen) · `GET /my-day` · `GET /leads` (FR-056 parameters) · `GET /leads/:id` (lead, tasks, visits, top 3 scripts, pending tap) · `GET /leads/:id/timeline` · `POST /leads/:id/reveal-phone` · `POST /leads/:id/call-intents` · `GET /interactions/defaults` · `POST /interactions` · `POST /tasks/:id/complete`.
Organisation switch and sign-out use Better Auth's own `/api/auth/organization/set-active` and `/api/auth/sign-out` with the bearer token.

## Slice 3 endpoints (assignment, 2026-11-23)
`GET /assignment-targets` · `POST /leads/:id/assign` · `POST /leads/assign` (bulk, ≤ 100) · `POST /leads/round-robin`; the unassigned queue is `GET /leads?owner=none&sort=oldest`. They call the same commands as the website (`assignLead`, `bulkAssign`, `roundRobinAssign`), so scope (Sales Manager: the teams they lead), the reassign reason, version checks, history, audit and notifications are unchanged. App 1.0.1: Assign/Reassign on the lead screen, the Unassigned queue, and a Team tab.

## Slice 4 endpoints (in-app notifications, 2026-11-23)
`GET /notifications?cursor=` (30 a page, with `unread`) · `POST /notifications/:id/read` · `POST /notifications/read-all`. They call the website's notification module (FR-118), so a member only ever reads and marks their own rows; another member's or another organisation's notification is 404. In the app:
- a bell with an unread badge on My Day and Leads, an Inbox tab for Owner, Admin and HR, and a badge on More for everyone else;
- tapping a notification marks it read and opens the lead in the app (other links open the website);
- while the app is open it re-reads the count every minute and on resume, and shows "You have a new notification".

Phone notifications while the app is closed (FCM push) are not built. They need a Firebase project (`google-services.json` in the app, a service-account key on the server) and a `push_devices` migration.

## Later slices
Visits and visit outcomes, calendar, properties with camera photos (the photo upload route needs a bearer variant without the same-origin check), FCM push, people and invitations, and support-access approval.

## Risks and limitations
- A stolen token works until it expires (7 days) or the session is ended. The app keeps it in Android encrypted storage (Keystore) and signs out on the server when the user signs out.
- The time zone defaults to `Asia/Kolkata` while users are in Dubai. Set the organisation to `Asia/Dubai` before the app is used for due times.
- A Google Play account (an organisation account is recommended), a privacy policy, the Data Safety form and an account-deletion link are needed before release.

## Tests
e2e `tests/e2e/mobile-api.test.ts`, against the built server:
- token sign-in, including the owner's 2FA step;
- the token is never sent to the website;
- no token, a forged token, an unsigned token and a website cookie are all refused;
- private headers on every response;
- executive OWN scope, owner ORG scope, HR without lead access, another organisation's lead is 404, and switching into a foreign organisation is refused;
- the call → outcome loop;
- assignment (slice 3), and notifications only for their recipient (slice 4).
