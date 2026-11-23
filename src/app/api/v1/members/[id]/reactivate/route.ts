// POST /api/v1/members/:id/reactivate — reactivate a suspended member.
import { reactivateMember } from '@/modules/members';
import { apiRoute } from '@/platform/http/api-route';

export const dynamic = 'force-dynamic';

export const POST = apiRoute<{ id: string }>('member-reactivate', async ({ ctx, params }) => {
  await reactivateMember(ctx, params.id);
  return { reactivated: true };
});
