// GET /api/v1/lead-sources — the organisation's lead sources, for the app's "New lead" form.
import { listLeadSources } from '@/modules/leads';
import { apiRoute } from '@/platform/http/api-route';

export const dynamic = 'force-dynamic';

export const GET = apiRoute('lead-sources', async ({ ctx }) => ({
  sources: await listLeadSources(ctx),
}));
