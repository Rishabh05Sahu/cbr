// POST /api/v1/invitations/:id/cancel — cancel a pending invitation.
import { cancelInvitation } from '@/modules/members';
import { apiRoute, bearerHeaders } from '@/platform/http/api-route';

export const dynamic = 'force-dynamic';

export const POST = apiRoute<{ id: string }>('invitation-cancel', async ({ req, ctx, params }) => {
  await cancelInvitation(ctx, bearerHeaders(req)!, params.id);
  return { cancelled: true };
});
