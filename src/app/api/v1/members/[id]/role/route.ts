// POST /api/v1/members/:id/role — change a member's role. Body: { role }. An Admin cannot act on
// an Owner or Admin, and the last Owner keeps the role (members module).
import { changeRole } from '@/modules/members';
import { apiRoute, bearerHeaders, readJson } from '@/platform/http/api-route';

export const dynamic = 'force-dynamic';

export const POST = apiRoute<{ id: string }>('member-role', async ({ req, ctx, params }) => {
  await changeRole(ctx, bearerHeaders(req)!, params.id, (await readJson(req)).role);
  return { changed: true };
});
