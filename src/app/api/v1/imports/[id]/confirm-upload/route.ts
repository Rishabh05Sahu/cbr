// POST /api/v1/imports/:id/confirm-upload — after the app's PUT to storage, the server checks the
// stored object (size and type) and hands the file to the worker (confirmUpload). No body.
import { confirmUpload } from '@/modules/imports';
import { apiRoute } from '@/platform/http/api-route';

export const dynamic = 'force-dynamic';

export const POST = apiRoute<{ id: string }>('import-confirm-upload', ({ ctx, params }) =>
  confirmUpload(ctx, params.id),
);
