// A site visit assigned to the signed-in member, as My Day and the calendar list it (owner decision
// 2026-10-30): time, status, the lead (a link only within their lead scope, otherwise its name) and
// the meeting point. Read-only: visits are changed on the lead's page. No call or message links.
import Link from 'next/link';
import { Badge } from '@/components/ui';
import { VISIT_LABELS, type AssignedVisit } from '@/modules/visits';

const time = (d: Date) =>
  d.toLocaleTimeString('en-IN', { hour: 'numeric', minute: '2-digit', timeZone: 'Asia/Kolkata' });
const dateTime = (d: Date) =>
  d.toLocaleString('en-IN', {
    day: 'numeric',
    month: 'short',
    hour: 'numeric',
    minute: '2-digit',
    timeZone: 'Asia/Kolkata',
  });

export function VisitEntry({ v, withDate = false }: { v: AssignedVisit; withDate?: boolean }) {
  return (
    <li className="space-y-1 py-2 text-sm" data-testid="assigned-visit">
      <div className="flex flex-wrap items-center gap-x-2 gap-y-1">
        <span className="font-medium text-slate-900">
          {withDate ? dateTime(v.scheduledFor) : time(v.scheduledFor)}
        </span>
        <Badge>Site visit</Badge>
        {v.status !== 'SCHEDULED' && <Badge>{VISIT_LABELS[v.status]}</Badge>}
        {v.pastDue && <Badge tone="warn">Outcome due</Badge>}
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
      </p>
      <p className="text-xs text-slate-700">Meeting point: {v.location}</p>
    </li>
  );
}
