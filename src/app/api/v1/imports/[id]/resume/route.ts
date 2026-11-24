// POST /api/v1/imports/:id/resume — continue a paused import (resumeImport: the uploader only,
// with current Owner/Admin access). No body.
import { resumeImport } from '@/modules/imports';
import { apiRoute } from '@/platform/http/api-route';

export const dynamic = 'force-dynamic';

export const POST = apiRoute<{ id: string }>('import-resume', async ({ ctx, params }) => {
  await resumeImport(ctx, params.id);
  return { resumed: true };
});
