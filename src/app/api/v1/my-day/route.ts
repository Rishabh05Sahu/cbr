// GET /api/v1/my-day — FR-101 My Day for the caller (the same data as /app/my-day).
import { myDay } from '@/modules/tasks';
import { apiRoute } from '@/platform/http/api-route';

export const dynamic = 'force-dynamic';

export const GET = apiRoute('my-day', ({ ctx }) => myDay(ctx));
