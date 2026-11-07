// KPI catalogue for the Phase 4 dashboards (FR-130–133, ADR-0023): the metrics-and-kpis.md
// definitions K01–K13 and K18–K20, with each KPI's lens, and the ones that cannot be computed
// honestly yet (shown as "—" with the reason, never as zero). Free of the database.

/** metrics-and-kpis §1.4 maturity windows (OD-02 open: provisional defaults, no targets). */
export const COHORT_WINDOW_DAYS = 30;
/** §4: ratios with a denominator below this are greyed "Low sample". */
export const LOW_SAMPLE = 20;
/** K19b: a follow-up done within due + this grace counts as on time (§3 default 1 h). */
export const FOLLOW_UP_GRACE_MS = 3_600_000;
/** §2 "Short spells": shorter than this and ended without the user's interaction are excluded. */
export const SHORT_SPELL_MS = 24 * 3_600_000;
/** K20: a cancelled task with this reason leaves the denominator (§3). */
export const NO_LONGER_RELEVANT = 'no longer relevant';

export type Lens = 'Activity' | 'Snapshot' | 'Cohort';

export interface KpiDef {
  id: string;
  code: string;
  name: string;
  lens: Lens;
  kind: 'count' | 'ratio';
  /** What the tile counts, in one line (shown on the tile and the drill-down). */
  description: string;
  /** Set when the KPI cannot be computed honestly with today's data. */
  unavailable?: string;
}

const CALL_INTENTS =
  'Needs call-button taps (CallIntent), which come with the call launchers (FR-080–082), blocked by legal gate G5.';
const PROVIDER = 'Needs provider call data (Phase 6 integrations), not available yet.';
const LEAVE =
  'Needs working hours and approved leave, which are not implemented yet (Phase 4 leave).';

export const KPIS: readonly KpiDef[] = [
  {
    id: 'k01',
    code: 'K01',
    name: 'Leads received',
    lens: 'Activity',
    kind: 'count',
    description: 'Enquiries received in the period (repeat enquiries included).',
  },
  {
    id: 'k01-new',
    code: 'K01',
    name: 'New unique leads',
    lens: 'Activity',
    kind: 'count',
    description: 'Leads created in the period.',
  },
  {
    id: 'k02',
    code: 'K02',
    name: 'Leads assigned',
    lens: 'Activity',
    kind: 'count',
    description:
      'Assignment spells started in the period (merge moves excluded); organisation view: distinct leads.',
  },
  {
    id: 'k03',
    code: 'K03',
    name: 'Leads unassigned now',
    lens: 'Snapshot',
    kind: 'count',
    description: 'Open leads without an owner right now (ignores the period).',
  },
  {
    id: 'k04',
    code: 'K04',
    name: 'Call-button taps',
    lens: 'Activity',
    kind: 'count',
    description: 'Call intents (taps).',
    unavailable: CALL_INTENTS,
  },
  {
    id: 'k05',
    code: 'K05',
    name: 'Logged call attempts',
    lens: 'Activity',
    kind: 'count',
    description:
      'Self-reported phone and WhatsApp call interactions in the period, by who logged them.',
  },
  {
    id: 'k06',
    code: 'K06',
    name: 'Provider-confirmed call attempts',
    lens: 'Activity',
    kind: 'count',
    description: 'Calls confirmed by a telephony provider.',
    unavailable: PROVIDER,
  },
  {
    id: 'k07',
    code: 'K07',
    name: 'Connected (self-reported)',
    lens: 'Activity',
    kind: 'count',
    description: 'Self-reported interactions with a connected outcome in the period.',
  },
  {
    id: 'k07-provider',
    code: 'K07',
    name: 'Connected (provider-verified)',
    lens: 'Activity',
    kind: 'count',
    description: 'Provider-verified connected calls.',
    unavailable: PROVIDER,
  },
  {
    id: 'k08',
    code: 'K08',
    name: 'Call connection rate (self-reported)',
    lens: 'Activity',
    kind: 'ratio',
    description: 'Connected outcomes among the logged call attempts (K05), self-reported only.',
  },
  {
    id: 'k08-provider',
    code: 'K08',
    name: 'Call connection rate (provider)',
    lens: 'Activity',
    kind: 'ratio',
    description: 'Provider-verified connection rate.',
    unavailable: PROVIDER,
  },
  {
    id: 'k08b',
    code: 'K08b',
    name: 'Outcome logging rate',
    lens: 'Activity',
    kind: 'ratio',
    description: 'Call taps followed by a logged interaction within 2 h.',
    unavailable: CALL_INTENTS,
  },
  {
    id: 'k09',
    code: 'K09',
    name: 'Leads contacted',
    lens: 'Cohort',
    kind: 'ratio',
    description: `Cohort leads first contacted within ${COHORT_WINDOW_DAYS} days of entry (matured only).`,
  },
  {
    id: 'k09b',
    code: 'K09b',
    name: 'First-contact time',
    lens: 'Cohort',
    kind: 'count',
    description: 'Median working hours from assignment to first contact.',
    unavailable: LEAVE,
  },
  {
    id: 'k10',
    code: 'K10',
    name: 'Qualified leads',
    lens: 'Activity',
    kind: 'count',
    description: 'Leads first qualified in the period, credited to the owner at that moment.',
  },
  {
    id: 'k10-cohort',
    code: 'K10',
    name: 'Qualified (cohort)',
    lens: 'Cohort',
    kind: 'ratio',
    description: `Cohort leads qualified within ${COHORT_WINDOW_DAYS} days of entry (matured only).`,
  },
  {
    id: 'k11',
    code: 'K11',
    name: 'Site visits scheduled',
    lens: 'Activity',
    kind: 'count',
    description: 'Site visits created in the period, by who scheduled them.',
  },
  {
    id: 'k12',
    code: 'K12',
    name: 'Site visits completed',
    lens: 'Activity',
    kind: 'count',
    description: 'Site visits attended in the period, credited to the assigned salesperson.',
  },
  {
    id: 'k12b',
    code: 'K12b',
    name: 'Visit show-up rate',
    lens: 'Activity',
    kind: 'ratio',
    description: 'Attended / (attended + no-show + customer-cancelled within 24 h).',
    unavailable:
      'Needs to know which cancellations the customer made; visits do not record who cancelled yet.',
  },
  {
    id: 'k13',
    code: 'K13',
    name: 'Lead-to-site-visit conversion',
    lens: 'Cohort',
    kind: 'ratio',
    description: `Cohort leads with a completed visit within ${COHORT_WINDOW_DAYS} days of entry (matured only).`,
  },
  {
    id: 'k18',
    code: 'K18',
    name: 'Follow-ups due',
    lens: 'Activity',
    kind: 'count',
    description: 'Open or completed follow-ups due in the period, credited to their assignee.',
  },
  {
    id: 'k19',
    code: 'K19',
    name: 'Overdue follow-ups',
    lens: 'Snapshot',
    kind: 'count',
    description:
      'Open follow-ups overdue by more than the grace period, with an "on leave" column.',
    unavailable: LEAVE,
  },
  {
    id: 'k19b',
    code: 'K19b',
    name: 'Follow-up timeliness',
    lens: 'Activity',
    kind: 'ratio',
    description: 'Follow-ups due in the period (K18) completed within 1 hour of their due time.',
  },
  {
    id: 'k20',
    code: 'K20',
    name: 'Task completion rate',
    lens: 'Activity',
    kind: 'ratio',
    description:
      'Tasks due in the period that are done, excluding tasks cancelled as "No longer relevant".',
  },
];

export const kpiById = (id: string) => KPIS.find((k) => k.id === id) ?? null;

export interface RatioValue {
  numerator: number;
  denominator: number;
  /** Below LOW_SAMPLE: shown greyed as "Low sample". */
  lowSample: boolean;
  /** Cohort only: entries still inside their maturity window (not in the ratio). */
  inProgress?: number;
  /** Cohort only: Invalid-number leads left out of the denominator, reported separately. */
  invalid?: number;
}

export const ratio = (
  numerator: number,
  denominator: number,
  extra: Pick<RatioValue, 'inProgress' | 'invalid'> = {},
): RatioValue => ({ numerator, denominator, lowSample: denominator < LOW_SAMPLE, ...extra });

/** "45%" or "—" for an empty denominator. */
export const percent = (r: RatioValue) =>
  r.denominator === 0 ? '—' : `${Math.round((r.numerator / r.denominator) * 100)}%`;
