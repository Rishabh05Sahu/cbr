import Link from 'next/link';
import { Card, EmptyState, PageHeader } from '@/components/ui';
import { listAudit } from '@/modules/audit';
import { pageContext, pageRequire } from '@/platform/auth/session';

const fmt = (d: Date) =>
  d.toLocaleString('en-IN', {
    day: 'numeric',
    month: 'short',
    year: 'numeric',
    hour: 'numeric',
    minute: '2-digit',
    timeZone: 'Asia/Kolkata',
  });

export default async function AuditPage({ searchParams }: PageProps<'/app/settings/audit'>) {
  const { ctx } = await pageContext();
  pageRequire(ctx, 'audit.read');
  const sp = await searchParams;
  const cursor = typeof sp.cursor === 'string' ? sp.cursor : undefined;
  const { rows, nextCursor } = await listAudit(ctx, { limit: 50, ...(cursor ? { cursor } : {}) });
  return (
    <>
      <PageHeader
        title="Audit log"
        description="Every change to people, roles, teams, settings and support access. Entries cannot be edited or deleted."
      />
      <Card>
        {rows.length === 0 ? (
          <EmptyState>No entries.</EmptyState>
        ) : (
          <div className="overflow-x-auto">
            <table className="min-w-full text-left text-sm">
              <thead className="border-b text-xs uppercase text-slate-500">
                <tr>
                  <th className="py-2 pr-4">When</th>
                  <th className="py-2 pr-4">Who</th>
                  <th className="py-2 pr-4">What</th>
                  <th className="py-2">Details</th>
                </tr>
              </thead>
              <tbody className="divide-y divide-slate-100">
                {rows.map((r) => (
                  <tr key={r.id}>
                    <td className="whitespace-nowrap py-2 pr-4">{fmt(r.occurredAt)}</td>
                    <td className="py-2 pr-4">
                      {r.actorKind === 'PLATFORM'
                        ? 'Platform support'
                        : (r.actorName ?? (r.actorKind === 'SYSTEM' ? 'System' : '—'))}
                    </td>
                    <td className="py-2 pr-4 font-mono text-xs">{r.action}</td>
                    <td className="py-2 font-mono text-xs text-slate-600">
                      {r.metadata ? JSON.stringify(r.metadata) : ''}
                    </td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
        )}
        <div className="mt-4 flex gap-4 text-sm">
          {cursor && (
            <Link className="text-blue-800 underline" href="/app/settings/audit">
              Newest
            </Link>
          )}
          {nextCursor && (
            <Link
              className="text-blue-800 underline"
              href={`/app/settings/audit?cursor=${nextCursor}`}
            >
              Older entries
            </Link>
          )}
        </div>
      </Card>
    </>
  );
}
