// GET /api/v1/scripts — the organisation's published call scripts with their live text, for the
// app's script library. The lead screen already suggests the best matches for a lead.
import { listPublishedScripts } from '@/modules/scripts';
import { apiRoute } from '@/platform/http/api-route';

export const dynamic = 'force-dynamic';

export const GET = apiRoute('scripts', async ({ ctx }) => ({
  scripts: await listPublishedScripts(ctx),
}));
