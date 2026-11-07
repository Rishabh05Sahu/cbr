import Link from 'next/link';
import { notFound } from 'next/navigation';
import { ActionForm } from '@/components/action-form';
import { ActionFormButton } from '@/components/action-form-button';
import { Alert, Badge, Card, Field, Input, PageHeader } from '@/components/ui';
import { listLeadSources, PROPERTY_TYPES, TRANSACTION_TYPES } from '@/modules/leads';
import { getScriptForEditing } from '@/modules/scripts';
import {
  archiveScriptAction,
  saveDraftAction,
  updateScriptSettingsAction,
} from '@/modules/scripts/actions';
import { pageContext, pageRequire } from '@/platform/auth/session';
import { DomainError } from '@/platform/errors';
import { fmtDateTime, LABELS } from '../../../leads/labels';
import { ScriptContentView } from '../../../scripts/script-content';
import { DraftFields, PublishForm, showFeedback } from './editor-parts';

const MARKUP_HINT =
  'Blank line = new paragraph. "- " bullet, "1. " numbered item, **bold**, _italic_. No other formatting.';

/** Edit one script (FR-095–FR-097): settings, draft content, publish, history, archive. */
export default async function EditScriptPage({ params }: PageProps<'/app/settings/scripts/[id]'>) {
  const { ctx } = await pageContext();
  pageRequire(ctx, 'script.manage');
  const { id } = await params;
  const s = await getScriptForEditing(ctx, id).catch((e: unknown) => {
    if (e instanceof DomainError && e.code === 'NOT_FOUND') notFound();
    throw e;
  });
  const sources = await listLeadSources(ctx);
  const archived = s.status === 'ARCHIVED';
  const nextNo = s.draftVersionNo ?? Math.max(0, ...s.versions.map((v) => v.versionNo)) + 1;
  const checkboxes = (name: string, codes: readonly string[], chosen: readonly string[]) => (
    <div className="flex flex-wrap gap-x-4 gap-y-2">
      {codes.map((c) => (
        <label key={c} className="inline-flex items-center gap-2 text-sm">
          <input type="checkbox" name={name} value={c} defaultChecked={chosen.includes(c)} />
          {LABELS[c] ?? c}
        </label>
      ))}
    </div>
  );

  return (
    <>
      <PageHeader
        title={s.name}
        description={
          s.status === 'PUBLISHED'
            ? `Published · live version ${s.liveVersionNo}`
            : s.status === 'DRAFT'
              ? 'Draft · not published yet'
              : 'Archived'
        }
      />
      {archived && (
        <div className="mb-4">
          <Alert tone="warn">
            Archived {s.archivedAt ? fmtDateTime(s.archivedAt) : ''}. The script and its versions
            are kept; it can no longer be edited or published.
          </Alert>
        </div>
      )}
      <div className="grid gap-6 lg:grid-cols-3">
        <div className="space-y-6 lg:col-span-2">
          {!archived && (
            <Card
              title={s.draftVersionNo ? `Draft — version ${s.draftVersionNo}` : 'Edit content'}
              description={
                s.draftVersionNo
                  ? 'Unpublished changes. Publishing makes this version live; it then never changes.'
                  : s.liveVersionNo
                    ? `Saving creates draft version ${nextNo}. The live version ${s.liveVersionNo} is not changed.`
                    : 'Write the script, save the draft, then publish it.'
              }
            >
              <ActionForm
                action={saveDraftAction}
                submitLabel="Save draft"
                successMessage="Draft saved."
                showSuccess={showFeedback.draftSaved(s.draftVersionNo)}
                resetOnSuccess={false}
                fieldLabels={{ opening: 'Opening', questions: 'Qualification questions' }}
              >
                <input type="hidden" name="scriptId" value={s.id} />
                <input type="hidden" name="draftVersion" value={s.draftVersion} />
                <p className="text-xs text-slate-600">{MARKUP_HINT}</p>
                <DraftFields editing={s.editing} />
              </ActionForm>
            </Card>
          )}
          <Card
            title={s.liveVersionNo ? `Live version ${s.liveVersionNo}` : 'Live version'}
            description="What the sales team reads."
          >
            {s.live ? (
              <ScriptContentView content={s.live} />
            ) : (
              <p className="text-sm text-slate-600">Not published yet.</p>
            )}
          </Card>
        </div>

        <div className="space-y-6">
          {!archived && (
            <Card title="Publish" description="Published versions can never be changed.">
              <PublishForm
                scriptId={s.id}
                draftVersionNo={s.draftVersionNo}
                draftVersion={s.draftVersion}
              />
            </Card>
          )}
          <Card title="Targeting" description="Which leads the script is meant for. Empty = any.">
            <ActionForm
              action={updateScriptSettingsAction}
              {...(archived ? {} : { submitLabel: 'Save settings' })}
              successMessage="Settings saved."
              resetOnSuccess={false}
              fieldLabels={{ sourceIds: 'Lead sources' }}
            >
              <fieldset disabled={archived} className="space-y-4">
                <input type="hidden" name="scriptId" value={s.id} />
                <input type="hidden" name="version" value={s.version} />
                <Field label="Name" htmlFor="script-name">
                  <Input
                    id="script-name"
                    name="name"
                    required
                    maxLength={100}
                    defaultValue={s.name}
                  />
                </Field>
                <div>
                  <p className="mb-1 text-sm font-medium text-slate-900">Transaction</p>
                  {checkboxes('transactionTypes', TRANSACTION_TYPES, s.transactionTypes)}
                </div>
                <div>
                  <p className="mb-1 text-sm font-medium text-slate-900">Property type</p>
                  {checkboxes('propertyTypes', PROPERTY_TYPES, s.propertyTypes)}
                </div>
                <Field
                  label="Language codes"
                  htmlFor="script-languages"
                  hint="Two-letter codes, comma-separated, matched to the lead's language code. E.g. hi, mr"
                >
                  <Input
                    id="script-languages"
                    name="languages"
                    maxLength={200}
                    defaultValue={s.languages.join(', ')}
                  />
                </Field>
                <div>
                  <p className="mb-1 text-sm font-medium text-slate-900">Lead sources</p>
                  <div className="flex flex-wrap gap-x-4 gap-y-2">
                    {sources.map((src) => (
                      <label key={src.id} className="inline-flex items-center gap-2 text-sm">
                        <input
                          type="checkbox"
                          name="sourceIds"
                          value={src.id}
                          defaultChecked={s.sourceIds.includes(src.id)}
                        />
                        {src.name}
                      </label>
                    ))}
                  </div>
                </div>
              </fieldset>
            </ActionForm>
          </Card>
          <Card title="Versions">
            <ul className="divide-y divide-slate-100 text-sm">
              {s.versions.map((v) => (
                <li key={v.id} className="flex flex-wrap items-center gap-2 py-2">
                  <span className="font-medium">v{v.versionNo}</span>
                  {v.live && <Badge tone="good">Live</Badge>}
                  {v.publishedAt ? (
                    <span className="text-xs text-slate-600">
                      published {fmtDateTime(v.publishedAt)}
                      {v.publishedByName ? ` by ${v.publishedByName}` : ''}
                    </span>
                  ) : (
                    <Badge>Draft</Badge>
                  )}
                </li>
              ))}
            </ul>
          </Card>
          {!archived && (
            <Card
              title="Archive"
              description="Hides the script from the sales team. Final; nothing is deleted."
            >
              <ActionFormButton
                action={archiveScriptAction}
                fields={{ scriptId: s.id, version: String(s.version) }}
                label="Archive script"
                variant="danger"
                confirm={`Archive "${s.name}"? It can no longer be edited or published.`}
              />
            </Card>
          )}
          <p className="text-sm">
            <Link href="/app/settings/scripts" className="tap underline">
              ← All scripts
            </Link>
          </p>
        </div>
      </div>
    </>
  );
}
