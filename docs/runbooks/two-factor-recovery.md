# Runbook: Two-Step Verification (2FA) Recovery

> **Applies from:** 2026-10-20 (owner decision item D). 2FA with an authenticator app is **mandatory** for Company Owners, Company Admins and CBR platform staff. Other roles may turn it on voluntarily.
> **Principle:** no recovery path may let someone who only knows the password, or only controls the email inbox, get past the second factor without an identity check.

## 1. Self-service paths (no CBR involvement)

| Situation | What the user does | Controls |
|---|---|---|
| **New phone, old phone still works** | *My profile → Replace authenticator*: password + current 6-digit code. Then set up the new phone at once | Password + second factor; rate-limited (5 per 15 min per user); audited (`user.authenticator_reset`); email alert |
| **Phone lost, recovery codes available** | Sign in with password → *Lost your phone? Use a recovery code*. Then *Replace authenticator* with password + another recovery code, and set up the new phone | Each code works **once**. Codes are stored only as keyed hashes. 5 attempts per sign-in challenge; account locked for 15 min after 10 failures. Every use is audited (`user.recovery_code_used`, codes left) and emailed |
| **Few recovery codes left** | *My profile → Generate new recovery codes* (password). All old codes stop working | Audited (`user.recovery_codes_regenerated`); email alert |

Owners, Admins and platform staff **cannot turn 2FA off** (HTTP 403 `TWO_FACTOR_REQUIRED_FOR_ROLE`). They can only replace the authenticator.

## 2. Platform-assisted reset (phone **and** recovery codes lost)

This is the only path without a second factor, so it requires identity verification by a person. **Never** perform it on the strength of an email, chat message or phone call alone.

### 2.1 Identity checks (all required; record them in the support ticket)

1. **The request comes from the user's registered email address.** CBR replies to that address; the reply alone is not enough.
2. **Live video call.** The user shows a government photo ID. The name must match the account. Do **not** copy or store the ID number or image; record only "ID sighted, type, last 4 characters".
3. **Corroboration by the organisation:**
   - **For an Admin:** an **Owner** of the same organisation confirms the request in writing from their own account email.
   - **For an Owner:** where the organisation has another Owner, that Owner confirms. If the requester is the only Owner, a second CBR platform administrator joins the video call and confirms the checks. The confirmation call goes to the brokerage's registered business phone number (from the contract), not a number the requester supplies.
   - **For platform staff:** another platform administrator performs the reset (self-reset is blocked in code), after the same video check.
4. **Cooling-off for Owners:** wait **24 hours** after the request before resetting, and email the registered address that a reset is pending. This gives a legitimate user time to object if the request is fraudulent. Skip only if the organisation's other Owner confirms by video.

### 2.2 Performing the reset

*Platform console → Reset two-step verification*: user email, reason, ticket reference.

What it does (`platformResetTwoFactor`, audited in the platform log and in every organisation where the user is an active member as `user.two_factor_reset_by_platform`):
1. Deletes the authenticator and all recovery codes.
2. **Ends every session.**
3. **Replaces the password with an unusable one.** The old password stops working, so an attacker who has only the password gets nothing.
4. Emails a **password-reset link** (30 minutes, single use) and a security alert to the registered address.

The user must then:
- choose a new password via the emailed link, which proves control of the inbox;
- sign in;
- enrol a new authenticator. The app is blocked until they do (`TWO_FACTOR_REQUIRED`).

The reset grants **no access** by itself.

### 2.3 After the reset

- Within 24 h, confirm with the user (by video or a call to the registered number) that they regained access.
- If the security alert email is answered with "this wasn't me":
  - suspend the user's memberships (Owner/Admin, or the platform for an org-level incident);
  - revoke sessions;
  - follow the incident procedure (security-and-threat-model.md).

## 3. What CBR staff must never do

- Read out or recreate recovery codes. They are not stored in readable form and cannot be retrieved.
- Turn off 2FA for an Owner/Admin "temporarily", or bypass the cooling-off period on request.
- Accept identity evidence over chat or email.
- Ask for the user's password or a code.

## 4. Technical notes

- **Recovery codes:** 10 codes × 12 characters from a 31-symbol alphabet (≈ 59 bits each).
  - Stored as HMAC-SHA-256 under a key derived (HKDF) from `BETTER_AUTH_SECRET`.
  - Consumption is an atomic compare-and-swap on the stored list, so a code works once even under concurrent use (tested).
- **Rotating `BETTER_AUTH_SECRET`** invalidates all recovery codes **and** TOTP secrets (they are encrypted with it). Plan a re-enrolment campaign before any rotation.
- **Trusted devices** ("don't ask again on this device") are disabled for everyone. Every sign-in needs the second factor.
- **TOTP:** 30-second codes, ±1 step tolerance.
  - **Limitation:** the library does not block replay of the same code within its validity window. Mitigated by the per-challenge attempt limit, the per-IP rate limit and the requirement for the password first.
- **Sessions that predate enrolment** are ended when the authenticator is enrolled (tested), so a password-only session can never hold Owner/Admin access.
