// The record sets behind every dashboard tile (ADR-0023, metrics-and-kpis §5: "Tiles and
// drill-downs call the same function, so their counts match by construction"). Each definition
// builds ONE SQL row set; the tile counts it and the drill-down lists it. Values are always bound
// parameters ($n); only fixed identifiers are written into the text. Free of the database.
//
// Row set columns: rec_id, lead_id (the lead counted, after merges), user_id (who gets the
// credit), at (the event time), num (counts towards a ratio's numerator), bucket ('final' |
// 'in_progress' | 'invalid' for cohorts, otherwise 'final') and extra (e.g. the lead's stage).
import {
  COHORT_WINDOW_DAYS,
  FOLLOW_UP_GRACE_MS,
  NO_LONGER_RELEVANT,
  SHORT_SPELL_MS,
} from './definitions';

export type ReportScope = 'OWN' | 'TEAM' | 'ORG';

/** Everything a definition needs, already validated against the viewer's scope. */
export interface Frame {
  orgId: string;
  scope: ReportScope;
  me: string;
  /** TEAM scope: teams the viewer leads and the current members of those teams (plus the viewer). */
  ledTeamIds: string[];
  teamMemberIds: string[];
  from: Date;
  to: Date;
  now: Date;
  /** Org-local today as [start, end) instants (operational tiles). */
  todayFrom: Date;
  todayTo: Date;
  teamId: string | null;
  userId: string | null;
  sourceId: string | null;
  /** Per-member breakdowns: count per person (spells and spell cohorts), never distinct leads. */
  perUser?: boolean;
}

export class Params {
  readonly values: unknown[] = [];
  p(v: unknown, cast = ''): string {
    this.values.push(v);
    return `$${this.values.length}${cast}`;
  }
}

const RECORD_COLUMNS = 'rec_id, lead_id, user_id, at, num, bucket, extra';

/** The viewer's lead scope (user-personas-and-roles §2.2, same rule as leads.scopeFilter). */
function leadScope(q: Params, f: Frame, l: string): string {
  if (f.scope === 'ORG') return 'TRUE';
  if (f.scope === 'OWN' || !f.ledTeamIds.length)
    return `${l}.owner_user_id = ${q.p(f.me, '::uuid')}`;
  return `(${l}.owner_user_id = ${q.p(f.me, '::uuid')} OR ${l}.team_id = ANY(${q.p(
    f.ledTeamIds,
    '::uuid[]',
  )}) OR ${l}.owner_user_id = ANY(${q.p(f.teamMemberIds, '::uuid[]')}))`;
}

/**
 * §1.6 exclusions and §1.3 scope on the counted lead: not deleted, not a test lead, not merged
 * away, inside the viewer's lead scope (a figure never covers records the viewer cannot open),
 * and the source filter (the lead's first-touch source).
 */
function leadOk(q: Params, f: Frame, l: string, source = `${l}.source_id`): string {
  const parts = [
    `${l}.org_id = ${q.p(f.orgId, '::uuid')}`,
    `${l}.deleted_at IS NULL`,
    `NOT ${l}.is_test`,
    `${l}.merged_into_lead_id IS NULL`,
    leadScope(q, f, l),
  ];
  if (f.sourceId) parts.push(`${source} = ${q.p(f.sourceId, '::uuid')}`);
  return parts.join(' AND ');
}

/** Lead-based tiles: the user and team filters apply to the lead's current owner and team. */
function leadPeople(q: Params, f: Frame, l: string, opts: { user?: boolean } = {}): string {
  const parts: string[] = [];
  if (f.userId && opts.user !== false)
    parts.push(`${l}.owner_user_id = ${q.p(f.userId, '::uuid')}`);
  if (f.teamId) parts.push(`${l}.team_id = ${q.p(f.teamId, '::uuid')}`);
  return parts.length ? parts.join(' AND ') : 'TRUE';
}

/**
 * People-credited tiles (§2): the credited user must be in the viewer's people scope (OWN: the
 * viewer; TEAM: members of led teams and the viewer; ORG: anyone) and match the user filter. The
 * team filter uses the team at the time: the spell's team where the row has one (`teamCol`),
 * otherwise the credited user's team membership at `at`.
 */
function credit(q: Params, f: Frame, user: string, at: string, teamCol?: string): string {
  const parts: string[] = [];
  if (f.scope === 'OWN') parts.push(`${user} = ${q.p(f.me, '::uuid')}`);
  if (f.scope === 'TEAM')
    parts.push(`${user} = ANY(${q.p([f.me, ...f.teamMemberIds], '::uuid[]')})`);
  if (f.userId) parts.push(`${user} = ${q.p(f.userId, '::uuid')}`);
  if (f.teamId)
    parts.push(
      teamCol
        ? `${teamCol} = ${q.p(f.teamId, '::uuid')}`
        : `EXISTS (SELECT 1 FROM team_membership tm
             JOIN organization_membership om ON om.id = tm.membership_id
            WHERE om.user_id = ${user} AND tm.team_id = ${q.p(f.teamId, '::uuid')}
              AND tm.started_at <= ${at} AND (tm.ended_at IS NULL OR tm.ended_at > ${at}))`,
    );
  return parts.length ? parts.join(' AND ') : 'TRUE';
}
const creditNeeded = (f: Frame) => f.scope !== 'ORG' || !!f.userId || !!f.teamId || !!f.perUser;

/** A child record's lead after merges: one level (a merged lead's survivor). */
const EFFECTIVE = (x: string) =>
  `JOIN lead r0 ON r0.id = ${x}.lead_id JOIN lead l ON l.id = COALESCE(r0.merged_into_lead_id, r0.id)`;

const inPeriod = (q: Params, f: Frame, col: string) =>
  `${col} >= ${q.p(f.from, '::timestamptz')} AND ${col} < ${q.p(f.to, '::timestamptz')}`;

type Builder = (q: Params, f: Frame) => string;

const CALL_CHANNELS = `('PHONE_NATIVE', 'WHATSAPP_APP_CALL')`;

function interactions(q: Params, f: Frame, connectedOnly: boolean): string {
  return `SELECT x.id AS rec_id, l.id AS lead_id, x.user_id, x.occurred_at AS at,
      x.outcome_group = 'CONNECTED' AS num, 'final' AS bucket, x.outcome AS extra
    FROM interaction x ${EFFECTIVE('x')}
   WHERE x.source = 'MANUAL' AND ${
     connectedOnly ? `x.outcome_group = 'CONNECTED'` : `x.channel IN ${CALL_CHANNELS}`
   }
     AND ${inPeriod(q, f, 'x.occurred_at')} AND ${leadOk(q, f, 'l')}
     AND ${credit(q, f, 'x.user_id', 'x.occurred_at')}`;
}

/** Self-reported interactions on some channels (the K05 phone / WhatsApp split). */
function interactionsOn(q: Params, f: Frame, channels: string): string {
  return `SELECT x.id AS rec_id, l.id AS lead_id, x.user_id, x.occurred_at AS at,
      x.outcome_group = 'CONNECTED' AS num, 'final' AS bucket, x.channel AS extra
    FROM interaction x ${EFFECTIVE('x')}
   WHERE x.source = 'MANUAL' AND x.channel IN ${channels}
     AND ${inPeriod(q, f, 'x.occurred_at')} AND ${leadOk(q, f, 'l')}
     AND ${credit(q, f, 'x.user_id', 'x.occurred_at')}`;
}

/**
 * K04 / K08b (FR-080/081, migration 0028): Call and WhatsApp taps in the period, credited to who
 * tapped. num (K08b) = the same person logged an interaction on the same lead within 2 h after the
 * tap (metrics-and-kpis K08b). A tap is never counted as a call.
 */
function taps(q: Params, f: Frame, channel: string | null): string {
  return `SELECT x.id AS rec_id, l.id AS lead_id, x.user_id, x.created_at AS at,
      EXISTS (SELECT 1 FROM interaction i
               WHERE i.lead_id = x.lead_id AND i.user_id = x.user_id
                 AND i.logged_at >= x.created_at
                 AND i.logged_at <= x.created_at + ${q.p('2 hours', '::interval')}) AS num,
      'final' AS bucket,
      CASE x.channel WHEN 'PHONE_NATIVE' THEN 'CALL_BUTTON' ELSE 'WHATSAPP_BUTTON' END AS extra
    FROM call_intent x ${EFFECTIVE('x')}
   WHERE ${channel ? `x.channel = ${q.p(channel)} AND ` : ''}${inPeriod(q, f, 'x.created_at')}
     AND ${leadOk(q, f, 'l')} AND ${credit(q, f, 'x.user_id', 'x.created_at')}`;
}

function followUps(q: Params, f: Frame): string {
  return `SELECT x.id AS rec_id, l.id AS lead_id, x.assignee_user_id AS user_id, x.due_at AS at,
      (x.status = 'DONE' AND x.completed_at <= x.due_at + ${q.p(
        `${FOLLOW_UP_GRACE_MS} milliseconds`,
        '::interval',
      )}) AS num, 'final' AS bucket, x.status AS extra
    FROM task x ${EFFECTIVE('x')}
   WHERE x.type = 'FOLLOW_UP' AND x.status IN ('OPEN', 'DONE') AND ${inPeriod(q, f, 'x.due_at')}
     AND ${leadOk(q, f, 'l')} AND ${credit(q, f, 'x.assignee_user_id', 'x.due_at')}`;
}

/** Tasks with or without a lead (K20 and the operational task tiles). */
function tasks(q: Params, f: Frame, where: string, num: string): string {
  return `SELECT x.id AS rec_id, l.id AS lead_id, x.assignee_user_id AS user_id, x.due_at AS at,
      ${num} AS num, 'final' AS bucket, x.type AS extra
    FROM task x LEFT JOIN lead r0 ON r0.id = x.lead_id
         LEFT JOIN lead l ON l.id = COALESCE(r0.merged_into_lead_id, r0.id)
   WHERE x.org_id = ${q.p(f.orgId, '::uuid')} AND ${where}
     AND (${f.sourceId ? 'FALSE' : 'x.lead_id IS NULL'} OR (l.id IS NOT NULL AND ${leadOk(
       q,
       f,
       'l',
     )}))
     AND ${credit(q, f, 'x.assignee_user_id', 'x.due_at')}`;
}

/**
 * Cohort lens (§1.4–1.5, §2). Organisation view (ORG scope, no user or team filter): leads created
 * in the period, each once. Otherwise: assignment spells of people in scope started in the period
 * (merge moves and §2 short spells excluded). A member is final once entry + window has passed;
 * Invalid-number leads leave the denominator and are reported separately (§1.6).
 */
function cohort(q: Params, f: Frame, milestone: string): string {
  const w = q.p(`${COHORT_WINDOW_DAYS} days`, '::interval');
  const now = q.p(f.now, '::timestamptz');
  const cols = (
    entry: string,
  ) => `l.${milestone} IS NOT NULL AND l.${milestone} <= ${entry} + ${w} AS num,
      CASE WHEN ${entry} + ${w} > ${now} THEN 'in_progress'
           WHEN l.contact_status = 'INVALID' THEN 'invalid' ELSE 'final' END AS bucket,
      l.stage::text AS extra`;
  if (!creditNeeded(f))
    return `SELECT l.id AS rec_id, l.id AS lead_id, l.owner_user_id AS user_id, l.created_at AS at,
        ${cols('l.created_at')}
      FROM lead l WHERE ${inPeriod(q, f, 'l.created_at')} AND ${leadOk(q, f, 'l')}`;
  const shortSpell = q.p(`${SHORT_SPELL_MS} milliseconds`, '::interval');
  return `SELECT s.id AS rec_id, l.id AS lead_id, s.user_id, s.started_at AS at, ${cols('s.started_at')}
    FROM lead_assignment_history s ${EFFECTIVE('s')}
   WHERE s.user_id IS NOT NULL AND s.source <> 'MERGE' AND ${inPeriod(q, f, 's.started_at')}
     AND NOT (s.ended_at IS NOT NULL AND s.ended_at - s.started_at < ${shortSpell}
              AND NOT EXISTS (SELECT 1 FROM interaction i
                               WHERE i.lead_id = s.lead_id AND i.user_id = s.user_id
                                 AND i.occurred_at >= s.started_at AND i.occurred_at < s.ended_at))
     AND ${leadOk(q, f, 'l')} AND ${credit(q, f, 's.user_id', 's.started_at', 's.team_id')}`;
}

export const BUILDERS: Record<string, Builder> = {
  k01: (q, f) => `SELECT x.id AS rec_id, l.id AS lead_id, l.owner_user_id AS user_id,
      x.received_at AS at, TRUE AS num, 'final' AS bucket, NULL::text AS extra
    FROM lead_enquiry x ${EFFECTIVE('x')}
   WHERE ${inPeriod(q, f, 'x.received_at')} AND ${leadOk(q, f, 'l', 'x.source_id')}
     AND ${leadPeople(q, f, 'l')}`,
  'k01-new': (q, f) => `SELECT l.id AS rec_id, l.id AS lead_id, l.owner_user_id AS user_id,
      l.created_at AS at, TRUE AS num, 'final' AS bucket, l.stage::text AS extra
    FROM lead l WHERE ${inPeriod(q, f, 'l.created_at')} AND ${leadOk(q, f, 'l')}
     AND ${leadPeople(q, f, 'l')}`,
  k02: (q, f) => {
    const spells = `SELECT s.id AS rec_id, l.id AS lead_id, s.user_id, s.started_at AS at,
        TRUE AS num, 'final' AS bucket, s.source AS extra
      FROM lead_assignment_history s ${EFFECTIVE('s')}
     WHERE s.user_id IS NOT NULL AND s.source <> 'MERGE' AND ${inPeriod(q, f, 's.started_at')}
       AND ${leadOk(q, f, 'l')} AND ${credit(q, f, 's.user_id', 's.started_at', 's.team_id')}`;
    // Organisation view: distinct leads (the first spell of each lead in the period).
    return creditNeeded(f)
      ? spells
      : `SELECT DISTINCT ON (lead_id) ${RECORD_COLUMNS} FROM (${spells}) d ORDER BY lead_id, at, rec_id`;
  },
  // Snapshot: ignores the period and the user filter (an unassigned lead has no user).
  k03: (q, f) => `SELECT l.id AS rec_id, l.id AS lead_id, NULL::uuid AS user_id,
      COALESCE((SELECT max(s.started_at) FROM lead_assignment_history s
                 WHERE s.lead_id = l.id AND s.ended_at IS NULL), l.created_at) AS at,
      TRUE AS num, 'final' AS bucket, l.stage::text AS extra
    FROM lead l
   WHERE l.owner_user_id IS NULL AND l.stage NOT IN ('WON', 'LOST') AND ${leadOk(q, f, 'l')}
     AND ${leadPeople(q, f, 'l', { user: false })}`,
  k04: (q, f) => taps(q, f, 'PHONE_NATIVE'),
  'k04-whatsapp': (q, f) => taps(q, f, 'WHATSAPP_APP'),
  k05: (q, f) => interactions(q, f, false),
  'k05-phone': (q, f) => interactionsOn(q, f, `('PHONE_NATIVE')`),
  'k05-whatsapp': (q, f) => interactionsOn(q, f, `('WHATSAPP_APP_CALL', 'WHATSAPP_APP_MESSAGE')`),
  k07: (q, f) => interactions(q, f, true),
  k08: (q, f) => interactions(q, f, false),
  k08b: (q, f) => taps(q, f, null),
  k09: (q, f) => cohort(q, f, 'first_contacted_at'),
  // Activity: credited to the owner whose spell contains the milestone (§2).
  k10: (q, f) => `SELECT l.id AS rec_id, l.id AS lead_id, s.user_id, l.qualified_at AS at,
      TRUE AS num, 'final' AS bucket, l.stage::text AS extra
    FROM lead l LEFT JOIN LATERAL (
      SELECT h.user_id, h.team_id FROM lead_assignment_history h
       WHERE h.lead_id = l.id AND h.user_id IS NOT NULL AND h.started_at <= l.qualified_at
         AND (h.ended_at IS NULL OR h.ended_at > l.qualified_at)
       ORDER BY h.started_at DESC LIMIT 1) s ON TRUE
   WHERE ${inPeriod(q, f, 'l.qualified_at')} AND ${leadOk(q, f, 'l')}
     AND ${creditNeeded(f) ? credit(q, f, 's.user_id', 'l.qualified_at', 's.team_id') : 'TRUE'}`,
  'k10-cohort': (q, f) => cohort(q, f, 'qualified_at'),
  k11: (q, f) => `SELECT x.id AS rec_id, l.id AS lead_id, x.scheduled_by AS user_id,
      x.created_at AS at, TRUE AS num, 'final' AS bucket, x.status AS extra
    FROM site_visit x ${EFFECTIVE('x')}
   WHERE ${inPeriod(q, f, 'x.created_at')} AND ${leadOk(q, f, 'l')}
     AND ${credit(q, f, 'x.scheduled_by', 'x.created_at')}`,
  k12: (q, f) => `SELECT x.id AS rec_id, l.id AS lead_id, x.assigned_user_id AS user_id,
      x.attended_at AS at, TRUE AS num, 'final' AS bucket, x.interest_level AS extra
    FROM site_visit x ${EFFECTIVE('x')}
   WHERE x.status = 'ATTENDED' AND ${inPeriod(q, f, 'x.attended_at')} AND ${leadOk(q, f, 'l')}
     AND ${credit(q, f, 'x.assigned_user_id', 'x.attended_at')}`,
  k13: (q, f) => cohort(q, f, 'first_visit_completed_at'),
  k18: followUps,
  k19b: followUps,
  k20: (q, f) =>
    tasks(
      q,
      f,
      `${inPeriod(q, f, 'x.due_at')} AND NOT (x.status = 'CANCELLED'
         AND lower(btrim(COALESCE(x.cancel_reason, ''))) = ${q.p(NO_LONGER_RELEVANT)})`,
      `x.status = 'DONE'`,
    ),

  // Operational tiles (FR-130 / FR-131), not KPIs: they ignore the period.
  'tasks-today': (q, f) =>
    tasks(
      q,
      f,
      `x.status = 'OPEN' AND x.due_at >= ${q.p(f.todayFrom, '::timestamptz')}
         AND x.due_at < ${q.p(f.todayTo, '::timestamptz')}`,
      'TRUE',
    ),
  'tasks-overdue': (q, f) =>
    tasks(q, f, `x.status = 'OPEN' AND x.due_at < ${q.p(f.now, '::timestamptz')}`, 'TRUE'),
  'follow-ups-overdue': (q, f) =>
    tasks(
      q,
      f,
      `x.type = 'FOLLOW_UP' AND x.status = 'OPEN' AND x.due_at < ${q.p(f.now, '::timestamptz')}`,
      'TRUE',
    ),
  'open-by-stage': (q, f) => `SELECT l.id AS rec_id, l.id AS lead_id, l.owner_user_id AS user_id,
      l.updated_at AS at, TRUE AS num, 'final' AS bucket, l.stage::text AS extra
    FROM lead l WHERE l.stage NOT IN ('WON', 'LOST') AND ${leadOk(q, f, 'l')}
     AND ${leadPeople(q, f, 'l')}`,
  'visits-upcoming': (
    q,
    f,
  ) => `SELECT x.id AS rec_id, l.id AS lead_id, x.assigned_user_id AS user_id,
      x.scheduled_for AS at, TRUE AS num, 'final' AS bucket, x.status AS extra
    FROM site_visit x ${EFFECTIVE('x')}
   WHERE x.status IN ('SCHEDULED', 'CONFIRMED', 'RESCHEDULED')
     AND x.scheduled_for >= ${q.p(f.now, '::timestamptz')}
     AND x.scheduled_for < ${q.p(f.now, '::timestamptz')} + interval '7 days'
     AND ${leadOk(q, f, 'l')}
     ${f.userId ? `AND x.assigned_user_id = ${q.p(f.userId, '::uuid')}` : ''}
     ${f.teamId ? `AND l.team_id = ${q.p(f.teamId, '::uuid')}` : ''}`,
};

/** Tile query: totals of one row set (ratio numerator, final denominator, cohort buckets). */
export function tileSql(id: string, f: Frame, stage?: string): { text: string; values: unknown[] } {
  const q = new Params();
  const rows = rowSet(q, id, f, stage);
  return {
    text: `SELECT count(*) FILTER (WHERE bucket = 'final')::int AS total,
        count(*) FILTER (WHERE bucket = 'final' AND num)::int AS hits,
        count(*) FILTER (WHERE bucket = 'in_progress')::int AS in_progress,
        count(*) FILTER (WHERE bucket = 'invalid')::int AS invalid,
        (percentile_cont(0.5) WITHIN GROUP (ORDER BY extract(epoch FROM ${q.p(
          f.now,
          '::timestamptz',
        )} - at)))::float8 AS median_age_s
      FROM (${rows}) r`,
    values: q.values,
  };
}

/** Per-member counts of a row set (FR-131 / FR-132 per-member table). */
export function byUserSql(id: string, f: Frame): { text: string; values: unknown[] } {
  const q = new Params();
  const rows = rowSet(q, id, f);
  return {
    text: `SELECT user_id, count(*) FILTER (WHERE bucket = 'final')::int AS total,
        count(*) FILTER (WHERE bucket = 'final' AND num)::int AS hits
      FROM (${rows}) r WHERE user_id IS NOT NULL GROUP BY user_id`,
    values: q.values,
  };
}

/** Open leads per stage (FR-130 "open leads by stage"). */
export function stageCountsSql(f: Frame): { text: string; values: unknown[] } {
  const q = new Params();
  const rows = rowSet(q, 'open-by-stage', f);
  return {
    text: `SELECT extra AS stage, count(*)::int AS total FROM (${rows}) r GROUP BY extra`,
    values: q.values,
  };
}

/** Drill-down: the same row set, listed (FR-133). */
export function listSql(
  id: string,
  f: Frame,
  page: { limit: number; offset: number },
  stage?: string,
): { text: string; values: unknown[] } {
  const q = new Params();
  const rows = rowSet(q, id, f, stage);
  return {
    text: `SELECT r.rec_id::text, r.lead_id::text, r.user_id::text, r.at, r.num, r.bucket, r.extra,
        l.full_name AS lead_name, l.stage::text AS lead_stage
      FROM (${rows}) r LEFT JOIN lead l ON l.id = r.lead_id
     ORDER BY r.at DESC, r.rec_id
     LIMIT ${q.p(page.limit, '::int')} OFFSET ${q.p(page.offset, '::int')}`,
    values: q.values,
  };
}

function rowSet(q: Params, id: string, f: Frame, stage?: string): string {
  const build = BUILDERS[id];
  if (!build) throw new Error(`Unknown report definition ${id}`);
  const rows = build(q, f);
  return stage ? `SELECT * FROM (${rows}) s WHERE s.extra = ${q.p(stage)}` : rows;
}
