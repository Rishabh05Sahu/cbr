// POST /api/v1/leads/:id/tags — add one of the organisation's tags to this lead (owner request
// 2026-11-24), the website's "add tag" for a single lead: Owner/Admin (lead.bulk_update) with
// lead.update over the lead (bulkAddTag). Tags are not removed (as on the website). Body: { tagId }.
import { bulkAddTag } from '@/modules/leads';
import { apiRoute, readJson } from '@/platform/http/api-route';

export const dynamic = 'force-dynamic';

export const POST = apiRoute<{ id: string }>('lead-tag-add', async ({ req, ctx, params }) => {
  const body = await readJson(req);
  return bulkAddTag(ctx, { leadIds: [params.id], tagId: body.tagId });
});
