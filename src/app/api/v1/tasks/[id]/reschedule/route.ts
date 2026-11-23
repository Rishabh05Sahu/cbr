// POST /api/v1/tasks/:id/reschedule — move one of the caller's tasks from My Day (FR-102), the same
// command as the website: a new org-local time (YYYY-MM-DDTHH:mm), a reason when it is overdue or
// was rescheduled more than twice, and the expected version. Body: { dueAt, reason?, version }.
import { rescheduleFollowUp } from '@/modules/tasks';
import { apiRoute, readJson } from '@/platform/http/api-route';

export const dynamic = 'force-dynamic';

export const POST = apiRoute<{ id: string }>('task-reschedule', async ({ req, ctx, params }) => {
  const body = await readJson(req);
  const s = (v: unknown) => (v === undefined || v === null ? '' : String(v));
  return rescheduleFollowUp(ctx, params.id, {
    dueAt: s(body.dueAt),
    reason: s(body.reason),
    version: s(body.version),
  });
});
