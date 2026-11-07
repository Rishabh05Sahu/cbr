'use client';
// Browser auth client: sign-in, sign-up (invitation holders), password reset, email
// verification, TOTP 2FA, active-org switch, invitation accept/reject. These go through
// /api/auth/*, where Better Auth applies rate limits and origin checks.
import { organizationClient, twoFactorClient } from 'better-auth/client/plugins';
import { createAuthClient } from 'better-auth/react';

export const authClient = createAuthClient({
  plugins: [
    organizationClient(),
    twoFactorClient({
      onTwoFactorRedirect() {
        window.location.assign(new URL('/login/two-factor', window.location.origin));
      },
    }),
  ],
});

/** Human-readable message from a Better Auth client error, without echoing input. */
export function authErrorMessage(
  error:
    | { status?: number | undefined; message?: string | undefined; code?: string | undefined }
    | null
    | undefined,
): string {
  if (!error) return 'Something went wrong. Please try again.';
  if (error.status === 429) return 'Too many attempts. Please wait a few minutes and try again.';
  return error.message || 'Something went wrong. Please try again.';
}
