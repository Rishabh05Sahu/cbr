// POST /api/v1/imports/:id/sheet — read another worksheet of the workbook (chooseSheet; the
// mapping starts again from suggestions). Body: { sheet, version }. Only these fields are read.
import { chooseSheet } from '@/modules/imports';
import { apiRoute, readJson } from '@/platform/http/api-route';

export const dynamic = 'force-dynamic';

export const POST = apiRoute<{ id: string }>('import-sheet', async ({ req, ctx, params }) => {
  const body = await readJson(req);
  await chooseSheet(ctx, params.id, { sheet: body.sheet, version: body.version });
  return { saved: true };
});
