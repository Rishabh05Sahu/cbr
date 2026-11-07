import Link from 'next/link';
import { notFound } from 'next/navigation';
import { Alert, Badge, Card, EmptyState, PageHeader } from '@/components/ui';
import { listDuplicateCases, type DuplicateCase } from '@/modules/leads';
import { pageContext } from '@/platform/auth/session';
import { can } from '@/platform/authz';
import { fmtDateTime } from '../labels';
import { CaseDecision } from './case-decision';

const REASONS: Record<string, string> = {
  EMAIL: 'Same email address',
  PHONE_ALT: 'Same phone number',
  NAME_SIMILAR: 'Similar name',
  ARCHIVED_ENQUIRY: 'New enquiry for an archived lead',
};
const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;
const STATUS: Record<string, string> = {
  OPEN: 'Open',
  MERGED: 'Merged',
  DISMISSED: 'Not duplicates',
  RESTORED: 'Restored',
  KEPT_ARCHIVED: 'Kept archived',
};

/**
 * Duplicate review queue (lead-lifecycle §5, D2). Only cases whose leads the viewer may see and
 * decide are listed (the service filters by scope; other orgs never appear). Nothing here merges
 * or restores silently: merging opens the merge preview, restoring is an explicit decision, and a
 * case resolved by someone else meanwhile is refused and shown as resolved.
 */
export default async function ReviewQueuePage({ searchParams }: PageProps<'/app/leads/review'>) {
  const { ctx } = await pageContext();
  if (!can(ctx, 'lead.merge') && !can(ctx, 'lead.archive')) notFound();
  const sp = await searchParams;
  const view = sp.status === 'RESOLVED' ? 'RESOLVED' : 'OPEN';
  const cases = await listDuplicateCases(ctx, { status: view });
  // After a refused decision: the case as the other person resolved it (scope-filtered; an id
  // the viewer may not see, or a malformed one, simply shows no notice).
  const conflictId = typeof sp.conflict === 'string' && UUID.test(sp.conflict) ? sp.conflict : null;
  const decided = conflictId
    ? (await listDuplicateCases(ctx, { status: 'RESOLVED', caseId: conflictId }))[0]
    : undefined;
  const mayMerge = can(ctx, 'lead.merge');
  const mayArchive = can(ctx, 'lead.archive');

  return (
    <>
      <PageHeader
        title="Duplicate review"
        description="Possible duplicates and enquiries for archived leads. Nothing is merged or restored until someone decides."
      />
      {decided && (
        <div className="mb-4 space-y-2">
          <Alert tone="warn">
            Someone else decided this case first ({STATUS[decided.status] ?? decided.status}
            {decided.resolvedAt ? `, ${fmtDateTime(decided.resolvedAt)}` : ''}). Your decision was
            not applied.
          </Alert>
          <Card>
            <CaseSummary c={decided} />
          </Card>
        </div>
      )}
      <nav className="mb-4 flex gap-4 text-sm" aria-label="Case status">
        <Link
          href="/app/leads/review"
          className={`tap ${view === 'OPEN' ? 'font-semibold' : 'underline'}`}
        >
          Open
        </Link>
        <Link
          href="/app/leads/review?status=RESOLVED"
          className={`tap ${view === 'RESOLVED' ? 'font-semibold' : 'underline'}`}
        >
          Resolved
        </Link>
      </nav>
      <Card>
        {cases.length === 0 ? (
          <EmptyState>
            {view === 'OPEN' ? 'Nothing to review.' : 'No resolved cases yet.'}
          </EmptyState>
        ) : (
          <ul className="divide-y divide-slate-100">
            {cases.map((c) => (
              <li key={c.id} className="flex flex-wrap items-start justify-between gap-4 py-4">
                <CaseSummary c={c} />
                {c.status === 'OPEN' && (
                  <div className="flex flex-wrap gap-2">
                    {c.matchType === 'ARCHIVED_ENQUIRY'
                      ? mayArchive && (
                          <>
                            <CaseDecision
                              caseId={c.id}
                              decision="restore"
                              label="Restore lead"
                              confirm="Restore this lead so the team can work the new enquiry?"
                              successMessage="Restored."
                            />
                            <CaseDecision
                              caseId={c.id}
                              decision="keep_archived"
                              label="Keep archived"
                              successMessage="Kept archived."
                            />
                          </>
                        )
                      : mayMerge && (
                          <>
                            <Link
                              href={
                                `/app/leads/merge?survivor=${c.candidateLeadId}&merged=${c.leadId}` as '/app/leads'
                              }
                              className="tap rounded-md border border-slate-300 bg-white px-3 py-2 text-sm font-medium text-slate-900 hover:bg-slate-50"
                            >
                              Review merge…
                            </Link>
                            <CaseDecision
                              caseId={c.id}
                              decision="dismiss"
                              label="Not duplicates"
                              confirm="Mark these leads as not duplicates?"
                              successMessage="Dismissed."
                            />
                          </>
                        )}
                  </div>
                )}
              </li>
            ))}
          </ul>
        )}
      </Card>
    </>
  );
}

function CaseSummary({ c }: { c: DuplicateCase }) {
  const lead = (id: string, name: string) => (
    <Link
      href={`/app/leads/${id}` as '/app/leads'}
      className="tap font-medium text-blue-900 underline"
    >
      {name}
    </Link>
  );
  return (
    <div className="space-y-1 text-sm">
      <p className="flex flex-wrap items-center gap-2">
        <Badge tone={c.status === 'OPEN' ? 'warn' : 'neutral'}>
          {STATUS[c.status] ?? c.status}
        </Badge>
        <span className="text-slate-700">{REASONS[c.matchType] ?? c.matchType}</span>
      </p>
      <p>
        {lead(c.leadId, c.leadName)}
        {c.leadArchived && <span className="text-xs text-slate-500"> (archived)</span>}
        {c.candidateLeadId && c.candidateName && (
          <>
            {' and '}
            {lead(c.candidateLeadId, c.candidateName)}
          </>
        )}
      </p>
      <p className="text-xs text-slate-500">
        Raised {fmtDateTime(c.createdAt)}
        {c.resolvedAt ? ` · resolved ${fmtDateTime(c.resolvedAt)}` : ''}
      </p>
    </div>
  );
}
