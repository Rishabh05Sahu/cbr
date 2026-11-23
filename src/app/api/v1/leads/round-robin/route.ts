// POST /api/v1/leads/round-robin — FR-073 deal unassigned leads in turn to a team's members, the
// same command as the web queue. Body: { leadIds: string[], teamId }.
import { roundRobinAssign } from '@/modules/leads';
import { apiRoute, readJson } from '@/platform/http/api-route';

export const dynamic = 'force-dynamic';

export const POST = apiRoute('leads-round-robin', async ({ req, ctx }) => {
  const body = await readJson(req);
  return roundRobinAssign(ctx, { leadIds: body.leadIds, teamId: body.teamId });
});
