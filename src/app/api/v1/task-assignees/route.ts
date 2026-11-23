// GET /api/v1/task-assignees?leadId= — who the caller may give a task to (themselves first), for
// the app's "Add task" sheet.
import { assigneeOptions } from '@/modules/tasks';
import { apiRoute, queryOf } from '@/platform/http/api-route';

export const dynamic = 'force-dynamic';

export const GET = apiRoute('task-assignees', async ({ req, ctx }) => ({
  people: await assigneeOptions(ctx, queryOf(req).leadId || null),
}));
