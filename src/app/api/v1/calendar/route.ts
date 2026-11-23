// GET /api/v1/calendar?view=day|week|month&date=YYYY-MM-DD — the caller's own calendar (FR-105),
// the same items as the web calendar.
import { calendar } from '@/modules/tasks';
import { apiRoute, queryOf } from '@/platform/http/api-route';

export const dynamic = 'force-dynamic';

export const GET = apiRoute('calendar', ({ req, ctx }) => {
  const q = queryOf(req);
  return calendar(ctx, { view: q.view, date: q.date });
});
