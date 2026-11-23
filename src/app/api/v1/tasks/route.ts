// POST /api/v1/tasks — add a follow-up or task, for a lead (leadId) or on its own, the same
// command as the web (FR-103). Body: { leadId?, type, title, dueAt (org-local
// "YYYY-MM-DDTHH:mm"), priority?, assigneeUserId? }.
import { createTask } from '@/modules/tasks';
import { apiRoute, readJson } from '@/platform/http/api-route';

export const dynamic = 'force-dynamic';

export const POST = apiRoute('task-create', async ({ req, ctx }) => {
  const body = await readJson(req);
  const leadId = typeof body.leadId === 'string' && body.leadId ? body.leadId : null;
  return createTask(ctx, leadId, body);
});
