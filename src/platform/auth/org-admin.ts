// Thin facade over Better Auth's organisation API for module code (modules never import the
// library). Each call forwards the caller's request headers, so the library applies its own
// membership/role checks and our owner-only guard on top of our authorize() checks.
import { uuidv7 } from '@/lib/uuidv7';
import { authPrisma } from '@/platform/db/client';
import { DomainError } from '@/platform/errors';
import { auth } from './auth';
import { assertSingleKnownRole, type PluginRole } from './roles';

interface ApiErrorLike {
  status: string;
  message: string;
  body?: { code?: string };
}

/** Structural check: the library's APIError class can come from more than one module copy. */
function isApiError(e: unknown): e is ApiErrorLike {
  return (
    e instanceof Error &&
    e.name === 'APIError' &&
    typeof (e as { status?: unknown }).status === 'string'
  );
}

function toDomain(e: unknown): never {
  if (isApiError(e)) {
    const code = e.body?.code ?? '';
    const message = e.message || 'Request failed';
    if (e.status === 'FORBIDDEN' || e.status === 'UNAUTHORIZED')
      throw new DomainError('FORBIDDEN', message);
    if (e.status === 'NOT_FOUND' || /NOT_FOUND/.test(code))
      throw new DomainError('NOT_FOUND', message);
    if (e.status === 'TOO_MANY_REQUESTS') throw new DomainError('RATE_LIMITED', message);
    throw new DomainError('RULE_VIOLATION', message);
  }
  throw e;
}

async function call<T>(fn: () => Promise<T>): Promise<T> {
  try {
    return await fn();
  } catch (e) {
    return toDomain(e);
  }
}

export function inviteMember(
  headers: Headers,
  input: { orgId: string; email: string; role: PluginRole; teamId?: string | null },
) {
  assertSingleKnownRole(input.role);
  return call(() =>
    auth().api.createInvitation({
      headers,
      body: {
        organizationId: input.orgId,
        email: input.email,
        role: input.role,
        resend: true,
        ...(input.teamId ? { teamId: input.teamId } : {}),
      } as { organizationId: string; email: string; role: PluginRole; resend: boolean },
    }),
  );
}

export function cancelInvitation(headers: Headers, invitationId: string) {
  return call(() => auth().api.cancelInvitation({ headers, body: { invitationId } }));
}

export function updateMemberRole(
  headers: Headers,
  input: { orgId: string; memberId: string; role: PluginRole },
) {
  assertSingleKnownRole(input.role);
  return call(() =>
    auth().api.updateMemberRole({
      headers,
      body: { organizationId: input.orgId, memberId: input.memberId, role: input.role },
    }),
  );
}

export function removeMember(headers: Headers, input: { orgId: string; memberId: string }) {
  return call(() =>
    auth().api.removeMember({
      headers,
      body: { organizationId: input.orgId, memberIdOrEmail: input.memberId },
    }),
  );
}

/** Recipient-only lookup (the library checks the signed-in user's email matches). */
export async function getInvitationForRecipient(headers: Headers, invitationId: string) {
  const inv = await call(() => auth().api.getInvitation({ headers, query: { id: invitationId } }));
  return {
    id: inv.id,
    organizationName: inv.organizationName,
    inviterEmail: inv.inviterEmail,
    role: inv.role as PluginRole,
    status: inv.status,
    expiresAt: inv.expiresAt,
  };
}

export function setActiveOrganization(headers: Headers, orgId: string) {
  return call(() => auth().api.setActiveOrganization({ headers, body: { organizationId: orgId } }));
}

/**
 * Server-only account creation with a password (seed/test tooling and platform bootstrap).
 * Not reachable from any HTTP route.
 */
export async function createUserWithPassword(input: {
  email: string;
  name: string;
  password: string;
  emailVerified: boolean;
}) {
  const ctx = await auth().$context;
  return createProvisionedUser({ ...input, passwordHash: await ctx.password.hash(input.password) });
}

/**
 * Server-side provisioning bypasses the public sign-up gate (validateUserInfo) on purpose:
 * it is reachable only from platform-console code. Writes via crm_auth, the library's role.
 */
async function createProvisionedUser(input: {
  email: string;
  name: string;
  emailVerified: boolean;
  passwordHash?: string;
}) {
  const db = authPrisma();
  return db.$transaction(async (tx) => {
    const user = await tx.user.create({
      data: {
        id: uuidv7(),
        email: input.email.toLowerCase(),
        name: input.name,
        emailVerified: input.emailVerified,
      },
    });
    if (input.passwordHash) {
      await tx.account.create({
        data: {
          id: uuidv7(),
          userId: user.id,
          providerId: 'credential',
          accountId: user.id,
          password: input.passwordHash,
        },
      });
    }
    return user;
  });
}

export async function revokeAllSessions(userId: string): Promise<void> {
  const ctx = await auth().$context;
  await ctx.internalAdapter.deleteUserSessions(userId);
}

/**
 * Platform console: create a customer organisation and its first Owner. If the owner has no
 * account yet, one is created with no usable password and a set-password email is sent.
 */
export async function provisionOrganization(input: {
  platformUserId: string;
  name: string;
  slug: string;
  ownerEmail: string;
  ownerName: string;
  appUrl: string;
}): Promise<{ orgId: string; ownerUserId: string; ownerCreated: boolean }> {
  const a = auth();
  const ctx = await a.$context;
  let owner = (await ctx.internalAdapter.findUserByEmail(input.ownerEmail))?.user ?? null;
  let ownerCreated = false;
  if (!owner) {
    owner = await createProvisionedUser({
      email: input.ownerEmail,
      name: input.ownerName,
      emailVerified: false,
    });
    ownerCreated = true;
  }
  const org = await call(() =>
    a.api.createOrganization({ body: { name: input.name, slug: input.slug, userId: owner.id } }),
  );
  if (!org) throw new DomainError('RULE_VIOLATION', 'Organisation was not created');
  if (ownerCreated) {
    // Proves mailbox ownership; the reset link sets the first password.
    await call(() =>
      a.api.requestPasswordReset({
        body: { email: input.ownerEmail, redirectTo: `${input.appUrl}/reset-password` },
      }),
    );
  }
  return { orgId: org.id, ownerUserId: owner.id, ownerCreated };
}
