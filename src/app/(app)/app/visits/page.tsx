import Link from 'next/link';
import { Badge, Card, EmptyState, PageHeader } from '@/components/ui';
import { myVisits, VISIT_LABELS, type VisitView } from '@/modules/visits';
import { pageContext, pageRequire } from '@/platform/auth/session';
import { fmtDateTime } from '../leads/labels';

/**
 * FR-150–152: the site visits the signed-in member can see: on leads in their scope, and visits
 * assigned to them (§4.3 "S + assigned visits"). Open visits by time, then recent closed ones.
 * Visits are changed on the lead's page; an assigned agent without lead access sees the visit and
 * the lead's name only.
 */
export default async function VisitsPage() {
  const { ctx } = await pageContext();
  pageRequire(ctx, 'site_visit.read');
  const { open, closed } = await myVisits(ctx);
  return (
    <>
      <PageHeader
        title="Site visits"
        description="Upcoming and recent visits on your leads and visits assigned to you. Record what happened on the lead's page."
      />
      <section aria-labelledby="visits-open" className="space-y-2">
        <h2
          id="visits-open"
          className="flex items-center gap-2 text-base font-semibold text-slate-900"
        >
          Open <Badge>{open.length}</Badge>
        </h2>
        <Card>
          {open.length === 0 ? (
            <EmptyState>No open site visits.</EmptyState>
          ) : (
            <ul className="divide-y divide-slate-100">
              {open.map((v) => (
                <Item key={v.id} v={v} />
              ))}
            </ul>
          )}
        </Card>
      </section>
      {closed.length > 0 && (
        <section aria-labelledby="visits-closed" className="mt-6 space-y-2">
          <h2 id="visits-closed" className="text-base font-semibold text-slate-900">
            Recently closed
          </h2>
          <Card>
            <ul className="divide-y divide-slate-100">
              {closed.map((v) => (
                <Item key={v.id} v={v} />
              ))}
            </ul>
          </Card>
        </section>
      )}
    </>
  );
}

function Item({ v }: { v: VisitView }) {
  const due = v.outcomeDue && ['SCHEDULED', 'CONFIRMED', 'RESCHEDULED'].includes(v.status);
  return (
    <li className="space-y-1 py-3 text-sm" data-testid="visits-item">
      <div className="flex flex-wrap items-center gap-2">
        <span className="font-medium text-slate-900">{fmtDateTime(v.scheduledFor)}</span>
        <Badge
          tone={
            v.status === 'ATTENDED'
              ? 'good'
              : v.status === 'CANCELLED' || v.status === 'NO_SHOW'
                ? 'warn'
                : 'neutral'
          }
        >
          {VISIT_LABELS[v.status]}
        </Badge>
        {due && <Badge tone="warn">Outcome due</Badge>}
      </div>
      <p>
        {v.lead ? (
          <Link
            href={`/app/leads/${v.lead.id}` as '/app/leads'}
            className="tap font-medium text-blue-900 underline-offset-2 hover:underline"
          >
            {v.lead.fullName}
          </Link>
        ) : (
          <span className="font-medium text-slate-900">{v.leadName}</span>
        )}
        <span className="text-slate-600"> · with {v.assigneeName}</span>
      </p>
      <p className="text-slate-700">Meeting point: {v.location}</p>
    </li>
  );
}
