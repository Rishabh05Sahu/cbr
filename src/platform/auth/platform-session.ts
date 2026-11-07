// Platform staff have no memberships, so Better Auth's set-active endpoint refuses them.
// The console records the org they are supporting on their own session row; the request
// context still requires an approved, unexpired support grant for that org.
import { forbidden } from '@/platform/errors';
import { authPrisma } from '@/platform/db/client';
import { auth } from './auth';

export async function setSupportOrganization(
  headers: Headers,
  platformUserId: string,
  orgId: string | null,
) {
  const session = await auth().api.getSession({ headers });
  const user = session?.user as { id: string; platformRole?: string | null } | undefined;
  if (!session || !user || user.id !== platformUserId || user.platformRole !== 'PLATFORM_ADMIN')
    throw forbidden();
  await authPrisma().session.update({
    where: { id: session.session.id },
    data: { activeOrganizationId: orgId },
  });
}
