import Link from 'next/link';
import { Alert, Badge, Card, EmptyState, Field, PageHeader, Select } from '@/components/ui';
import {
  assignmentTargets,
  leadQueryString,
  searchLeads,
  STAGE_LABELS,
  type SearchParams,
} from '@/modules/leads';
import { pageContext, pageRequire } from '@/platform/auth/session';
import { fmtDateTime } from '../labels';
import { BulkAssignForm } from './bulk-form';

const age = (d: Date) => {
  const h = Math.floor((Date.now() - d.getTime()) / 3_600_000);
  return h < 24 ? `${h} h` : `${Math.floor(h / 24)} d`;
};

/**
 * FR-072 unassigned queue: leads with no owner that the caller may assign (their led teams'
 * queues, or the whole org for Owner/Admin), oldest first, with age. It is the M2 list with the
 * owner fixed to "none", so scope, validation and cursors are the same code.
 */
export default async function QueuePage({ searchParams }: PageProps<'/app/leads/queue'>) {
  const { ctx } = await pageContext();
  pageRequire(ctx, 'lead.assign');
  const sp = await searchParams;
  const team = typeof sp.team === 'string' ? sp.team : undefined;
  const cursor = typeof sp.cursor === 'string' ? sp.cursor : undefined;
  const params: SearchParams = {
    owner: 'none',
    sort: 'oldest',
    ...(team ? { team } : {}),
    ...(cursor ? { cursor } : {}),
  };
  const [{ query, errors, rows, nextCursor }, targets] = await Promise.all([
    searchLeads(ctx, params),
    assignmentTargets(ctx),
  ]);
  const errorList = Object.values(errors);
  const base = (c: string | null) => {
    const q = leadQueryString({ ...query, owner: null, sort: 'newest' }, c);
    return `/app/leads/queue${q}` as '/app/leads/queue';
  };

  return (
    <>
      <PageHeader
        title="Unassigned queue"
        description="Leads without an owner, oldest first. Leads owned by a suspended or removed person are not here: reassign them from the lead list."
      />
      <Card>
        <form method="get" className="mb-4 flex flex-wrap items-end gap-2">
          <Field label="Team queue" htmlFor="q-team">
            <Select id="q-team" name="team" defaultValue={team ?? ''}>
              <option value="">{targets.orgQueue ? 'All queues' : 'All my teams'}</option>
              {targets.teams.map((t) => (
                <option key={t.id} value={t.id}>
                  {t.name}
                </option>
              ))}
            </Select>
          </Field>
          <button type="submit" className="rounded-md border border-slate-300 px-3 py-2 text-sm">
            Show
          </button>
        </form>
        {errorList.length > 0 ? (
          <Alert tone="error">{errorList.join(' ')}</Alert>
        ) : rows.length === 0 ? (
          <EmptyState>{query.cursor ? 'No more leads.' : 'The queue is empty.'}</EmptyState>
        ) : (
          <BulkAssignForm
            targets={[
              ...targets.people.map((p) => ({ value: `user:${p.userId}`, label: p.name })),
              ...targets.teams.map((t) => ({ value: `team:${t.id}`, label: `${t.name} queue` })),
            ]}
            teams={targets.teams.map((t) => ({ value: t.id, label: t.name }))}
          >
            <div className="overflow-x-auto">
              <table className="min-w-full text-left text-sm">
                <thead className="border-b text-xs uppercase text-slate-500">
                  <tr>
                    <th className="py-2 pr-2">
                      <span className="sr-only">Select</span>
                    </th>
                    <th className="py-2 pr-4">Lead</th>
                    <th className="py-2 pr-4">Stage</th>
                    <th className="py-2 pr-4">Queue</th>
                    <th className="py-2 pr-4">Age</th>
                    <th className="py-2">Created</th>
                  </tr>
                </thead>
                <tbody className="divide-y divide-slate-100">
                  {rows.map((l) => (
                    <tr key={l.id}>
                      <td className="py-2 pr-2">
                        <input
                          type="checkbox"
                          name="leadId"
                          value={l.id}
                          aria-label={`Select ${l.fullName}`}
                        />
                      </td>
                      <td className="py-2 pr-4">
                        <Link
                          href={`/app/leads/${l.id}` as '/app/leads'}
                          className="font-medium text-blue-900 underline-offset-2 hover:underline"
                        >
                          {l.fullName}
                        </Link>
                      </td>
                      <td className="py-2 pr-4">
                        <Badge>{STAGE_LABELS[l.stage]}</Badge>
                      </td>
                      <td className="py-2 pr-4">{l.teamName ?? 'Organisation'}</td>
                      <td className="py-2 pr-4">{age(l.createdAt)}</td>
                      <td className="whitespace-nowrap py-2">{fmtDateTime(l.createdAt)}</td>
                    </tr>
                  ))}
                </tbody>
              </table>
            </div>
          </BulkAssignForm>
        )}
        {errorList.length === 0 && (query.cursor || nextCursor) && (
          <nav aria-label="Pages" className="mt-4 flex justify-between text-sm">
            {query.cursor ? (
              <Link href={base(null)} className="underline">
                ← First page
              </Link>
            ) : (
              <span />
            )}
            {nextCursor && (
              <Link href={base(nextCursor)} className="underline">
                Next page →
              </Link>
            )}
          </nav>
        )}
      </Card>
    </>
  );
}
