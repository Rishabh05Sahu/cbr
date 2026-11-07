import Link from 'next/link';
import { notFound } from 'next/navigation';
import { Card, PageHeader } from '@/components/ui';
import { listLeadSources } from '@/modules/leads';
import { getPublishedScript } from '@/modules/scripts';
import { can } from '@/platform/authz';
import { pageContext, pageRequire } from '@/platform/auth/session';
import { DomainError } from '@/platform/errors';
import { fmtDateTime } from '../../leads/labels';
import { ScriptContentView, TargetingBadges } from '../script-content';

/** One published script's live version (script.read). Drafts and archived scripts: 404. */
export default async function ScriptPage({ params }: PageProps<'/app/scripts/[id]'>) {
  const { ctx } = await pageContext();
  pageRequire(ctx, 'script.read');
  const { id } = await params;
  const script = await getPublishedScript(ctx, id).catch((e: unknown) => {
    if (e instanceof DomainError && e.code === 'NOT_FOUND') notFound();
    throw e;
  });
  const sources = can(ctx, 'lead.read') ? await listLeadSources(ctx) : [];
  return (
    <>
      <PageHeader
        title={script.name}
        description={`Version ${script.versionNo} · published ${fmtDateTime(script.publishedAt)}`}
      />
      <div className="mb-4">
        <TargetingBadges t={script} sourceNames={new Map(sources.map((s) => [s.id, s.name]))} />
      </div>
      <Card>
        <ScriptContentView content={script.content} />
      </Card>
      <p className="mt-4 text-sm">
        <Link href="/app/scripts" className="tap underline">
          ← All scripts
        </Link>
      </p>
    </>
  );
}
