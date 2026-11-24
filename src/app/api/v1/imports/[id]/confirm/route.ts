// POST /api/v1/imports/:id/confirm — start writing leads after the uploader's attestation
// (confirmImport, FR-170). Body: { attest: true, acknowledgeDuplicateFile?, version }. Only these
// fields are read.
import { confirmImport } from '@/modules/imports';
import { apiRoute, readJson } from '@/platform/http/api-route';

export const dynamic = 'force-dynamic';

export const POST = apiRoute<{ id: string }>('import-confirm', async ({ req, ctx, params }) => {
  const body = await readJson(req);
  await confirmImport(ctx, params.id, {
    attest: body.attest,
    acknowledgeDuplicateFile: body.acknowledgeDuplicateFile,
    version: body.version,
  });
  return { started: true };
});
