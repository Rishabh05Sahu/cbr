// GET /api/v1/notifications — the caller's in-app notifications (FR-118), newest first, 30 a page
// (?cursor= from nextCursor), with the unread count for the app's badge. Only the recipient's own
// rows are ever read (RLS and the module's recipient filter).
import { listNotifications, unreadCount } from '@/modules/notifications';
import { apiRoute, queryOf } from '@/platform/http/api-route';

export const dynamic = 'force-dynamic';

export const GET = apiRoute('notifications', async ({ req, ctx }) => {
  const { rows, nextCursor } = await listNotifications(ctx, { cursor: queryOf(req).cursor });
  return { rows, nextCursor, unread: await unreadCount(ctx) };
});
