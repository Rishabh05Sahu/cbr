// FR-151/152 site-visit rules (ADR-0022), free of the database so they can be unit tested. The
// same transitions are enforced by site_visit_guard (migration 0026).

export const VISIT_STATUSES = [
  'SCHEDULED',
  'CONFIRMED',
  'RESCHEDULED',
  'CANCELLED',
  'ATTENDED',
  'NO_SHOW',
] as const;
export type VisitStatus = (typeof VISIT_STATUSES)[number];
export const OPEN_VISIT_STATUSES = ['SCHEDULED', 'CONFIRMED', 'RESCHEDULED'] as const;
export const INTEREST_LEVELS = ['HIGH', 'MEDIUM', 'LOW', 'NONE'] as const;
export type InterestLevel = (typeof INTEREST_LEVELS)[number];
export const VISIT_ACTIONS = ['confirm', 'reschedule', 'cancel', 'no_show', 'attended'] as const;
export type VisitAction = (typeof VISIT_ACTIONS)[number];
export const MAX_OBJECTIONS = 20;

export const VISIT_LABELS: Record<string, string> = {
  SCHEDULED: 'Scheduled',
  CONFIRMED: 'Confirmed',
  RESCHEDULED: 'Rescheduled',
  CANCELLED: 'Cancelled',
  ATTENDED: 'Attended',
  NO_SHOW: 'No-show',
  HIGH: 'High',
  MEDIUM: 'Medium',
  LOW: 'Low',
  NONE: 'None',
};

const TARGET: Record<VisitAction, VisitStatus> = {
  confirm: 'CONFIRMED',
  reschedule: 'RESCHEDULED',
  cancel: 'CANCELLED',
  no_show: 'NO_SHOW',
  attended: 'ATTENDED',
};
export const targetOf = (a: VisitAction): VisitStatus => TARGET[a];

export const isOpen = (s: string) => (OPEN_VISIT_STATUSES as readonly string[]).includes(s);

/**
 * Why `action` is not allowed on a visit in `status` (null when allowed). An open visit may be
 * confirmed (unless already confirmed), rescheduled, cancelled, or closed as attended or no-show;
 * a closed visit (cancelled, attended, no-show) never changes.
 */
export function transitionProblem(status: VisitStatus, action: VisitAction): string | null {
  if (!isOpen(status)) return `This visit is already ${VISIT_LABELS[status]!.toLowerCase()}`;
  if (action === 'confirm' && status === 'CONFIRMED') return 'This visit is already confirmed';
  return null;
}

/**
 * Attended and no-show describe what happened, so they are recorded from the visit's own day
 * (org-local) onwards, not before. `today` and `visitDay` are org-local YYYY-MM-DD keys.
 */
export const outcomeTooEarly = (visitDay: string, today: string) => today < visitDay;

/** Objections from a comma- or newline-separated list: trimmed, distinct (case-insensitive). */
export function parseObjections(raw: string | undefined): string[] {
  const seen = new Set<string>();
  const out: string[] = [];
  for (const part of (raw ?? '').split(/[,\n]/)) {
    const o = part.replace(/\s+/g, ' ').trim();
    if (o && !seen.has(o.toLowerCase())) {
      seen.add(o.toLowerCase());
      out.push(o);
    }
  }
  return out;
}
