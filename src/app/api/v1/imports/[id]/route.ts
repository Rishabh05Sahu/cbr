// GET /api/v1/imports/:id — one import for the app (FR-040–FR-052), as the website's import page:
// the job (getImport: Owner/Admin), the first row problems once rows have been checked (row
// number, column heading and fixed message; never cell values), and, while the uploader can map
// columns, the fields, lead sources and assignment targets the mapping form offers.
import {
  ATTESTATION_TEXT,
  getImport,
  IMPORT_FIELDS,
  listImportIssues,
  TERMINAL_STATUSES,
} from '@/modules/imports';
import { assignmentTargets, listCustomFields, listLeadSources } from '@/modules/leads';
import { apiRoute } from '@/platform/http/api-route';

export const dynamic = 'force-dynamic';

const ISSUES_SHOWN = 20;

export const GET = apiRoute<{ id: string }>('import', async ({ ctx, params }) => {
  const job = await getImport(ctx, params.id);
  const showIssues =
    ['READY', 'IMPORTING', 'PAUSED'].includes(job.status) || TERMINAL_STATUSES.has(job.status);
  const issues = showIssues ? await listImportIssues(ctx, job.id, { limit: ISSUES_SHOWN }) : null;
  const canMap = job.isUploader && (job.status === 'NEEDS_MAPPING' || job.status === 'READY');
  const options = canMap
    ? {
        // Built-in fields, then the org's active custom fields (required ones must be mapped).
        fields: [
          ...IMPORT_FIELDS.map((f) => ({
            field: f.field as string,
            label: f.label,
            required: f.required,
            hint: f.hint ?? null,
          })),
          ...(await listCustomFields(ctx)).map((f) => ({
            field: `custom:${f.key}`,
            label: `${f.label} (custom)`,
            required: f.required,
            hint: null,
          })),
        ],
        sources: await listLeadSources(ctx),
        targets: await assignmentTargets(ctx),
      }
    : null;
  return {
    import: job,
    issues: issues && {
      total: issues.total,
      items: issues.issues.map((i) => ({
        row: i.row,
        column: i.column ?? i.fieldLabel,
        outcome: i.outcome,
        message: i.message,
        relatedRow: i.relatedRow,
      })),
    },
    options,
    attestationText: ATTESTATION_TEXT,
  };
});
