import Link from 'next/link';
import { notFound } from 'next/navigation';
import { ActionForm } from '@/components/action-form';
import { Alert, Badge, Card, EmptyState, Field, Input, PageHeader, Select } from '@/components/ui';
import {
  ATTESTATION_TEXT,
  getImport,
  IMPORT_FIELDS,
  listImportIssues,
  listMappingTemplates,
  TEMPLATE_WARNING_MESSAGES,
  templateForImport,
  TERMINAL_STATUSES,
  WORKING_STATUSES,
  type ImportView,
  type MappingTemplateView,
  type TemplateWarning,
} from '@/modules/imports';
import { saveMappingTemplateAction } from '@/modules/imports/actions';
import { assignmentTargets, listCustomFields, listLeadSources } from '@/modules/leads';
import { pageContext, pageRequire } from '@/platform/auth/session';
import { DomainError } from '@/platform/errors';
import { fmtDateTime } from '../../labels';
import { STATUS_LABELS, statusTone } from '../status';
import { AutoRefresh, ConfirmPanel, JobButtons, MappingForm, SheetPicker } from './controls';

const ISSUES_SHOWN = 200;
const CUSTOM_HINTS: Record<string, string> = {
  text: 'Text',
  number: 'Digits only, e.g. 4 or 2.5',
  date: 'YYYY-MM-DD (Excel dates are fine)',
  boolean: 'Yes/No or True/False',
  single_select: 'One of the field’s options',
  multi_select: 'Options separated by ";"',
};
const n = (x: number) => x.toLocaleString('en-IN');

/**
 * One import (FR-040–FR-052): status survives a refresh because it is read from the job row.
 * Row problems show row numbers, column headings and fixed messages, never cell values.
 */
export default async function ImportJobPage({
  params,
  searchParams,
}: PageProps<'/app/leads/import/[id]'>) {
  const { ctx } = await pageContext();
  pageRequire(ctx, 'lead.import');
  const { id } = await params;
  const job = await getImport(ctx, id).catch((e: unknown) => {
    if (e instanceof DomainError && e.code === 'NOT_FOUND') notFound();
    throw e;
  });
  const showIssues =
    ['READY', 'IMPORTING', 'PAUSED'].includes(job.status) || TERMINAL_STATUSES.has(job.status);
  const issues = showIssues ? await listImportIssues(ctx, id, { limit: ISSUES_SHOWN }) : null;
  const mapping =
    job.status === 'NEEDS_MAPPING' || job.status === 'READY'
      ? {
          sources: await listLeadSources(ctx),
          targets: await assignmentTargets(ctx),
          // Built-in fields, then the org's active custom fields (M5; required ones must be mapped).
          fields: [
            ...IMPORT_FIELDS.map((f) => ({
              field: f.field as string,
              label: f.label,
              required: f.required,
              ...(f.hint ? { hint: f.hint } : {}),
            })),
            ...(await listCustomFields(ctx)).map((f) => ({
              field: `custom:${f.key}`,
              label: `${f.label} (custom)`,
              required: f.required,
              hint: CUSTOM_HINTS[f.type] ?? 'Custom field',
            })),
          ],
        }
      : null;

  // FR-041: a saved template pre-fills the mapping form (headings matched again; never by
  // position). Nothing is saved until the mapping is submitted and validated as usual.
  const templates = mapping && job.isUploader ? await listMappingTemplates(ctx) : [];
  const requested = (await searchParams).template;
  const templateId = typeof requested === 'string' ? requested : null;
  let applied: Awaited<ReturnType<typeof templateForImport>> | null = null;
  let templateMissing = false;
  if (templateId && mapping && job.isUploader)
    applied = await templateForImport(ctx, id, templateId).catch((e: unknown) => {
      if (e instanceof DomainError && e.code === 'NOT_FOUND') {
        templateMissing = true;
        return null;
      }
      throw e;
    });
  const formMapping = (applied?.mapping ?? job.mapping) as Record<string, number>;
  const formSource = applied ? (applied.sourceId ?? job.defaultSourceId) : job.defaultSourceId;
  const fieldLabel = (field: string) =>
    mapping?.fields.find((f) => f.field === field)?.label ?? field;
  const templateTools = mapping && job.isUploader && (
    <TemplateTools
      importId={job.id}
      templates={templates}
      selected={templateId}
      applied={applied}
      missing={templateMissing}
      fieldLabel={fieldLabel}
    />
  );
  const canSaveTemplate =
    job.mapping !== null &&
    Object.keys(job.mapping as object).length > 0 &&
    ['READY', 'COMPLETED', 'COMPLETED_WITH_ERRORS'].includes(job.status);
  const saveSources = canSaveTemplate ? (mapping?.sources ?? (await listLeadSources(ctx))) : [];
  const c = job.counts;
  const canCancel = !TERMINAL_STATUSES.has(job.status);
  const canResume = job.status === 'PAUSED' && job.isUploader;

  return (
    <>
      <PageHeader
        title={`Import: ${job.fileName}`}
        description={`Started by ${job.createdByName}, ${fmtDateTime(job.createdAt)}`}
      />
      <div className="space-y-4">
        <Card
          title="Status"
          actions={<Badge tone={statusTone(job.status)}>{STATUS_LABELS[job.status]}</Badge>}
        >
          <div className="space-y-3">
            {WORKING_STATUSES.has(job.status) && <AutoRefresh />}
            {job.errorMessage && (
              <Alert tone={job.status === 'PAUSED' ? 'warn' : 'error'}>{job.errorMessage}</Alert>
            )}
            {job.status === 'AWAITING_UPLOAD' && (
              <Alert tone="info">
                The file has not been confirmed as uploaded. Upload it again from the import page,
                or cancel this import.
              </Alert>
            )}
            {job.status === 'IMPORTING' && c.total > 0 && (
              <div>
                <div className="h-2 w-full overflow-hidden rounded bg-slate-100">
                  <div
                    className="h-2 bg-blue-700"
                    style={{ width: `${Math.round((c.processed / c.total) * 100)}%` }}
                  />
                </div>
                <p className="mt-1 text-xs text-slate-600">
                  {n(c.processed)} of {n(c.total)} rows processed
                </p>
              </div>
            )}
            {job.status === 'PAUSED' && !job.isUploader && (
              <p className="text-sm text-slate-600">
                Only {job.createdByName} can resume this import once their access is restored. You
                can cancel it; leads already imported are kept.
              </p>
            )}
            <Counts job={job} />
            <JobButtons importId={job.id} canCancel={canCancel} canResume={canResume} />
          </div>
        </Card>

        {job.status === 'NEEDS_MAPPING' && mapping && (
          <Card
            title="Map your columns"
            description="Choose which column holds each lead field. Suggestions come from the column headings."
          >
            {!job.isUploader ? (
              <p className="text-sm text-slate-600">Only {job.createdByName} can map this file.</p>
            ) : (
              <div className="space-y-6">
                {job.sheetNames.length > 1 && (
                  <SheetPicker
                    importId={job.id}
                    version={job.version}
                    sheets={job.sheetNames}
                    current={job.sheetName}
                  />
                )}
                {templateTools}
                <MappingForm
                  key={applied ? `template-${templateId}` : 'job'}
                  importId={job.id}
                  version={job.version}
                  headers={job.headers}
                  fields={mapping.fields}
                  mapping={formMapping}
                  sources={mapping.sources}
                  defaultSourceId={formSource}
                  duplicatePolicy={job.duplicatePolicy}
                  assignment={job.assignment}
                  dryRun={job.dryRun}
                  people={mapping.targets.people}
                  teams={mapping.targets.teams}
                  orgQueue={mapping.targets.orgQueue}
                />
              </div>
            )}
          </Card>
        )}

        {job.status === 'READY' && (
          <Card
            title="Ready to import"
            description="Every row has been checked. Nothing has been written to your leads yet."
          >
            {!job.isUploader ? (
              <p className="text-sm text-slate-600">
                Only {job.createdByName} can start this import.
              </p>
            ) : c.valid === 0 ? (
              <Alert tone="warn">
                No row can be imported. Fix the file or the mapping and try again.
              </Alert>
            ) : (
              <div className="space-y-6">
                <ConfirmPanel
                  importId={job.id}
                  version={job.version}
                  rows={c.valid}
                  duplicateFile={job.duplicateOfJob !== null}
                  attestationText={ATTESTATION_TEXT}
                />
                {mapping && (
                  <details open={applied !== null || templateMissing}>
                    <summary className="cursor-pointer text-sm underline">
                      Change the mapping
                    </summary>
                    <div className="mt-4 space-y-6">
                      {templateTools}
                      <MappingForm
                        key={applied ? `template-${templateId}` : 'job'}
                        importId={job.id}
                        version={job.version}
                        headers={job.headers}
                        fields={mapping.fields}
                        mapping={formMapping}
                        sources={mapping.sources}
                        defaultSourceId={formSource}
                        duplicatePolicy={job.duplicatePolicy}
                        assignment={job.assignment}
                        dryRun={job.dryRun}
                        people={mapping.targets.people}
                        teams={mapping.targets.teams}
                        orgQueue={mapping.targets.orgQueue}
                      />
                    </div>
                  </details>
                )}
              </div>
            )}
          </Card>
        )}

        {canSaveTemplate && (
          <Card
            title="Save this mapping as a template"
            description="Reuse it for the next file in the same format. Only the column headings and fields are saved, never the file or its rows."
          >
            <ActionForm
              action={saveMappingTemplateAction}
              submitLabel="Save template"
              successMessage="Template saved. Pick it when mapping your next file."
              className="grid gap-4 sm:grid-cols-2"
            >
              <input type="hidden" name="importId" value={job.id} />
              <Field label="Template name" htmlFor="tpl-name" hint="For example 99acres export">
                <Input id="tpl-name" name="name" required maxLength={100} />
              </Field>
              <Field label="For lead source (optional)" htmlFor="tpl-source">
                <Select id="tpl-source" name="sourceId" defaultValue={job.defaultSourceId ?? ''}>
                  <option value="">Any source</option>
                  {saveSources.map((s) => (
                    <option key={s.id} value={s.id}>
                      {s.name}
                    </option>
                  ))}
                </Select>
              </Field>
            </ActionForm>
          </Card>
        )}

        {issues && (
          <Card
            title="Row problems and duplicates"
            actions={
              issues.total > 0 ? (
                <a href={`/app/leads/import/${job.id}/issues.csv`} className="text-sm underline">
                  Download all ({n(issues.total)}) as CSV
                </a>
              ) : null
            }
          >
            {issues.total === 0 ? (
              <EmptyState>No row problems.</EmptyState>
            ) : (
              <div className="overflow-x-auto">
                <table className="min-w-full text-left text-sm">
                  <thead className="border-b text-xs uppercase text-slate-500">
                    <tr>
                      <th className="py-2 pr-4">Row</th>
                      <th className="py-2 pr-4">Column</th>
                      <th className="py-2 pr-4">Problem</th>
                      <th className="py-2">Details</th>
                    </tr>
                  </thead>
                  <tbody className="divide-y divide-slate-100">
                    {issues.issues.map((i, k) => (
                      <tr key={`${i.row}-${i.code}-${i.field}-${k}`}>
                        <td className="py-2 pr-4">{i.row}</td>
                        <td className="py-2 pr-4">{i.column ?? i.fieldLabel ?? '—'}</td>
                        <td className="py-2 pr-4">{i.message}</td>
                        <td className="py-2">
                          {i.relatedRow !== null && `Same phone as row ${i.relatedRow}`}
                          {i.leadId && (
                            <Link href={`/app/leads/${i.leadId}`} className="underline">
                              {i.outcome === 'DUPLICATE_SKIPPED'
                                ? 'Skipped; existing lead'
                                : 'Existing lead'}
                            </Link>
                          )}
                        </td>
                      </tr>
                    ))}
                  </tbody>
                </table>
                {issues.total > issues.issues.length && (
                  <p className="mt-2 text-xs text-slate-500">
                    Showing the first {n(issues.issues.length)} of {n(issues.total)}. Download the
                    CSV for all.
                  </p>
                )}
              </div>
            )}
          </Card>
        )}

        <p className="text-sm">
          <Link href="/app/leads/import" className="underline">
            ← All imports
          </Link>
        </p>
      </div>
    </>
  );
}

function Counts({ job }: { job: ImportView }) {
  const c = job.counts;
  const rows: [string, number][] = [];
  if (job.status === 'NEEDS_MAPPING') rows.push(['Rows found', c.total]);
  else if (
    c.total > 0 &&
    !['AWAITING_UPLOAD', 'UPLOADED', 'ANALYSING', 'VALIDATING'].includes(job.status)
  ) {
    rows.push(
      ['Rows in file', c.total],
      ['Valid', c.valid],
      ['With problems', c.invalid],
      ['Same phone earlier in file', c.duplicateInFile],
      ['Empty', c.empty],
    );
    if (job.status === 'READY' || (job.dryRun && job.status === 'COMPLETED'))
      rows.push(['Match an open lead', c.existingDuplicates]);
    if (job.attestedAt)
      rows.push(
        ['New leads created', c.created],
        ['Added to existing leads', c.attached],
        ['Skipped (existing lead)', c.skipped],
        ['Could not be imported', c.failed],
      );
  }
  if (!rows.length) return null;
  return (
    <dl className="grid grid-cols-2 gap-x-6 gap-y-1 text-sm sm:grid-cols-3">
      {rows.map(([label, value]) => (
        <div key={label} className="flex justify-between gap-2 border-b border-slate-100 py-1">
          <dt className="text-slate-600">{label}</dt>
          <dd className="font-medium">{n(value)}</dd>
        </div>
      ))}
      {job.dryRun && job.status === 'COMPLETED' && (
        <p className="col-span-full text-sm text-slate-600">
          Dry run: no leads were created or changed.
        </p>
      )}
    </dl>
  );
}

/** Pick a saved template (a plain GET form: applying writes nothing) and see what it could not map. */
function TemplateTools(p: {
  importId: string;
  templates: MappingTemplateView[];
  selected: string | null;
  applied: { name: string; warnings: TemplateWarning[] } | null;
  missing: boolean;
  fieldLabel: (field: string) => string;
}) {
  return (
    <div className="space-y-3">
      {p.templates.length === 0 ? (
        <p className="text-sm text-slate-600">
          No saved mapping templates yet. After validating a mapping you can save it for the next
          file in the same format.
        </p>
      ) : (
        <form method="get" className="flex flex-wrap items-end gap-2">
          <Field label="Use a saved template" htmlFor="tpl-pick">
            <Select id="tpl-pick" name="template" defaultValue={p.selected ?? ''} required>
              <option value="" disabled>
                Choose a template
              </option>
              {p.templates.map((t) => (
                <option key={t.id} value={t.id}>
                  {t.name}
                  {t.sourceName ? ` (${t.sourceName})` : ''}
                </option>
              ))}
            </Select>
          </Field>
          <button
            type="submit"
            className="tap rounded-md border border-slate-300 px-3 py-2 text-sm"
          >
            Apply template
          </button>
          {p.selected && (
            <Link
              href={`/app/leads/import/${p.importId}`}
              className="tap px-2 py-2 text-sm underline"
            >
              Clear
            </Link>
          )}
        </form>
      )}
      {p.missing && (
        <Alert tone="warn">
          That template no longer exists. Choose another or map the columns.
        </Alert>
      )}
      {p.applied &&
        (p.applied.warnings.length === 0 ? (
          <Alert tone="info">
            Template “{p.applied.name}” applied. Check the columns below, then validate.
          </Alert>
        ) : (
          <Alert tone="warn">
            <p>
              Template “{p.applied.name}” applied, but some fields need your choice before you
              validate:
            </p>
            <ul className="mt-1 list-disc pl-5">
              {p.applied.warnings.map((w) => (
                <li key={`${w.code}-${w.field}`}>
                  <span className="font-medium">{p.fieldLabel(w.field)}</span>
                  {w.header ? <> (heading “{w.header}”)</> : null}:{' '}
                  {TEMPLATE_WARNING_MESSAGES[w.code]}
                </li>
              ))}
            </ul>
          </Alert>
        ))}
    </div>
  );
}
