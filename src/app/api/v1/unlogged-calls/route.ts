// GET /api/v1/unlogged-calls — My Day's "calls with no outcome": the caller's taps on Call or
// WhatsApp in the last day with nothing logged since, one per lead (FR-082 in the app).
import { unloggedCalls } from '@/modules/interactions';
import { can } from '@/platform/authz';
import { apiRoute } from '@/platform/http/api-route';

export const dynamic = 'force-dynamic';

export const GET = apiRoute('unlogged-calls', async ({ ctx }) => ({
  rows: can(ctx, 'interaction.create') ? await unloggedCalls(ctx) : [],
}));
