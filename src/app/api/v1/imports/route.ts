// GET /api/v1/imports — the app's Import leads screen (FR-040–FR-052), Owners and Admins: recent
// imports, the upload size limit and whether file storage is configured.
// POST /api/v1/imports — start an import, the same command as the website's upload form
// (startImport: lead.import + lead.create, the declared-file checks, the pending-upload limit).
// Body: { fileName, size, type }. Only these fields are read. Answers { importId, upload: { url,
// method: 'PUT', headers }, expiresAt }: a signed permission for ONE object that the app PUTs the
// file to directly (never with the bearer token), then POST /imports/:id/confirm-upload.
import { importReadiness, listImports, requireImporter, startImport } from '@/modules/imports';
import { apiRoute, readJson } from '@/platform/http/api-route';

export const dynamic = 'force-dynamic';

export const GET = apiRoute('imports', async ({ ctx }) => {
  requireImporter(ctx);
  const r = importReadiness(ctx);
  return {
    imports: await listImports(ctx),
    maxBytes: r.limits.maxBytes,
    maxRows: r.limits.maxRows,
    storageConfigured: r.storageConfigured,
  };
});

export const POST = apiRoute('import-start', async ({ req, ctx }) => {
  const body = await readJson(req);
  return startImport(ctx, { fileName: body.fileName, size: body.size, type: body.type });
});
