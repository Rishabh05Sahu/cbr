// POST /api/v1/tasks/:id/complete — complete one of the caller's tasks from My Day. Body:
// { version } (optimistic concurrency, as on the web).
import { completeFollowUp } from '@/modules/tasks';
import { apiRoute, readJson } from '@/platform/http/api-route';

export const dynamic = 'force-dynamic';

export const POST = apiRoute<{ id: string }>('task-complete', async ({ req, ctx, params }) => {
  const body = await readJson(req);
  return completeFollowUp(ctx, params.id, { version: String(body.version ?? '') });
});
