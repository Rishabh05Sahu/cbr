// POST /api/v1/notifications/:id/read — mark one of the caller's notifications read. Another
// member's notification is 404, like a missing one.
import { markRead, unreadCount } from '@/modules/notifications';
import { apiRoute } from '@/platform/http/api-route';

export const dynamic = 'force-dynamic';

export const POST = apiRoute<{ id: string }>('notification-read', async ({ ctx, params }) => {
  await markRead(ctx, params.id);
  return { unread: await unreadCount(ctx) };
});
