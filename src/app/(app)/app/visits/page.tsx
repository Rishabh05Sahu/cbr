import Link from 'next/link';
import { Badge, Card, EmptyState, PageHeader } from '@/components/ui';
import { myVisits, type VisitView } from '@/modules/visits';
import { pageContext, pageRequire } from '@/platform/auth/session';
import { VisitRow } from '../leads/[id]/visit-row';

/**
 * FR-150–152: the site visits the signed-in member can see: on leads in their scope, and visits
 * assigned to them (§4.3 "S + assigned visits"). Open visits are split into outcome due (the time
 * has passed), today and upcoming; then recent closed ones. Visits on leads the person may manage
 * can be confirmed, rescheduled, cancelled and closed here, as on the lead's page (the server
 * re-checks everything). An assigned agent without lead access sees the visit and the lead's name.
 */
export default async function VisitsPage() {
  const { ctx } = await pageContext();
  pageRequire(ctx, 'site_visit.read');
  const { open, closed } = await myVisits(ctx);
  const { due, today, upcoming } = splitOpen(open, new Date());
  return (
    <>
      <PageHeader
        title="Site visits"
        description="Your visits and visits on your leads. Times are in your organisation's time zone."
      />
      <div className="space-y-6">
        {due.length > 0 && (
          <Section
            id="visits-due"
            title="Outcome due"
            tone="warn"
            hint="The visit time has passed. Record whether it happened."
            visits={due}
          />
        )}
        <Section id="visits-today" title="Today" visits={today} empty="No more visits today." />
        <Section
          id="visits-upcoming"
          title="Upcoming"
          visits={upcoming}
          empty="No upcoming site visits. Schedule one from a lead's page."
        />
        {closed.length > 0 && (
          <Section id="visits-closed" title="Recently closed" visits={closed} />
        )}
      </div>
    </>
  );
}

/** Open visits: time passed and outcome due / later today / after today. */
function splitOpen(open: VisitView[], now: Date) {
  const due: VisitView[] = [];
  const today: VisitView[] = [];
  const upcoming: VisitView[] = [];
  for (const v of open) {
    if (!v.outcomeDue) upcoming.push(v);
    else if (v.scheduledFor <= now) due.push(v);
    else today.push(v);
  }
  return { due, today, upcoming };
}

function Section({
  id,
  title,
  visits,
  empty,
  hint,
  tone,
}: {
  id: string;
  title: string;
  visits: VisitView[];
  empty?: string;
  hint?: string;
  tone?: 'warn';
}) {
  return (
    <section aria-labelledby={id} className="space-y-2">
      <h2 id={id} className="flex items-center gap-2 text-base font-semibold text-slate-900">
        {title} <Badge {...(tone ? { tone } : {})}>{visits.length}</Badge>
      </h2>
      {hint && <p className="text-sm text-slate-600">{hint}</p>}
      <Card>
        {visits.length === 0 ? (
          <EmptyState>{empty}</EmptyState>
        ) : (
          <ul className="divide-y divide-slate-100">
            {visits.map((v) => (
              <Item key={v.id} v={v} />
            ))}
          </ul>
        )}
      </Card>
    </section>
  );
}

function Item({ v }: { v: VisitView }) {
  return (
    <li className="py-1" data-testid="visits-item">
      <p className="pt-2 text-sm">
        {v.lead ? (
          <Link
            href={`/app/leads/${v.lead.id}` as '/app/leads'}
            className="tap font-semibold text-blue-900 underline-offset-2 hover:underline"
          >
            {v.lead.fullName}
          </Link>
        ) : (
          <span className="font-semibold text-slate-900">{v.leadName}</span>
        )}
      </p>
      <ul>
        <VisitRow visit={v} leadId={v.lead?.id ?? ''} />
      </ul>
    </li>
  );
}
