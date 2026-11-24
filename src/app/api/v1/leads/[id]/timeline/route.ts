// GET /api/v1/leads/:id/timeline — the lead's activity timeline (lead.view_activity_timeline).
// Each entry also carries `line` ({ kind, text, detail }): the website's wording as plain text, so
// the app shows the same history as the lead page (owner request 2026-11-24).
import { getTimeline } from '@/modules/leads';
import { apiRoute } from '@/platform/http/api-route';
import { timelineLine } from './text';

export const dynamic = 'force-dynamic';

export const GET = apiRoute<{ id: string }>('lead-timeline', async ({ ctx, params }) =>
  (await getTimeline(ctx, params.id)).map((t) => ({ ...t, line: timelineLine(t) })),
);
