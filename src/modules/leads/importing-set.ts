// Leads module: SET-BASED import batch commit (M6 prototype; docs/PHASE-2-M6-SET-BASED-IMPORT.md).
// Same outcomes and rows as the row-by-row commitImportBatch, in a constant number of statements
// per batch instead of ≈ 10 per row. Selected with strategy 'set'; the default stays 'row' until
// the design is reviewed. No new database object: every statement runs as crm_app inside the
// caller's tenant transaction, under the existing RLS and RESTRICTIVE insert policies.
//
// Order of work (design §3): phone locks (same keys and order as lockPhones) → done check →
// open matches → in-memory pass in file order (policy, custom fields, assignment, matches with
// leads created earlier in this batch) → e-mail locks (sorted) → returning customers → lead
// insert → e-mail cases → enquiries, stage history, spells, notes, activities, outbox.
import type { RequestContext } from '@/platform/authz';
import type { Tx } from '@/platform/db';
import { DomainError } from '@/platform/errors';
import { cleanText, invalid } from './access';
import { emitImportAssigned, type ImportAssigner } from './assignment';
import { checkCustomValues, lockedDefinitions } from './custom-field-commands';
import { customIssueField } from './custom-fields';
import { routeEnquiryForArchivedLead } from './hygiene';
import type { ImportRowInput, ImportRowOutcome } from './importing';
import { NOTE_EDIT_WINDOW_MS } from './write';

type Member = Extract<RequestContext, { kind: 'member' }>;

const CHANNEL_REF = 'IMPORT';
/** At most this many e-mail cases per new lead (detectEmailDuplicates). */
const MAX_EMAIL_CASES = 10;

/** A lead this row matches: an existing one, or one created by an earlier row of the batch. */
type MatchRef =
  | { kind: 'db'; id: string; archivedAt: Date | null; createdAt: Date }
  | { kind: 'batch'; row: number };

interface Creating {
  r: ImportRowInput;
  externalId: string;
  customFields: Record<string, unknown>;
  userId: string | null;
  teamId: string | null;
  stage: 'ASSIGNED' | 'NEW';
  note: string | null;
}

interface Attaching {
  r: ImportRowInput;
  externalId: string;
  match: MatchRef;
}

/** Takes transaction-scoped advisory locks on `keys`, in the given order, in one statement. */
async function lockKeys(tx: Tx, keys: string[]): Promise<void> {
  if (keys.length === 0) return;
  // The subquery fixes the order (OFFSET 0 keeps it from being flattened); the aggregate
  // consumes its rows in that order, one lock at a time.
  await tx.$queryRaw`
    SELECT count(pg_advisory_xact_lock(hashtextextended(k, 0)))::int AS n
      FROM (SELECT k FROM unnest(${keys}::text[]) WITH ORDINALITY AS t(k, n) ORDER BY n OFFSET 0) s`;
}

/** The lock keys and order of lockPhones (manual create and the row path use the same). */
export const phoneLockKeys = (orgId: string, phones: string[]) =>
  [...new Set(phones)].sort().map((p) => `lead-phone:${orgId}:${p}`);
const emailLockKeys = (orgId: string, norms: string[]) =>
  [...new Set(norms)].sort().map((e) => `lead-email:${orgId}:${e}`);
const normEmail = (email: string | null | undefined) => (email ? email.trim().toLowerCase() : null);

export async function commitImportBatchSet(
  tx: Tx,
  ctx: Member,
  rows: readonly ImportRowInput[],
  opts: { importId: string; duplicatePolicy: 'ATTACH' | 'SKIP' },
  assigner: ImportAssigner,
): Promise<ImportRowOutcome[]> {
  const org = ctx.orgId;
  const ext = (row: number) => `${opts.importId}:${row}`;

  // 1. Phone locks, then the transaction time (batch leads carry it as created_at).
  await lockKeys(
    tx,
    phoneLockKeys(
      org,
      rows.flatMap((r) => r.lead.phones),
    ),
  );
  const now = (await tx.$queryRaw<{ now: Date }[]>`SELECT now() AS now`)[0]!.now;

  // 2. Done check: rows committed by an earlier attempt of this import.
  const done = new Map<string, string>();
  for (const d of await tx.$queryRaw<{ source_id: string; external_id: string; lead_id: string }[]>`
    SELECT source_id, external_id, lead_id FROM lead_enquiry
     WHERE channel_ref = ${CHANNEL_REF}
       AND source_id = ANY(${[...new Set(rows.map((r) => r.sourceId))]}::uuid[])
       AND external_id = ANY(${rows.map((r) => ext(r.row))}::text[])`)
    done.set(`${d.source_id}|${d.external_id}`, d.lead_id);

  // 3. Open matches per phone (the findOpenMatch predicate, served by lead_open_phone_uq and
  //    the alternate-phone index).
  const allPhones = [...new Set(rows.flatMap((r) => r.lead.phones))];
  const openByPhone = new Map<string, { id: string; archivedAt: Date | null; createdAt: Date }>();
  if (allPhones.length)
    for (const m of await tx.$queryRaw<
      { phone: string; id: string; archived_at: Date | null; created_at: Date }[]
    >`
      SELECT p.phone, m.id, m.archived_at, m.created_at
        FROM unnest(${allPhones}::text[]) AS p(phone)
        CROSS JOIN LATERAL (
          SELECT id, archived_at, created_at FROM lead
           WHERE stage NOT IN ('WON', 'LOST') AND deleted_at IS NULL
             AND merged_into_lead_id IS NULL
             AND (primary_phone_e164 = p.phone OR alternate_phone_e164 = p.phone)
           ORDER BY created_at ASC LIMIT 1) m`)
      openByPhone.set(m.phone, { id: m.id, archivedAt: m.archived_at, createdAt: m.created_at });

  // 4. In memory, in file order: exactly the decisions of the row path.
  const outcomes: (ImportRowOutcome | { row: number; pending: 'SKIPPED' | 'ATTACHED' })[] = [];
  const creating: Creating[] = [];
  const attaching: Attaching[] = [];
  const skippedRefs = new Map<number, MatchRef>();
  const batchLeadByPhone = new Map<string, number>(); // phone → creating row number
  let defs: Awaited<ReturnType<typeof lockedDefinitions>> | undefined;
  for (const r of rows) {
    const externalId = ext(r.row);
    const prior = done.get(`${r.sourceId}|${externalId}`);
    if (prior) {
      outcomes.push({ row: r.row, outcome: 'ALREADY_IMPORTED', leadId: prior });
      continue;
    }
    // Oldest open lead holding any of the row's phones (ORDER BY created_at): existing leads by
    // their created_at, leads created earlier in this batch at the transaction time.
    let match: MatchRef | null = null;
    let matchAt = Infinity;
    for (const p of r.lead.phones) {
      const db = openByPhone.get(p);
      if (db && db.createdAt.getTime() < matchAt) {
        match = { kind: 'db', ...db };
        matchAt = db.createdAt.getTime();
      }
      const batchRow = batchLeadByPhone.get(p);
      if (batchRow !== undefined && now.getTime() < matchAt) {
        match = { kind: 'batch', row: batchRow };
        matchAt = now.getTime();
      }
    }
    if (match && opts.duplicatePolicy === 'SKIP') {
      skippedRefs.set(r.row, match);
      outcomes.push({ row: r.row, pending: 'SKIPPED' });
      continue;
    }
    if (match) {
      attaching.push({ r, externalId, match });
      outcomes.push({ row: r.row, pending: 'ATTACHED' });
      continue;
    }
    defs ??= await lockedDefinitions(tx);
    let customFields: Record<string, unknown>;
    try {
      customFields = checkCustomValues(defs, r.customFields ?? {}, { requireRequired: true });
    } catch (e) {
      if (!(e instanceof DomainError) || !e.fieldErrors) throw e;
      const [k] = Object.keys(e.fieldErrors);
      const key = k!.replace(/^customFields\./, '');
      outcomes.push({
        row: r.row,
        outcome: 'FAILED',
        leadId: null,
        field: customIssueField(key),
        code: key in (r.customFields ?? {}) ? 'CUSTOM_FIELD_INVALID' : 'CUSTOM_FIELD_REQUIRED',
      });
      continue;
    }
    const target = assigner.next();
    // insertNote refuses a note that cleans to nothing; so does this path (same error).
    const note = r.lead.input.note ? cleanText(r.lead.input.note) : null;
    if (r.lead.input.note && !note) throw invalid({ body: ['Write a note'] });
    creating.push({
      r,
      externalId,
      customFields,
      userId: target.userId,
      teamId: target.teamId,
      stage: target.userId ? 'ASSIGNED' : 'NEW',
      note,
    });
    for (const p of r.lead.phones) batchLeadByPhone.set(p, r.row);
    outcomes.push({ row: r.row, outcome: 'CREATED', leadId: '' });
  }

  // 5. E-mail locks for the new leads, sorted, after the phones (global order: phones, e-mails).
  const norms = creating.map((c) => normEmail(c.r.lead.input.email)).filter((e) => e !== null);
  await lockKeys(tx, emailLockKeys(org, norms));

  // 6. Returning customers: the newest live won/lost lead with the same primary (P-A predicate).
  const previousByPrimary = new Map<string, string>();
  if (creating.length)
    for (const p of await tx.$queryRaw<{ primary_phone_e164: string; id: string }[]>`
      SELECT DISTINCT ON (primary_phone_e164) primary_phone_e164, id FROM lead
       WHERE org_id = ${org}::uuid
         AND phone_last10 = ANY(${creating.map((c) => c.r.lead.primary.e164.slice(-10))}::text[])
         AND primary_phone_e164 = ANY(${creating.map((c) => c.r.lead.primary.e164)}::text[])
         AND stage IN ('WON', 'LOST') AND deleted_at IS NULL
       ORDER BY primary_phone_e164, created_at DESC`)
      previousByPrimary.set(p.primary_phone_e164, p.id);

  // 7. Leads, one statement. Mapped back by primary phone (unique among the new leads: a row
  //    sharing a phone with an earlier new lead matched it in step 4).
  const leadIdByRow = new Map<number, string>();
  if (creating.length) {
    const payload = creating.map((c) => {
      const { input, primary, alternate, requirements: q } = c.r.lead;
      return {
        full_name: cleanText(input.fullName),
        primary_phone_e164: primary.e164,
        primary_phone_raw: primary.raw,
        alternate_phone_e164: alternate?.e164 ?? null,
        phone_last10: primary.e164.slice(-10),
        email: input.email ?? null,
        preferred_language: input.preferredLanguage ?? null,
        preferred_contact_method: input.preferredContactMethod ?? null,
        transaction_type: q.transactionType,
        property_type: q.propertyType,
        bhk_min: q.bhkMin,
        bhk_max: q.bhkMax,
        budget_min: q.budgetMin,
        budget_max: q.budgetMax,
        preferred_city: q.preferredCity,
        preferred_localities: q.preferredLocalities,
        purpose: q.purpose,
        timeline: q.timeline,
        intent: q.intent,
        source_id: c.r.sourceId,
        campaign: input.campaign ?? null,
        owner_user_id: c.userId,
        team_id: c.teamId,
        stage: c.stage,
        previous_lead_id: previousByPrimary.get(primary.e164) ?? null,
        custom_fields: c.customFields,
      };
    });
    const inserted = await tx.$queryRaw<{ id: string; primary_phone_e164: string }[]>`
      INSERT INTO lead (org_id, full_name, primary_phone_e164, primary_phone_raw,
        alternate_phone_e164, phone_last10, email, preferred_language, preferred_contact_method,
        transaction_type, property_type, bhk_min, bhk_max, budget_min, budget_max,
        preferred_city, preferred_localities, purpose, timeline, intent, source_id, campaign,
        owner_user_id, team_id, stage, previous_lead_id, created_by, custom_fields)
      SELECT ${org}::uuid, t.full_name, t.primary_phone_e164, t.primary_phone_raw,
        t.alternate_phone_e164, t.phone_last10, t.email, t.preferred_language,
        t.preferred_contact_method, t.transaction_type, t.property_type, t.bhk_min, t.bhk_max,
        t.budget_min, t.budget_max, t.preferred_city, t.preferred_localities, t.purpose,
        t.timeline, t.intent, t.source_id, t.campaign, t.owner_user_id, t.team_id,
        t.stage::lead_stage, t.previous_lead_id, ${ctx.userId}::uuid, t.custom_fields
        FROM jsonb_to_recordset(${JSON.stringify(payload)}::jsonb) AS t(
          full_name text, primary_phone_e164 text, primary_phone_raw text,
          alternate_phone_e164 text, phone_last10 text, email citext, preferred_language text,
          preferred_contact_method text, transaction_type text, property_type text,
          bhk_min smallint, bhk_max smallint, budget_min numeric, budget_max numeric,
          preferred_city text, preferred_localities text[], purpose text, timeline text,
          intent text, source_id uuid, campaign text, owner_user_id uuid, team_id uuid,
          stage text, previous_lead_id uuid, custom_fields jsonb)
      RETURNING id, primary_phone_e164`;
    const rowByPrimary = new Map(creating.map((c) => [c.r.lead.primary.e164, c.r.row]));
    for (const l of inserted) {
      const row = rowByPrimary.get(l.primary_phone_e164);
      if (row === undefined || leadIdByRow.has(row)) throw new Error('import batch mapping');
      leadIdByRow.set(row, l.id);
    }
    if (leadIdByRow.size !== creating.length) throw new Error('import batch mapping');
  }
  const idOf = (m: MatchRef) => (m.kind === 'db' ? m.id : leadIdByRow.get(m.row)!);

  // 8. E-mail cases (detectEmailDuplicates for each new lead, in file order): the 10 oldest live
  //    leads with the same normalised e-mail among existing leads and the new leads of earlier
  //    rows. Existing candidates come from one query; earlier new leads are added here.
  if (norms.length) {
    const newIds = [...leadIdByRow.values()];
    const existing = new Map<string, { id: string; at: number }[]>();
    for (const c of await tx.$queryRaw<{ norm: string; id: string; created_at: Date }[]>`
      SELECT q.norm, l.id, l.created_at
        FROM unnest(${[...new Set(norms)]}::text[]) AS q(norm)
        CROSS JOIN LATERAL (
          SELECT id, created_at FROM lead
           WHERE org_id = ${org}::uuid AND email_normalized = lower(q.norm)
             AND merged_into_lead_id IS NULL AND deleted_at IS NULL
             AND id <> ALL(${newIds}::uuid[])
           ORDER BY created_at ASC, id ASC LIMIT ${MAX_EMAIL_CASES}) l`) {
      const list = existing.get(c.norm) ?? [];
      list.push({ id: c.id, at: c.created_at.getTime() });
      existing.set(c.norm, list);
    }
    const earlier = new Map<string, string[]>(); // norm → new lead ids of earlier rows
    const pairs: { lead_id: string; candidate_lead_id: string }[] = [];
    for (const c of creating) {
      const norm = normEmail(c.r.lead.input.email);
      if (!norm) continue;
      const leadId = leadIdByRow.get(c.r.row)!;
      const candidates = [
        ...(existing.get(norm) ?? []),
        ...(earlier.get(norm) ?? []).map((id) => ({ id, at: now.getTime() })),
      ]
        .sort((a, b) => a.at - b.at)
        .slice(0, MAX_EMAIL_CASES);
      for (const o of candidates) pairs.push({ lead_id: leadId, candidate_lead_id: o.id });
      earlier.set(norm, [...(earlier.get(norm) ?? []), leadId]);
    }
    if (pairs.length)
      await tx.$executeRaw`
        INSERT INTO lead_duplicate_match (org_id, match_type, lead_id, candidate_lead_id,
                                          detected_by)
        SELECT ${org}::uuid, 'EMAIL', t.lead_id, t.candidate_lead_id, ${ctx.userId}::uuid
          FROM jsonb_to_recordset(${JSON.stringify(pairs)}::jsonb)
               AS t(lead_id uuid, candidate_lead_id uuid)
        ON CONFLICT DO NOTHING`;
  }

  // 9. Enquiries: the first enquiry of each new lead, and the attached ones. Mapped back by
  //    external id (unique per row).
  const enquiryRows = [
    ...creating.map((c) => ({
      lead_id: leadIdByRow.get(c.r.row)!,
      source_id: c.r.sourceId,
      campaign: c.r.lead.input.campaign ?? null,
      external_id: c.externalId,
    })),
    ...attaching.map((a) => ({
      lead_id: idOf(a.match),
      source_id: a.r.sourceId,
      campaign: a.r.lead.input.campaign ?? null,
      external_id: a.externalId,
    })),
  ];
  const enquiryByExt = new Map<string, string>();
  if (enquiryRows.length) {
    for (const e of await tx.$queryRaw<{ id: string; external_id: string }[]>`
      INSERT INTO lead_enquiry (org_id, lead_id, source_id, campaign, external_id, channel_ref,
                                created_by)
      SELECT ${org}::uuid, t.lead_id, t.source_id, t.campaign, t.external_id, ${CHANNEL_REF},
             ${ctx.userId}::uuid
        FROM jsonb_to_recordset(${JSON.stringify(enquiryRows)}::jsonb)
             AS t(lead_id uuid, source_id uuid, campaign text, external_id text)
      RETURNING id, external_id`)
      enquiryByExt.set(e.external_id, e.id);
    if (enquiryByExt.size !== enquiryRows.length) throw new Error('import batch mapping');
  }

  if (creating.length) {
    // 10. Stage history and assignment spells.
    const created = creating.map((c) => ({
      lead_id: leadIdByRow.get(c.r.row)!,
      stage: c.stage,
      user_id: c.userId,
      team_id: c.teamId,
    }));
    await tx.$executeRaw`
      INSERT INTO lead_stage_history (org_id, lead_id, to_stage, changed_by, source)
      SELECT ${org}::uuid, t.lead_id, t.stage::lead_stage, ${ctx.userId}::uuid, 'IMPORT'
        FROM jsonb_to_recordset(${JSON.stringify(created)}::jsonb) AS t(lead_id uuid, stage text)`;
    const spells = created.filter((c) => c.user_id || c.team_id);
    if (spells.length)
      await tx.$executeRaw`
        INSERT INTO lead_assignment_history (org_id, lead_id, user_id, team_id, assigned_by,
                                             source)
        SELECT ${org}::uuid, t.lead_id, t.user_id, t.team_id, ${ctx.userId}::uuid, 'IMPORT'
          FROM jsonb_to_recordset(${JSON.stringify(spells)}::jsonb)
               AS t(lead_id uuid, user_id uuid, team_id uuid)`;
  }

  // 11. Notes (insertNote), then all activities in timeline order per lead: CREATED, NOTE for
  //     new leads; ENQUIRY for attached rows.
  const noteByRow = new Map<number, string>();
  const withNotes = creating.filter((c) => c.note);
  if (withNotes.length) {
    const editedUntil = new Date(Date.now() + NOTE_EDIT_WINDOW_MS).toISOString();
    const notes = await tx.$queryRaw<{ id: string; lead_id: string }[]>`
      INSERT INTO lead_note (org_id, lead_id, author_id, body, edited_until)
      SELECT ${org}::uuid, t.lead_id, ${ctx.userId}::uuid, t.body, ${editedUntil}::timestamptz
        FROM jsonb_to_recordset(${JSON.stringify(
          withNotes.map((c) => ({ lead_id: leadIdByRow.get(c.r.row)!, body: c.note })),
        )}::jsonb) AS t(lead_id uuid, body text)
      RETURNING id, lead_id`;
    const rowByLead = new Map(withNotes.map((c) => [leadIdByRow.get(c.r.row)!, c.r.row]));
    for (const n of notes) noteByRow.set(rowByLead.get(n.lead_id)!, n.id);
  }
  const activities: {
    ord: number;
    lead_id: string;
    type: string;
    summary: Record<string, unknown>;
    ref_type: string | null;
    ref_id: string | null;
  }[] = [];
  for (const c of creating) {
    const leadId = leadIdByRow.get(c.r.row)!;
    activities.push({
      ord: activities.length,
      lead_id: leadId,
      type: 'CREATED',
      summary: {
        stage: c.stage,
        returning: previousByPrimary.has(c.r.lead.primary.e164),
        channel: 'IMPORT',
      },
      ref_type: null,
      ref_id: null,
    });
    const noteId = noteByRow.get(c.r.row);
    if (noteId)
      activities.push({
        ord: activities.length,
        lead_id: leadId,
        type: 'NOTE',
        summary: {},
        ref_type: 'lead_note',
        ref_id: noteId,
      });
  }
  for (const a of attaching)
    activities.push({
      ord: activities.length,
      lead_id: idOf(a.match),
      type: 'ENQUIRY',
      summary: { channel: 'IMPORT' },
      ref_type: 'lead_enquiry',
      ref_id: enquiryByExt.get(a.externalId)!,
    });
  if (activities.length)
    await tx.$executeRaw`
      INSERT INTO lead_activity (org_id, lead_id, type, actor_id, summary, ref_type, ref_id)
      SELECT ${org}::uuid, t.lead_id, t.type, ${ctx.userId}::uuid, t.summary, t.ref_type, t.ref_id
        FROM jsonb_to_recordset(${JSON.stringify(activities)}::jsonb)
             AS t(ord int, lead_id uuid, type text, summary jsonb, ref_type text, ref_id uuid)
       ORDER BY t.ord`;

  // 12. Outbox events for attached enquiries (emitEvent), one statement.
  if (attaching.length)
    await tx.$executeRaw`
      INSERT INTO outbox_event (org_id, type, payload)
      SELECT ${org}::uuid, 'lead.enquiry_returned', t.payload
        FROM jsonb_to_recordset(${JSON.stringify(
          attaching.map((a, i) => ({
            ord: i,
            payload: {
              leadId: idOf(a.match),
              enquiryId: enquiryByExt.get(a.externalId)!,
              actorUserId: ctx.userId,
            },
          })),
        )}::jsonb) AS t(ord int, payload jsonb)
       ORDER BY t.ord`;

  // 13. D2: an attached archived (existing) lead stays archived; its enquiry opens a review case.
  for (const a of attaching)
    if (a.match.kind === 'db' && a.match.archivedAt)
      await routeEnquiryForArchivedLead(tx, ctx, a.match, enquiryByExt.get(a.externalId)!);

  await assigner.finish();
  await emitImportAssigned(
    tx,
    ctx,
    creating.map((c) => ({
      leadId: leadIdByRow.get(c.r.row)!,
      userId: c.userId,
      teamId: c.teamId,
    })),
  );

  const attachByRow = new Map(attaching.map((a) => [a.r.row, a]));
  return outcomes.map((o): ImportRowOutcome => {
    if ('pending' in o) {
      const ref = o.pending === 'SKIPPED' ? skippedRefs.get(o.row)! : undefined;
      if (ref) return { row: o.row, outcome: 'SKIPPED_DUPLICATE', leadId: idOf(ref) };
      return { row: o.row, outcome: 'ATTACHED', leadId: idOf(attachByRow.get(o.row)!.match) };
    }
    if (o.outcome === 'CREATED') return { ...o, leadId: leadIdByRow.get(o.row)! };
    return o;
  });
}
