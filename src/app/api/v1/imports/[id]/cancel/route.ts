// POST /api/v1/imports/:id/cancel — cancel an unfinished import (cancelImport: any Owner or
// Admin; leads already imported stay). No body.
import { cancelImport } from '@/modules/imports';
import { apiRoute } from '@/platform/http/api-route';

export const dynamic = 'force-dynamic';

export const POST = apiRoute<{ id: string }>('import-cancel', async ({ ctx, params }) => {
  await cancelImport(ctx, params.id);
  return { cancelled: true };
});
