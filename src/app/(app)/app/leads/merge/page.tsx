import Link from 'next/link';
import { notFound } from 'next/navigation';
import { ActionForm } from '@/components/action-form';
import { Alert, Card, PageHeader } from '@/components/ui';
import { getLead, previewMerge, type MergePreview } from '@/modules/leads';
import { mergeLeadsAction } from '@/modules/leads/actions';
import { pageContext, pageRequire } from '@/platform/auth/session';
import { DomainError } from '@/platform/errors';
import { label } from '../labels';

const FIELD_LABELS: Record<string, string> = {
  fullName: 'Name',
  alternatePhoneE164: 'Alternate phone',
  email: 'Email',
  preferredLanguage: 'Language',
  preferredContactMethod: 'Preferred contact',
  transactionType: 'Looking to',
  propertyType: 'Property type',
  bhkMin: 'BHK from',
  bhkMax: 'BHK up to',
  budgetMin: 'Budget from',
  budgetMax: 'Budget up to',
  preferredCity: 'City',
  purpose: 'Purpose',
  timeline: 'Timeline',
  intent: 'Intent',
  campaign: 'Campaign',
};
const show = (v: string | number | null) => (v === null ? '—' : label(String(v)) || String(v));

/**
 * Merge preview (FR-062, D1). The surviving lead keeps its phone, owner, team and stage; blank
 * fields are filled from the duplicate; every field where both differ needs an explicit choice
 * (no defaults). The duplicate becomes a read-only record pointing here, and its history stays
 * where it is and is shown on the surviving lead's timeline (nothing is rewritten).
 */
export default async function MergePage({ searchParams }: PageProps<'/app/leads/merge'>) {
  const { ctx } = await pageContext();
  pageRequire(ctx, 'lead.merge');
  const sp = await searchParams;
  const survivorId = typeof sp.survivor === 'string' ? sp.survivor : '';
  const mergedId = typeof sp.merged === 'string' ? sp.merged : '';
  let plan: MergePreview | null = null;
  let refusal: string | null = null;
  try {
    plan = await previewMerge(ctx, { survivorId, mergedId });
  } catch (e) {
    if (e instanceof DomainError && e.code === 'NOT_FOUND') notFound();
    if (e instanceof DomainError) refusal = e.message;
    else if (e instanceof Error && e.name === 'ZodError') notFound();
    else throw e;
  }
  if (!plan)
    return (
      <>
        <PageHeader title="Merge leads" />
        <Alert tone="error">{refusal ?? 'These leads cannot be merged.'}</Alert>
      </>
    );
  const [survivor, merged] = await Promise.all([
    getLead(ctx, plan.survivorId),
    getLead(ctx, plan.mergedId),
  ]);
  // Only list localities when the duplicate actually adds some (M5 §I.4 U5).
  const showLocalities = plan.localitiesAdded.length > 0 || plan.localitiesDropped > 0;
  const fillCount = plan.fills.length + (showLocalities ? 1 : 0);

  return (
    <>
      <PageHeader
        title="Merge leads"
        description="Check every difference and choose what the surviving lead keeps. Nothing changes until you confirm."
      />
      <div className="space-y-4">
        <Card title="What happens">
          <ul className="list-disc space-y-1 pl-5 text-sm text-slate-700">
            <li>
              <Link
                href={`/app/leads/${survivor.id}` as '/app/leads'}
                className="tap font-medium underline"
              >
                {survivor.fullName}
              </Link>{' '}
              ({survivor.primaryPhoneE164}) survives and keeps its phone, owner, team and stage.
            </li>
            <li>
              <Link
                href={`/app/leads/${merged.id}` as '/app/leads'}
                className="tap font-medium underline"
              >
                {merged.fullName}
              </Link>{' '}
              ({merged.primaryPhoneE164}) becomes a read-only record pointing to the survivor.
            </li>
            <li>
              History is preserved: the duplicate&apos;s notes, enquiries and timeline stay as they
              are and appear on the survivor&apos;s timeline (combined by reference, never
              rewritten).
            </li>
            {plan.carriesDoNotContact && (
              <li>
                <strong>The duplicate asked not to be contacted,</strong> so the surviving lead
                becomes do-not-contact. Only an Owner or Admin can lift it, with evidence.
              </li>
            )}
            <li>A merge cannot be undone.</li>
          </ul>
          <p className="mt-3 text-sm">
            <Link
              href={`/app/leads/merge?survivor=${merged.id}&merged=${survivor.id}` as '/app/leads'}
              className="tap underline"
            >
              Keep the other lead instead
            </Link>
          </p>
        </Card>

        <ActionForm
          action={mergeLeadsAction}
          submitLabel="Merge leads"
          className="space-y-4"
          fieldLabels={FIELD_LABELS}
          resetOnSuccess={false}
        >
          <input type="hidden" name="survivorId" value={plan.survivorId} />
          <input type="hidden" name="mergedId" value={plan.mergedId} />
          <input type="hidden" name="survivorVersion" value={plan.survivorVersion} />
          <input type="hidden" name="mergedVersion" value={plan.mergedVersion} />

          <Card
            title={`Conflicts (${plan.conflicts.length})`}
            description="Both leads have a different value. Choose one for each; there is no default."
          >
            {plan.conflicts.length === 0 ? (
              <p className="text-sm text-slate-600">None.</p>
            ) : (
              <div className="space-y-4">
                {plan.conflicts.map((c) => (
                  <fieldset key={c.field} className="rounded-md border border-slate-200 p-3">
                    <legend className="px-1 text-sm font-medium text-slate-900">
                      {FIELD_LABELS[c.field] ?? c.field}
                    </legend>
                    <label className="flex items-center gap-2 text-sm">
                      <input type="radio" name={`keep.${c.field}`} value="survivor" required />
                      Keep {show(c.survivor)} (surviving lead)
                    </label>
                    <label className="flex items-center gap-2 text-sm">
                      <input type="radio" name={`keep.${c.field}`} value="merged" required />
                      Use {show(c.merged)} (duplicate)
                    </label>
                  </fieldset>
                ))}
              </div>
            )}
          </Card>

          <Card title={`Filled from the duplicate (${fillCount})`}>
            {fillCount === 0 ? (
              <p className="text-sm text-slate-600">Nothing to fill.</p>
            ) : (
              <dl className="grid gap-2 text-sm sm:grid-cols-2">
                {plan.fills.map((f) => (
                  <div key={f.field}>
                    <dt className="text-xs text-slate-500">{FIELD_LABELS[f.field] ?? f.field}</dt>
                    <dd>{show(f.value)}</dd>
                  </div>
                ))}
                {showLocalities && (
                  <div>
                    <dt className="text-xs text-slate-500">Localities (combined)</dt>
                    <dd>
                      {plan.localities.join(', ')}
                      {plan.localitiesDropped > 0 &&
                        ` (${plan.localitiesDropped} over the limit dropped)`}
                    </dd>
                  </div>
                )}
              </dl>
            )}
          </Card>
        </ActionForm>
      </div>
    </>
  );
}
