// GET /api/v1/properties?q=&page=… — the property list with the web list's filters (FR-140).
// POST /api/v1/properties — add a property (Owner/Admin, property.manage), same fields as the web.
import { createProperty, listProperties } from '@/modules/properties';
import { apiRoute, queryOf, readJson } from '@/platform/http/api-route';

export const dynamic = 'force-dynamic';

export const GET = apiRoute('properties', ({ req, ctx }) => listProperties(ctx, queryOf(req)));

export const POST = apiRoute('property-create', async ({ req, ctx }) =>
  createProperty(ctx, await readJson(req)),
);
