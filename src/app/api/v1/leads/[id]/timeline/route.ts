// GET /api/v1/leads/:id/timeline — the lead's activity timeline (lead.view_activity_timeline).
import { getTimeline } from '@/modules/leads';
import { apiRoute } from '@/platform/http/api-route';

export const dynamic = 'force-dynamic';

export const GET = apiRoute<{ id: string }>('lead-timeline', ({ ctx, params }) =>
  getTimeline(ctx, params.id),
);
