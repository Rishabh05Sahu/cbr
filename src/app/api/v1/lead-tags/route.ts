// GET /api/v1/lead-tags — the organisation's lead tags (for the app's tag filter and "add tag").
import { listLeadTags } from '@/modules/leads';
import { apiRoute } from '@/platform/http/api-route';

export const dynamic = 'force-dynamic';

export const GET = apiRoute('lead-tags', ({ ctx }) => listLeadTags(ctx));
