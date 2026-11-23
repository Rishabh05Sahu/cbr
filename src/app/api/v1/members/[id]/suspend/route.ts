// POST /api/v1/members/:id/suspend — suspend a member (they can no longer sign in to this
// organisation; their leads stay with them until reassigned).
import { suspendMember } from '@/modules/members';
import { apiRoute } from '@/platform/http/api-route';

export const dynamic = 'force-dynamic';

export const POST = apiRoute<{ id: string }>('member-suspend', async ({ ctx, params }) => {
  await suspendMember(ctx, params.id);
  return { suspended: true };
});
