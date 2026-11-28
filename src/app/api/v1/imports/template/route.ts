// GET /api/v1/imports/template — the lead import template for the app's Import leads screen
// (owner request 2026-11-28), Owners and Admins (lead.import + lead.create). The same file as the
// website's "Download template (CSV)" (/app/leads/import/template.csv): headings that map
// themselves, including this organisation's active custom fields. JSON so the app can show the
// columns and save the file: { fileName, csv, columns: [{ heading, required, hint }] }.
import { importTemplate } from '@/modules/imports';
import { apiRoute } from '@/platform/http/api-route';

export const dynamic = 'force-dynamic';

export const GET = apiRoute('import-template', async ({ ctx }) => importTemplate(ctx));
