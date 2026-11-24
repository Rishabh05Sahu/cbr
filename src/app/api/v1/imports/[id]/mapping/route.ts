// POST /api/v1/imports/:id/mapping — save the column mapping and options and check every row
// (submitMapping, as the website's "Check rows"). Body: { mapping: { field: columnIndex },
// defaultSourceId, duplicatePolicy: 'ATTACH' | 'SKIP', assignment: { mode, target?, teamId? },
// dryRun, version }. Only these fields are read.
import { submitMapping } from '@/modules/imports';
import { apiRoute, readJson } from '@/platform/http/api-route';

export const dynamic = 'force-dynamic';

const FIELDS = [
  'mapping',
  'defaultSourceId',
  'duplicatePolicy',
  'assignment',
  'dryRun',
  'version',
] as const;

export const POST = apiRoute<{ id: string }>('import-mapping', async ({ req, ctx, params }) => {
  const body = await readJson(req);
  await submitMapping(ctx, params.id, Object.fromEntries(FIELDS.map((k) => [k, body[k]])));
  return { saved: true };
});
