// POST /api/v1/notifications/read-all — mark all of the caller's notifications read.
import { markAllRead } from '@/modules/notifications';
import { apiRoute } from '@/platform/http/api-route';

export const dynamic = 'force-dynamic';

export const POST = apiRoute('notifications-read-all', async ({ ctx }) => ({
  marked: await markAllRead(ctx),
  unread: 0,
}));
