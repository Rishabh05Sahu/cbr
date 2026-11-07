import Link from 'next/link';
import { ActionForm } from '@/components/action-form';
import { Badge, Card, EmptyState, Field, Input, PageHeader } from '@/components/ui';
import { listLeadSources } from '@/modules/leads';
import { listScriptsForManage, MAX_SCRIPTS_PER_ORG } from '@/modules/scripts';
import { createScriptAction } from '@/modules/scripts/actions';
import { pageContext, pageRequire } from '@/platform/auth/session';
import { fmtDateTime } from '../../leads/labels';
import { TargetingBadges } from '../../scripts/script-content';

const STATUS = {
  PUBLISHED: { label: 'Published', tone: 'good' },
  DRAFT: { label: 'Draft', tone: 'neutral' },
  ARCHIVED: { label: 'Archived', tone: 'warn' },
} as const;

/** Script authoring (FR-095–FR-097): Owner/Admin (script.manage). */
export default async function ManageScriptsPage() {
  const { ctx } = await pageContext();
  pageRequire(ctx, 'script.manage');
  const [scripts, sources] = await Promise.all([listScriptsForManage(ctx), listLeadSources(ctx)]);
  const sourceNames = new Map(sources.map((s) => [s.id, s.name]));
  return (
    <>
      <PageHeader
        title="Call scripts"
        description={`Write scripts as drafts, publish them for the sales team, archive old ones. ${scripts.length} of ${MAX_SCRIPTS_PER_ORG}.`}
      />
      <div className="space-y-4">
        <Card title="New script" description="Names ignore case and extra spaces when compared.">
          <ActionForm
            action={createScriptAction}
            submitLabel="Create draft"
            className="grid gap-4 sm:grid-cols-2"
          >
            <Field label="Name" htmlFor="script-new-name" hint="For example Buyers — first call">
              <Input id="script-new-name" name="name" required maxLength={100} />
            </Field>
          </ActionForm>
        </Card>
        <Card title="Scripts">
          {scripts.length === 0 ? (
            <EmptyState>No scripts yet.</EmptyState>
          ) : (
            <ul className="divide-y divide-slate-100">
              {scripts.map((s) => (
                <li key={s.id} className="space-y-1 py-3">
                  <div className="flex flex-wrap items-center gap-2">
                    <Link
                      href={`/app/settings/scripts/${s.id}` as '/app/settings/scripts'}
                      className="tap font-medium text-blue-900 underline-offset-2 hover:underline"
                    >
                      {s.name}
                    </Link>
                    <Badge tone={STATUS[s.status].tone}>{STATUS[s.status].label}</Badge>
                    {s.liveVersionNo !== null && <Badge>Live: v{s.liveVersionNo}</Badge>}
                    {s.hasDraft && s.status === 'PUBLISHED' && <Badge>Unpublished changes</Badge>}
                  </div>
                  <TargetingBadges t={s} sourceNames={sourceNames} />
                  <p className="text-xs text-slate-600">Updated {fmtDateTime(s.updatedAt)}</p>
                </li>
              ))}
            </ul>
          )}
        </Card>
      </div>
    </>
  );
}
