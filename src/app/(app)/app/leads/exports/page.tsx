import Link from 'next/link';
import { ActionForm } from '@/components/action-form';
import { Alert, Badge, Card, EmptyState, PageHeader } from '@/components/ui';
import { listMyExports } from '@/modules/exports';
import { requestExportAction } from '@/modules/exports/actions';
import {
  EXPORT_DAILY_LIMIT,
  EXPORT_ROW_CAP,
  hasFilters,
  leadQueryString,
  parseLeadQuery,
} from '@/modules/leads';
import { pageContext, pageRequire } from '@/platform/auth/session';
import { fmtDateTime } from '../labels';

const STATE: Record<string, { text: string; tone: 'neutral' | 'warn' | 'good' }> = {
  PREPARING: { text: 'Preparing', tone: 'neutral' },
  AVAILABLE: { text: 'Ready to download', tone: 'good' },
  USED: { text: 'Downloaded', tone: 'neutral' },
  EXPIRED: { text: 'Expired', tone: 'warn' },
  FAILED: { text: 'Failed', tone: 'warn' },
};
const FAILURES: Record<string, string> = {
  EXPORT_TOO_LARGE: `More than ${EXPORT_ROW_CAP.toLocaleString('en-IN')} leads matched. Narrow the filters; nothing was cut off.`,
  EXPORT_FILE_TOO_LARGE:
    'The file would be larger than 20 MB. Narrow the filters; nothing was cut off.',
  EXPORT_STORAGE_FAILED: 'The file could not be stored. Request the export again.',
  EXPIRED_BEFORE_READY: 'The export did not finish in time. Request it again.',
  EXPORT_EXPIRED_BEFORE_READY: 'The export did not finish in time. Request it again.',
};

/**
 * Lead exports (FR-066, D3): Owner only. The request uses the lead list's filters; the list of
 * exports shows only the viewer's own jobs with their real state. Downloads go through the
 * server once (no storage link is ever sent to the browser). The search text is not shown back.
 */
export default async function ExportsPage({ searchParams }: PageProps<'/app/leads/exports'>) {
  const { ctx } = await pageContext();
  pageRequire(ctx, 'lead.export');
  const sp = await searchParams;
  const { query, errors } = parseLeadQuery(sp);
  const queryString = leadQueryString({ ...query, cursor: null }).replace(/^\?/, '');
  const mine = await listMyExports(ctx);

  return (
    <>
      <PageHeader
        title="Lead exports"
        description="Owner only. Each export is a CSV for you alone, downloadable once."
      />
      <div className="space-y-4">
        <Card title="Request an export">
          <ul className="mb-4 list-disc space-y-1 pl-5 text-sm text-slate-700">
            <li>
              At most {EXPORT_ROW_CAP.toLocaleString('en-IN')} leads and 20 MB per file. Larger
              selections are refused, never cut off.
            </li>
            <li>
              The download link works once, within 15 minutes of the file being ready; the file is
              deleted within an hour.
            </li>
            <li>At most {EXPORT_DAILY_LIMIT} exports per 24 hours.</li>
            <li>
              The file names you as the requester, and spreadsheet formulas in lead data are
              neutralised.
            </li>
            <li>
              While phone masking is on, phone numbers in the file are masked as in the lead list.
              The setting in force when the file is prepared applies.
            </li>
          </ul>
          {Object.keys(errors).length > 0 ? (
            <Alert tone="error">
              The filters are not valid. Go back to the{' '}
              <Link href="/app/leads" className="tap underline">
                lead list
              </Link>{' '}
              and fix them.
            </Alert>
          ) : (
            <ActionForm
              action={requestExportAction}
              submitLabel="Request export"
              successMessage="Export requested. It appears below when it is ready."
            >
              <input type="hidden" name="query" value={queryString} />
              <p className="text-sm text-slate-700">
                {hasFilters(query)
                  ? `Leads matching the filters from the lead list${query.q ? ' (including a search)' : ''}.`
                  : 'All active leads.'}{' '}
                <Link href={`/app/leads?${queryString}` as '/app/leads'} className="tap underline">
                  Change filters
                </Link>
              </p>
            </ActionForm>
          )}
        </Card>

        <Card
          title="My exports"
          actions={
            <Link
              href={`/app/leads/exports?${queryString}` as '/app/leads'}
              className="tap text-sm underline"
            >
              Refresh
            </Link>
          }
        >
          {mine.length === 0 ? (
            <EmptyState>No exports yet.</EmptyState>
          ) : (
            <ul className="divide-y divide-slate-100 text-sm">
              {mine.map((x) => (
                <li key={x.id} className="flex flex-wrap items-center justify-between gap-2 py-3">
                  <div>
                    <Badge tone={STATE[x.availability]?.tone ?? 'neutral'}>
                      {STATE[x.availability]?.text ?? x.availability}
                    </Badge>{' '}
                    <span className="text-slate-700">
                      Requested {fmtDateTime(x.createdAt)}
                      {x.rowCount !== null ? ` · ${x.rowCount.toLocaleString('en-IN')} leads` : ''}
                    </span>
                    {x.availability === 'AVAILABLE' && x.expiresAt && (
                      <span className="text-xs text-slate-500">
                        {' '}
                        · until {fmtDateTime(x.expiresAt)}
                      </span>
                    )}
                    {x.availability === 'FAILED' && x.errorCode && (
                      <p className="text-xs text-red-700">
                        {FAILURES[x.errorCode] ?? 'The export failed. Request it again.'}
                      </p>
                    )}
                  </div>
                  {x.availability === 'AVAILABLE' && (
                    <a
                      href={`/app/leads/exports/${x.id}/download`}
                      className="tap rounded-md bg-blue-900 px-3 py-2 text-sm font-medium text-white hover:bg-blue-800"
                    >
                      Download (once)
                    </a>
                  )}
                </li>
              ))}
            </ul>
          )}
        </Card>
      </div>
    </>
  );
}
