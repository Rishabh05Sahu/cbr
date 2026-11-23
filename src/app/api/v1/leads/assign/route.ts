// POST /api/v1/leads/assign — FR-063 bulk assign from the unassigned queue (up to 100 leads, all
// or nothing), the same command as the web queue. Body: { leadIds: string[], target, reason? }.
import { bulkAssign } from '@/modules/leads';
import { apiRoute, readJson } from '@/platform/http/api-route';

export const dynamic = 'force-dynamic';

export const POST = apiRoute('leads-bulk-assign', async ({ req, ctx }) => {
  const body = await readJson(req);
  return bulkAssign(ctx, {
    leadIds: body.leadIds,
    target: body.target,
    reason: typeof body.reason === 'string' ? body.reason : undefined,
  });
});
