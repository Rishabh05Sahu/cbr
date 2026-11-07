import Link from 'next/link';
import { Card, EmptyState, PageHeader } from '@/components/ui';
import { listLeadSources } from '@/modules/leads';
import { listPublishedScripts } from '@/modules/scripts';
import { can } from '@/platform/authz';
import { pageContext, pageRequire } from '@/platform/auth/session';
import { fmtDateTime } from '../leads/labels';
import { TargetingBadges } from './script-content';

/** Published call scripts for every sales role (script.read, FR-095–FR-097). Read only. */
export default async function ScriptsPage() {
  const { ctx } = await pageContext();
  pageRequire(ctx, 'script.read');
  const [scripts, sources] = await Promise.all([
    listPublishedScripts(ctx),
    can(ctx, 'lead.read') ? listLeadSources(ctx) : Promise.resolve([]),
  ]);
  const sourceNames = new Map(sources.map((s) => [s.id, s.name]));
  return (
    <>
      <div className="flex flex-wrap items-start justify-between gap-2">
        <PageHeader
          title="Call scripts"
          description="Published scripts for calls and follow-ups."
        />
        {can(ctx, 'script.manage') && (
          <Link
            href="/app/settings/scripts"
            className="tap rounded-md border border-slate-300 bg-white px-3 py-2 text-sm font-medium text-slate-900 hover:bg-slate-50"
          >
            Manage scripts
          </Link>
        )}
      </div>
      <Card>
        {scripts.length === 0 ? (
          <EmptyState>No published scripts yet.</EmptyState>
        ) : (
          <ul className="divide-y divide-slate-100">
            {scripts.map((s) => (
              <li key={s.id} className="space-y-1 py-3">
                <Link
                  href={`/app/scripts/${s.id}` as '/app/scripts'}
                  className="tap font-medium text-blue-900 underline-offset-2 hover:underline"
                >
                  {s.name}
                </Link>
                <p className="text-xs text-slate-600">
                  Version {s.versionNo} · published {fmtDateTime(s.publishedAt)}
                </p>
                <TargetingBadges t={s} sourceNames={sourceNames} />
              </li>
            ))}
          </ul>
        )}
      </Card>
    </>
  );
}
