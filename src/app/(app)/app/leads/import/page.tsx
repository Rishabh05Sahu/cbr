import Link from 'next/link';
import { ActionFormButton } from '@/components/action-form-button';
import { Alert, Badge, Card, EmptyState, PageHeader } from '@/components/ui';
import {
  IMPORT_FIELDS,
  importReadiness,
  listImports,
  listMappingTemplates,
} from '@/modules/imports';
import { deleteMappingTemplateAction } from '@/modules/imports/actions';
import { pageContext, pageRequire } from '@/platform/auth/session';
import { fmtDateTime } from '../labels';
import { STATUS_LABELS, statusTone } from './status';
import { UploadForm } from './upload-form';

const mb = (bytes: number) => `${Math.round(bytes / (1024 * 1024))} MB`;

/**
 * Lead import (FR-040–FR-052), Owners and Admins: upload, then each import's own page walks
 * through sheet and column mapping, validation, confirmation, progress and results.
 */
export default async function ImportPage() {
  const { ctx } = await pageContext();
  pageRequire(ctx, 'lead.import');
  const r = importReadiness(ctx);
  const recent = await listImports(ctx);
  const templates = await listMappingTemplates(ctx);

  return (
    <>
      <PageHeader
        title="Import leads"
        description="Bring leads in from a portal or spreadsheet export (.xlsx or .csv)."
      />
      <div className="space-y-4">
        <Card title="New import">
          {!r.storageConfigured && (
            <div className="mb-4">
              <Alert tone="warn">
                File storage is not configured on this server, so files cannot be uploaded yet.
              </Alert>
            </div>
          )}
          <UploadForm maxBytes={r.limits.maxBytes} disabled={!r.storageConfigured} />
        </Card>

        <Card title="Recent imports">
          {recent.length === 0 ? (
            <EmptyState>No imports yet.</EmptyState>
          ) : (
            <div className="overflow-x-auto">
              <table className="min-w-full text-left text-sm">
                <thead className="border-b text-xs uppercase text-slate-500">
                  <tr>
                    <th className="py-2 pr-4">File</th>
                    <th className="py-2 pr-4">Status</th>
                    <th className="py-2 pr-4">Rows</th>
                    <th className="py-2 pr-4">New / added to existing</th>
                    <th className="py-2">Started by</th>
                  </tr>
                </thead>
                <tbody className="divide-y divide-slate-100">
                  {recent.map((i) => (
                    <tr key={i.id}>
                      <td className="py-2 pr-4">
                        <Link href={`/app/leads/import/${i.id}`} className="font-medium underline">
                          {i.fileName}
                        </Link>
                        <div className="text-xs text-slate-500">{fmtDateTime(i.createdAt)}</div>
                      </td>
                      <td className="py-2 pr-4">
                        <Badge tone={statusTone(i.status)}>{STATUS_LABELS[i.status]}</Badge>
                      </td>
                      <td className="py-2 pr-4">{i.total.toLocaleString('en-IN')}</td>
                      <td className="py-2 pr-4">
                        {i.created.toLocaleString('en-IN')} / {i.attached.toLocaleString('en-IN')}
                      </td>
                      <td className="py-2">{i.createdByName}</td>
                    </tr>
                  ))}
                </tbody>
              </table>
            </div>
          )}
        </Card>

        <Card
          title="Saved mapping templates"
          description="Save a mapping from an import's page once it has been validated, then pick it when mapping a file in the same format. Columns are matched by heading, never by position."
        >
          {templates.length === 0 ? (
            <EmptyState>No saved templates yet.</EmptyState>
          ) : (
            <ul className="divide-y divide-slate-100">
              {templates.map((t) => (
                <li key={t.id} className="flex flex-wrap items-center justify-between gap-2 py-3">
                  <p className="text-sm">
                    <span className="font-medium text-slate-900">{t.name}</span> · {t.fieldCount}{' '}
                    {t.fieldCount === 1 ? 'column' : 'columns'}
                    {t.sourceName && <> · for {t.sourceName}</>}
                    <span className="block text-xs text-slate-500">
                      Saved {fmtDateTime(t.createdAt)}
                    </span>
                  </p>
                  <ActionFormButton
                    action={deleteMappingTemplateAction}
                    fields={{ templateId: t.id }}
                    label="Delete"
                    variant="danger"
                    confirm={`Delete the template "${t.name}"? Imports already mapped are not affected.`}
                  />
                </li>
              ))}
            </ul>
          )}
        </Card>

        <Card>
          <h2 className="mb-2 font-medium text-slate-900">File requirements</h2>
          <ul className="list-inside list-disc space-y-1 text-sm text-slate-700">
            <li>
              .xlsx or .csv (CSV saved as &quot;CSV UTF-8&quot;), up to {mb(r.limits.maxBytes)}.
            </li>
            <li>
              Up to {r.limits.maxRows.toLocaleString('en-IN')} rows, {r.limits.maxColumns} columns
              and {r.limits.maxSheets} worksheets; you choose the worksheet.
            </li>
            <li>The first non-empty row holds the column names.</li>
            <li>
              Macro-enabled or old Excel files (.xlsm, .xls, .xlsb) and password-protected files are
              refused. Formulas are never run; only their saved values are read.
            </li>
            <li>
              Rows whose phone matches an open lead are not created again: the enquiry is added to
              that lead (or skipped, if you choose) and its owner is told.
            </li>
          </ul>
        </Card>

        <Card>
          <h2 className="mb-2 font-medium text-slate-900">Columns you can map</h2>
          <div className="overflow-x-auto">
            <table className="min-w-full text-left text-sm">
              <thead className="border-b text-xs uppercase text-slate-500">
                <tr>
                  <th className="py-2 pr-4">Lead field</th>
                  <th className="py-2 pr-4">Needed</th>
                  <th className="py-2">Notes</th>
                </tr>
              </thead>
              <tbody className="divide-y divide-slate-100">
                {IMPORT_FIELDS.map((f) => (
                  <tr key={f.field}>
                    <td className="py-2 pr-4 font-medium">{f.label}</td>
                    <td className="py-2 pr-4">
                      {f.required ? <Badge tone="warn">Required</Badge> : 'Optional'}
                    </td>
                    <td className="py-2 text-slate-600">{f.hint ?? ''}</td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
        </Card>

        <p className="text-sm">
          <Link href="/app/leads" className="underline">
            ← Back to leads
          </Link>
        </p>
      </div>
    </>
  );
}
