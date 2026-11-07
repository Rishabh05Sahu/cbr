import { notFound } from 'next/navigation';
import Link from 'next/link';
import { ActionForm } from '@/components/action-form';
import { Alert, Badge, Card, EmptyState, Field, Input, PageHeader, Select } from '@/components/ui';
import {
  allowedTargets,
  assignmentTargets,
  CONTACT_METHOD_LABELS,
  CONTACT_STATUS_LABELS,
  contactStatusHistory,
  DNC_METHODS,
  getAssignmentHistory,
  getLead,
  getTimeline,
  INTENTS,
  listCustomFields,
  listLeadSources,
  LOST_REASONS,
  PROPERTY_TYPES,
  PURPOSES,
  STAGE_LABELS,
  TIMELINES,
  TRANSACTION_TYPES,
  type ContactStatus,
  type LeadStage,
  type TimelineEntry,
  tagsForLead,
} from '@/modules/leads';
import {
  addNoteAction,
  assignLeadAction,
  changeStageAction,
  editNoteAction,
  roundRobinAction,
  setCustomFieldsAction,
  updateRequirementsAction,
} from '@/modules/leads/actions';
import {
  CHANNEL_LABELS,
  DIRECTION_LABELS,
  OUTCOME_LABELS,
  sheetDefaults,
  type Channel,
  type Direction,
  type Outcome,
} from '@/modules/interactions';
import { suggestForLead } from '@/modules/scripts';
import {
  assigneeOptions,
  attendeeOptions,
  followUpsForLead,
  NEW_TASK_TYPES,
  TASK_PRIORITIES,
  TASK_TYPE_LABELS,
  type TaskType,
} from '@/modules/tasks';
import { createTaskAction, scheduleFollowUpAction } from '@/modules/tasks/actions';
import { visitAssigneeOptions, visitsForLead } from '@/modules/visits';
import { scheduleVisitAction } from '@/modules/visits/actions';
import { can } from '@/platform/authz';
import { pageContext, pageRequire } from '@/platform/auth/session';
import { DomainError } from '@/platform/errors';
import { ScriptContentView, TargetingBadges } from '../../scripts/script-content';
import { CustomFieldInputs } from '../custom-field-inputs';
import { ArchiveControl } from './archive-control';
import { ContactStatusBanner, ContactStatusCard } from './contact-status';
import { FollowUpRow } from './follow-up-row';
import { VisitRow } from './visit-row';
import { MeetingFields } from './meeting-fields';
import { InteractionSheet, type SheetFollowUp } from './interaction-sheet';
import { PhoneReveal } from './phone-reveal';
import { ScriptPanel, type PanelScript } from './script-panel';
import { ShownScriptProvider } from './shown-script';
import { fmtDateTime, fmtInr, label, LABELS } from '../labels';

const textareaClass = 'block w-full rounded-md border border-slate-300 px-3 py-2 text-sm';
/** FR-057 script panel: the best matches shown in the drawer (FR-096 order). */
const PANEL_SCRIPTS = 5;

export default async function LeadPage({ params }: PageProps<'/app/leads/[id]'>) {
  const { ctx } = await pageContext();
  pageRequire(ctx, 'lead.read');
  const { id } = await params;
  // Another org's lead, an out-of-scope lead and a missing lead all look the same: 404.
  const lead = await getLead(ctx, id).catch((e: unknown) => {
    if (e instanceof DomainError && e.code === 'NOT_FOUND') notFound();
    throw e;
  });
  const timeline = lead.canViewTimeline ? await getTimeline(ctx, lead.id) : [];
  const tags = await tagsForLead(ctx, lead.id);
  // FR-065: the history backs the banner ("since") and the contact status card.
  const contactHistory = await contactStatusHistory(ctx, lead.id);
  const contactSince = contactHistory.find((h) => h.toStatus === lead.contactStatus) ?? null;
  const closed = lead.stage === 'WON' || lead.stage === 'LOST';
  const assignTo = lead.canAssign && !closed ? await assignmentTargets(ctx) : null;
  const spells = lead.canViewAssignmentHistory ? await getAssignmentHistory(ctx, lead.id) : [];
  const targets = lead.stage === 'LOST' && !lead.canReopen ? [] : allowedTargets(lead.stage);
  const merged = lead.mergedIntoLeadId !== null;
  const archived = lead.archivedAt !== null;
  // Custom fields: active ones are editable; values of archived fields stay visible (read only).
  const fieldDefs = await listCustomFields(ctx, { includeArchived: true });
  const activeDefs = fieldDefs.filter((f) => !f.archived);
  const archivedValues = fieldDefs.filter((f) => f.archived && f.key in lead.customFields);
  const canArchive = can(ctx, 'lead.archive') && !merged;
  const canMerge = can(ctx, 'lead.merge') && !merged && !archived;
  // Phase 3 follow-ups (FR-100/102/108). Roles without task.read (support access) see none.
  const followUps = can(ctx, 'task.read') ? await followUpsForLead(ctx, lead.id) : null;
  // FR-103: people the caller may give a task on this lead to (empty without task.assign).
  const people = followUps?.canAddTask ? await assigneeOptions(ctx, lead.id) : [];
  // FR-150–152 site visits (ADR-0022). Roles without site_visit.read (HR, support) see none.
  const visits = can(ctx, 'site_visit.read') ? await visitsForLead(ctx, lead.id) : null;
  const visitPeople = visits?.canSchedule ? await visitAssigneeOptions(ctx) : [];
  // FR-104: who may be invited to a meeting (any active member; editing needs it too).
  const invitees =
    followUps && (followUps.canAddTask || followUps.tasks.some((t) => t.canUpdate))
      ? await attendeeOptions(ctx)
      : [];
  const followUpRows = followUps ? [...followUps.open, ...followUps.recentClosed] : [];
  // The schedule form stays mounted after scheduling (its "scheduled" message must not vanish).
  const showScheduleForm =
    followUps !== null &&
    (followUps.canSchedule ||
      followUps.open.some((t) => t.assigneeUserId === ctx.userId && t.canUpdate));
  const now = new Date();
  // FR-057/FR-099 script panel: published scripts matching this lead, best match first (FR-096,
  // ADR-0011 decision 8). Roles without script.read (HR, support access) see no panel.
  const suggestions = can(ctx, 'script.read')
    ? (await suggestForLead(ctx, lead.id)).slice(0, PANEL_SCRIPTS)
    : null;
  const sourceNames =
    suggestions && suggestions.length > 0
      ? new Map((await listLeadSources(ctx)).map((s) => [s.id, s.name]))
      : new Map<string, string>();
  const panelScripts: PanelScript[] = (suggestions ?? []).map((s) => ({
    id: s.id,
    name: s.name,
    versionId: s.versionId,
    versionNo: s.versionNo,
    versionLine: `Version ${s.versionNo} · published ${fmtDateTime(s.publishedAt)}`,
    targeting: <TargetingBadges t={s} sourceNames={sourceNames} />,
    content: <ScriptContentView content={s.content} idPrefix={`script-${s.id}`} />,
  }));
  const matchedOn = [
    `looking to: ${lead.transactionType ? label(lead.transactionType) : 'not set'}`,
    `property type: ${lead.propertyType ? label(lead.propertyType) : 'not set'}`,
    `language: ${lead.preferredLanguage ?? 'not set'}`,
    `source: ${lead.sourceName}`,
  ].join(' · ');
  // FR-083/084: the outcome sheet, for people who may log interactions on this writable lead.
  const sheet = lead.canLogInteraction ? await sheetDefaults(ctx) : null;
  const ownOpen = followUps?.open.find((t) => t.assigneeUserId === ctx.userId && t.canUpdate);
  const sheetFollowUp: SheetFollowUp | null =
    followUps === null
      ? null
      : closed
        ? { own: null, canSchedule: false, blockedReason: 'Won and lost leads take no follow-ups.' }
        : ownOpen || followUps.canSchedule
          ? {
              own: ownOpen
                ? {
                    id: ownOpen.id,
                    version: ownOpen.version,
                    dueAt: ownOpen.dueAt,
                    rescheduleNeedsReason: ownOpen.rescheduleNeedsReason,
                  }
                : null,
              canSchedule: followUps.canSchedule,
              blockedReason: null,
            }
          : null;

  const select = (
    name: string,
    labelText: string,
    codes: readonly string[],
    value: string | null,
    prefix = 'req',
  ) => (
    <Field label={labelText} htmlFor={`${prefix}-${name}`}>
      <Select id={`${prefix}-${name}`} name={name} defaultValue={value ?? ''}>
        <option value="">—</option>
        {codes.map((c) => (
          <option key={c} value={c}>
            {LABELS[c] ?? c}
          </option>
        ))}
      </Select>
    </Field>
  );
  const input = (
    name: string,
    labelText: string,
    value: string | number | null,
    props = {},
    prefix = 'req',
  ) => (
    <Field label={labelText} htmlFor={`${prefix}-${name}`}>
      <Input id={`${prefix}-${name}`} name={name} defaultValue={value ?? ''} {...props} />
    </Field>
  );
  // The requirement fields again, for the outcome sheet's optional section (own ids).
  const sheetRequirements = lead.canUpdate ? (
    <>
      {select('transactionType', 'Looking to', TRANSACTION_TYPES, lead.transactionType, 'ix-req')}
      {select('propertyType', 'Property type', PROPERTY_TYPES, lead.propertyType, 'ix-req')}
      {input('preferredCity', 'City', lead.preferredCity, { maxLength: 100 }, 'ix-req')}
      {input('budgetMin', 'Budget from', lead.budgetMin, {}, 'ix-req')}
      {input('budgetMax', 'Budget up to', lead.budgetMax, {}, 'ix-req')}
      {input(
        'preferredLocalities',
        'Localities',
        lead.preferredLocalities.join(', '),
        {},
        'ix-req',
      )}
      {input('bhkMin', 'BHK from', lead.bhkMin, { type: 'number', min: 0, max: 20 }, 'ix-req')}
      {input('bhkMax', 'BHK up to', lead.bhkMax, { type: 'number', min: 0, max: 20 }, 'ix-req')}
      {select('purpose', 'Purpose', PURPOSES, lead.purpose, 'ix-req')}
      {select('timeline', 'Timeline', TIMELINES, lead.timeline, 'ix-req')}
      {select('intent', 'Intent', INTENTS, lead.intent, 'ix-req')}
    </>
  ) : null;

  return (
    <>
      <PageHeader
        title={lead.fullName}
        description={`${lead.ownerName ?? 'Unassigned'}${lead.teamName ? ` · ${lead.teamName}` : ''} · source ${lead.sourceName}${lead.campaign ? ` (${lead.campaign})` : ''}`}
      />
      <div className="mb-6 flex flex-wrap items-center gap-2">
        <Badge tone={lead.stage === 'WON' ? 'good' : lead.stage === 'LOST' ? 'warn' : 'neutral'}>
          {STAGE_LABELS[lead.stage]}
        </Badge>
        {lead.contactStatus !== 'OK' && (
          <Badge tone="warn">{CONTACT_STATUS_LABELS[lead.contactStatus]}</Badge>
        )}
        {lead.ownerActive === false && <Badge tone="warn">Owner inactive</Badge>}
        {lead.ownerUserId === null && <Badge tone="warn">Unassigned</Badge>}
        {archived && <Badge tone="warn">Archived</Badge>}
        {merged && <Badge tone="warn">Merged</Badge>}
        {tags.map((t) => (
          <Badge key={t.id}>#{t.name}</Badge>
        ))}
      </div>
      <ContactStatusBanner status={lead.contactStatus} since={contactSince} />
      {merged && (
        <div className="mb-6">
          <Alert tone="warn">
            This lead was merged into{' '}
            <Link
              href={`/app/leads/${lead.mergedIntoLeadId}` as '/app/leads'}
              className="tap font-medium underline"
            >
              another lead
            </Link>
            . Its history is kept here and shown on that lead&apos;s timeline; new notes and
            enquiries go to that lead. It can no longer be changed.
          </Alert>
        </div>
      )}
      {archived && !merged && (
        <div className="mb-6">
          <Alert tone="warn">
            Archived on {fmtDateTime(lead.archivedAt!)}. It is read-only until it is restored. New
            enquiries for it are attached and sent to the duplicate review queue; they never restore
            it on their own.
          </Alert>
        </div>
      )}
      {(canArchive || canMerge) && (
        // Lead actions near the top at every width (M5 §K): on a phone the sidebar stacks
        // below the timeline, which hid Archive, Restore and Merge far down the page.
        <section
          aria-label="Lead actions"
          className="mb-6 flex flex-wrap items-start gap-x-6 gap-y-3 rounded-lg border border-slate-200 bg-white p-4"
        >
          {canArchive && (
            <div className="flex max-w-md flex-col gap-1">
              <ArchiveControl leadId={lead.id} version={lead.version} archived={archived} />
              <p className="text-xs text-slate-600">
                {archived
                  ? 'Restoring makes the lead editable again and closes its open review case.'
                  : 'Archived leads are hidden from the list and read-only. They still count as duplicates, and can be restored.'}
              </p>
            </div>
          )}
          {canMerge && (
            <a
              href="#merge"
              className="tap inline-flex items-center rounded-md border border-slate-300 bg-white px-3 py-2 text-sm font-medium text-slate-900 hover:bg-slate-50 focus:outline-none focus-visible:ring-2 focus-visible:ring-blue-600"
            >
              Merge a duplicate…
            </a>
          )}
        </section>
      )}
      {/* FR-098: the script panel tells the outcome sheet which script version was shown. */}
      <ShownScriptProvider>
        <div className="grid gap-6 lg:grid-cols-3">
          <div className="space-y-6 lg:col-span-2">
            {suggestions && (
              <ScriptPanel
                scripts={panelScripts}
                contactStatus={lead.contactStatus}
                matchedOn={matchedOn}
                allScriptsHref="/app/scripts"
              />
            )}
            {sheet && (
              <Card
                title="Log an interaction"
                description="Record a call, message or meeting that already happened. This page never places calls or sends messages."
              >
                <InteractionSheet
                  leadId={lead.id}
                  version={lead.version}
                  stage={lead.stage}
                  contactStatus={lead.contactStatus}
                  occurredAt={sheet.occurredAt}
                  occurredMin={sheet.occurredMin}
                  followUp={sheetFollowUp}
                  dncMethods={DNC_METHODS.map((m) => ({
                    code: m,
                    label: CONTACT_METHOD_LABELS[m] ?? m,
                  }))}
                  requirementFields={sheetRequirements}
                />
              </Card>
            )}
            {followUps && (
              <Card
                title="Follow-up"
                description="Times are in your organisation's time zone. One open follow-up per person per lead."
              >
                <div className="space-y-4">
                  <p className="flex flex-wrap items-center gap-2 text-sm">
                    {followUps.nextFollowUpAt ? (
                      <>
                        <span>Next follow-up:</span>
                        <strong>{fmtDateTime(followUps.nextFollowUpAt)}</strong>
                        {followUps.nextFollowUpAt < now && <Badge tone="warn">Overdue</Badge>}
                      </>
                    ) : (
                      <span className="text-slate-600">No follow-up scheduled.</span>
                    )}
                  </p>
                  {followUpRows.length > 0 && (
                    <ul aria-label="Follow-ups" className="divide-y divide-slate-100">
                      {followUpRows.map((t) => (
                        <FollowUpRow key={t.id} task={t} leadId={lead.id} />
                      ))}
                    </ul>
                  )}
                  {followUps.scheduleBlockedReason && (
                    <p className="text-sm text-slate-600">{followUps.scheduleBlockedReason}</p>
                  )}
                  {showScheduleForm && (
                    <ActionForm
                      action={scheduleFollowUpAction}
                      successMessage="Follow-up scheduled."
                      fieldLabels={{ dueAt: 'Date and time', title: 'What to follow up on' }}
                      {...(followUps.canSchedule ? { submitLabel: 'Schedule follow-up' } : {})}
                      className="space-y-4 border-t border-slate-100 pt-4"
                    >
                      <input type="hidden" name="leadId" value={lead.id} />
                      {followUps.canSchedule ? (
                        <div className="grid gap-4 sm:grid-cols-2">
                          <Field label="Date and time" htmlFor="fu-due">
                            <Input id="fu-due" name="dueAt" type="datetime-local" required />
                          </Field>
                          <Field label="Priority" htmlFor="fu-priority">
                            <Select id="fu-priority" name="priority" defaultValue="NORMAL">
                              {TASK_PRIORITIES.map((p) => (
                                <option key={p} value={p}>
                                  {p.charAt(0) + p.slice(1).toLowerCase()}
                                </option>
                              ))}
                            </Select>
                          </Field>
                          <div className="sm:col-span-2">
                            <Field label="What to follow up on (optional)" htmlFor="fu-title">
                              <Input id="fu-title" name="title" maxLength={200} />
                            </Field>
                          </div>
                        </div>
                      ) : (
                        <p className="text-sm text-slate-600">
                          You have an open follow-up on this lead. Reschedule, complete or cancel it
                          above.
                        </p>
                      )}
                    </ActionForm>
                  )}
                </div>
              </Card>
            )}
            {visits && (visits.visits.length > 0 || visits.canSchedule) && (
              // FR-150–152: basic site visits (free-text meeting point; properties come with
              // FR-157). Scheduling moves the lead to Site Visit Scheduled; attended to Completed.
              <Card
                title="Site visits"
                description="Times are in your organisation's time zone. Attended and no-show can be recorded from the visit's day."
              >
                <div className="space-y-4">
                  {visits.visits.length > 0 && (
                    <ul aria-label="Site visits" className="divide-y divide-slate-100">
                      {visits.visits.map((v) => (
                        <VisitRow key={v.id} visit={v} leadId={lead.id} />
                      ))}
                    </ul>
                  )}
                  {visits.canSchedule && (
                    <ActionForm
                      action={scheduleVisitAction}
                      successMessage="Site visit scheduled."
                      submitLabel="Schedule visit"
                      fieldLabels={{
                        scheduledFor: 'Date and time',
                        location: 'Meeting point',
                        assigneeUserId: 'Salesperson',
                      }}
                      className="space-y-4 border-t border-slate-100 pt-4"
                    >
                      <input type="hidden" name="leadId" value={lead.id} />
                      <div className="grid gap-4 sm:grid-cols-2">
                        <Field label="Date and time" htmlFor="sv-when">
                          <Input id="sv-when" name="scheduledFor" type="datetime-local" required />
                        </Field>
                        {visitPeople.length > 0 && (
                          <Field label="Salesperson" htmlFor="sv-who">
                            <Select id="sv-who" name="assigneeUserId" defaultValue="">
                              <option value="">Me</option>
                              {visitPeople.map((p) => (
                                <option key={p.userId} value={p.userId}>
                                  {p.name}
                                </option>
                              ))}
                            </Select>
                          </Field>
                        )}
                        <div className="sm:col-span-2">
                          <Field label="Meeting point" htmlFor="sv-where">
                            <Input id="sv-where" name="location" maxLength={300} required />
                          </Field>
                        </div>
                      </div>
                    </ActionForm>
                  )}
                </div>
              </Card>
            )}
            {followUps && (followUps.tasks.length > 0 || followUps.canAddTask) && (
              // FR-100: Call, Meeting, Document and Other tasks on this lead (ADR-0015). They
              // follow the lead like follow-ups but do not set its next follow-up date.
              <Card
                title="Tasks"
                description="Calls, meetings, documents and other tasks for this lead."
              >
                <div className="space-y-4">
                  {followUps.tasks.length > 0 && (
                    <ul aria-label="Tasks" className="divide-y divide-slate-100">
                      {followUps.tasks.map((t) => (
                        <FollowUpRow key={t.id} task={t} leadId={lead.id} people={invitees} />
                      ))}
                    </ul>
                  )}
                  {followUps.canAddTask && (
                    <ActionForm
                      action={createTaskAction}
                      successMessage="Task added."
                      submitLabel="Add task"
                      fieldLabels={{
                        type: 'Type',
                        title: 'Task',
                        dueAt: 'Date and time',
                        assigneeUserId: 'For',
                        endAt: 'Ends at',
                        location: 'Location or link',
                        attendeeUserIds: 'Attendees',
                      }}
                      className="space-y-4 border-t border-slate-100 pt-4"
                    >
                      <input type="hidden" name="leadId" value={lead.id} />
                      <div className="grid gap-4 sm:grid-cols-2">
                        {people.length > 0 && (
                          // FR-103: only people who can work on this lead are offered.
                          <Field label="For" htmlFor="tk-for" hint="They are notified in the app.">
                            <Select id="tk-for" name="assigneeUserId" defaultValue="">
                              <option value="">Me</option>
                              {people.map((p) => (
                                <option key={p.userId} value={p.userId}>
                                  {p.name}
                                </option>
                              ))}
                            </Select>
                          </Field>
                        )}
                        <Field label="Type" htmlFor="tk-type">
                          <Select id="tk-type" name="type" defaultValue="" required>
                            <option value="" disabled>
                              Choose…
                            </option>
                            {/* A follow-up for someone else (FR-103); one's own is scheduled above. */}
                            {people.length > 0 && <option value="FOLLOW_UP">Follow-up</option>}
                            {NEW_TASK_TYPES.map((t) => (
                              <option
                                key={t}
                                value={t}
                                disabled={t === 'CALL' && followUps.callBlockedReason !== null}
                              >
                                {TASK_TYPE_LABELS[t as TaskType]}
                              </option>
                            ))}
                          </Select>
                        </Field>
                        <Field label="Date and time" htmlFor="tk-due">
                          <Input id="tk-due" name="dueAt" type="datetime-local" required />
                        </Field>
                        <Field label="Task" htmlFor="tk-title">
                          <Input id="tk-title" name="title" maxLength={200} required />
                        </Field>
                        <Field label="Priority" htmlFor="tk-priority">
                          <Select id="tk-priority" name="priority" defaultValue="NORMAL">
                            {TASK_PRIORITIES.map((p) => (
                              <option key={p} value={p}>
                                {p.charAt(0) + p.slice(1).toLowerCase()}
                              </option>
                            ))}
                          </Select>
                        </Field>
                        <MeetingFields idPrefix="tk-mt" people={invitees} />
                      </div>
                      {followUps.callBlockedReason && (
                        <p className="text-sm text-slate-600">{followUps.callBlockedReason}</p>
                      )}
                    </ActionForm>
                  )}
                </div>
              </Card>
            )}
            <Card title="Contact">
              {lead.phoneMasked && (
                // FR-060: the server sent masked numbers only; revealing is audited and capped.
                <div className="mb-3">
                  <PhoneReveal
                    leadId={lead.id}
                    masked={{ primary: lead.primaryPhoneE164, alternate: lead.alternatePhoneE164 }}
                    canReveal={lead.canRevealPhone}
                  />
                </div>
              )}
              <dl className="grid gap-2 text-sm sm:grid-cols-2">
                {!lead.phoneMasked && (
                  <>
                    <Item term="Mobile" value={lead.primaryPhoneE164} />
                    <Item term="Alternate" value={lead.alternatePhoneE164 ?? '—'} />
                  </>
                )}
                <Item term="Email" value={lead.email ?? '—'} />
                <Item term="Preferred contact" value={label(lead.preferredContactMethod)} />
                <Item term="Language" value={lead.preferredLanguage ?? '—'} />
                <Item term="Created" value={fmtDateTime(lead.createdAt)} />
              </dl>
            </Card>

            <ContactStatusCard
              leadId={lead.id}
              version={lead.version}
              status={lead.contactStatus}
              archived={archived}
              canChange={lead.canChangeContactStatus}
              canLift={lead.canLiftDoNotContact}
              history={contactHistory}
            />

            <Card title="Requirements">
              {lead.canUpdate ? (
                <ActionForm
                  action={updateRequirementsAction}
                  submitLabel="Save requirements"
                  successMessage="Requirements saved."
                  className="grid gap-4 sm:grid-cols-3"
                >
                  <input type="hidden" name="leadId" value={lead.id} />
                  <input type="hidden" name="version" value={lead.version} />
                  {select('transactionType', 'Looking to', TRANSACTION_TYPES, lead.transactionType)}
                  {select('propertyType', 'Property type', PROPERTY_TYPES, lead.propertyType)}
                  {input('preferredCity', 'City', lead.preferredCity, { maxLength: 100 })}
                  {input('budgetMin', 'Budget from', lead.budgetMin)}
                  {input('budgetMax', 'Budget up to', lead.budgetMax)}
                  {input('preferredLocalities', 'Localities', lead.preferredLocalities.join(', '))}
                  {input('bhkMin', 'BHK from', lead.bhkMin, { type: 'number', min: 0, max: 20 })}
                  {input('bhkMax', 'BHK up to', lead.bhkMax, { type: 'number', min: 0, max: 20 })}
                  {select('purpose', 'Purpose', PURPOSES, lead.purpose)}
                  {select('timeline', 'Timeline', TIMELINES, lead.timeline)}
                  {select('intent', 'Intent', INTENTS, lead.intent)}
                </ActionForm>
              ) : (
                <dl className="grid gap-2 text-sm sm:grid-cols-3">
                  <Item term="Looking to" value={label(lead.transactionType)} />
                  <Item term="Property type" value={label(lead.propertyType)} />
                  <Item term="City" value={lead.preferredCity ?? '—'} />
                  <Item
                    term="Budget"
                    value={`${fmtInr(lead.budgetMin)} – ${fmtInr(lead.budgetMax)}`}
                  />
                  <Item term="Localities" value={lead.preferredLocalities.join(', ') || '—'} />
                  <Item term="BHK" value={`${lead.bhkMin ?? '—'} – ${lead.bhkMax ?? '—'}`} />
                  <Item term="Purpose" value={label(lead.purpose)} />
                  <Item term="Timeline" value={label(lead.timeline)} />
                  <Item term="Intent" value={label(lead.intent)} />
                </dl>
              )}
            </Card>

            {(activeDefs.length > 0 || archivedValues.length > 0) && (
              <Card title="Custom fields">
                {lead.canUpdate && activeDefs.length > 0 ? (
                  <ActionForm
                    action={setCustomFieldsAction}
                    submitLabel="Save custom fields"
                    successMessage="Custom fields saved."
                    className="grid gap-4 sm:grid-cols-2"
                  >
                    <input type="hidden" name="leadId" value={lead.id} />
                    <input type="hidden" name="version" value={lead.version} />
                    <CustomFieldInputs
                      fields={activeDefs}
                      values={lead.customFields}
                      requireRequired={false}
                    />
                  </ActionForm>
                ) : (
                  <dl className="grid gap-2 text-sm sm:grid-cols-2">
                    {activeDefs.map((f) => (
                      <Item
                        key={f.key}
                        term={f.label}
                        value={customText(lead.customFields[f.key])}
                      />
                    ))}
                  </dl>
                )}
                {archivedValues.length > 0 && (
                  <dl className="mt-4 grid gap-2 border-t border-slate-100 pt-4 text-sm sm:grid-cols-2">
                    {archivedValues.map((f) => (
                      <Item
                        key={f.key}
                        term={`${f.label} (archived field)`}
                        value={customText(lead.customFields[f.key])}
                      />
                    ))}
                  </dl>
                )}
              </Card>
            )}

            {lead.canViewTimeline && (
              <Card title="Timeline">
                {lead.canUpdate && (
                  <ActionForm
                    action={addNoteAction}
                    submitLabel="Add note"
                    className="mb-6 space-y-2"
                  >
                    <input type="hidden" name="leadId" value={lead.id} />
                    <Field label="New note" htmlFor="note-body">
                      <textarea
                        id="note-body"
                        name="body"
                        required
                        maxLength={5000}
                        rows={3}
                        className={textareaClass}
                      />
                    </Field>
                  </ActionForm>
                )}
                {timeline.length === 0 ? (
                  <EmptyState>No activity yet.</EmptyState>
                ) : (
                  <ol className="space-y-4 text-sm">
                    {timeline.map((t) => (
                      <li key={t.id} className="border-l-2 border-slate-200 pl-3">
                        <p className="text-xs text-slate-500">
                          {fmtDateTime(t.occurredAt)} · {t.actorName ?? 'System'}
                          {t.fromMergedLeadId && (
                            <>
                              {' · '}
                              <Link
                                href={`/app/leads/${t.fromMergedLeadId}` as '/app/leads'}
                                className="tap underline"
                              >
                                from a merged lead
                              </Link>
                            </>
                          )}
                        </p>
                        <TimelineBody entry={t} leadId={lead.id} />
                      </li>
                    ))}
                  </ol>
                )}
              </Card>
            )}
          </div>

          <div className="space-y-6">
            {canMerge && (
              <div id="merge" className="scroll-mt-4">
                <Card
                  title="Merge a duplicate into this lead"
                  description="This lead survives. You will see every field that differs and choose each value before anything changes."
                >
                  <form method="get" action="/app/leads/merge" className="space-y-3">
                    <input type="hidden" name="survivor" value={lead.id} />
                    <Field
                      label="The duplicate lead's ID"
                      htmlFor="merge-other"
                      hint="Open the duplicate and copy the ID from its address."
                    >
                      <Input
                        id="merge-other"
                        name="merged"
                        required
                        pattern="[0-9a-fA-F-]{36}"
                        placeholder="xxxxxxxx-xxxx-xxxx-xxxx-xxxxxxxxxxxx"
                      />
                    </Field>
                    <button
                      type="submit"
                      className="tap rounded-md border border-slate-300 bg-white px-3 py-2 text-sm font-medium text-slate-900 hover:bg-slate-50"
                    >
                      Preview merge
                    </button>
                  </form>
                </Card>
              </div>
            )}
            {assignTo && (
              <Card
                title={lead.ownerUserId ? 'Reassign' : 'Assign'}
                description={
                  lead.ownerUserId
                    ? 'The current owner loses access unless they can see it another way. Their open follow-up and tasks on this lead move to the new owner (cancelled if the lead goes to a queue).'
                    : 'Give this lead an owner, or deal it to a team in turn.'
                }
              >
                <ActionForm
                  action={assignLeadAction}
                  submitLabel={lead.ownerUserId ? 'Reassign' : 'Assign'}
                >
                  <input type="hidden" name="leadId" value={lead.id} />
                  <input type="hidden" name="version" value={lead.version} />
                  <Field label="New owner" htmlFor="assign-target">
                    <Select id="assign-target" name="target" required defaultValue="">
                      <option value="" disabled>
                        Choose…
                      </option>
                      {assignTo.people
                        .filter((p) => p.userId !== lead.ownerUserId)
                        .map((p) => (
                          <option key={p.userId} value={`user:${p.userId}`}>
                            {p.name}
                          </option>
                        ))}
                      {assignTo.teams.map((t) => (
                        <option key={t.id} value={`team:${t.id}`}>
                          {t.name} queue (unassigned)
                        </option>
                      ))}
                      {assignTo.orgQueue && (
                        <option value="queue">Organisation queue (unassigned)</option>
                      )}
                    </Select>
                  </Field>
                  <Field
                    label={lead.ownerUserId ? 'Reason (required)' : 'Reason (optional)'}
                    htmlFor="assign-reason"
                  >
                    <textarea
                      id="assign-reason"
                      name="reason"
                      maxLength={500}
                      rows={2}
                      required={!!lead.ownerUserId}
                      className={textareaClass}
                    />
                  </Field>
                </ActionForm>
                {!lead.ownerUserId && assignTo.teams.length > 0 && (
                  <ActionForm
                    action={roundRobinAction}
                    submitLabel="Round-robin"
                    successMessage="Assigned."
                    className="mt-4 flex flex-wrap items-end gap-2 border-t border-slate-100 pt-4"
                  >
                    <input type="hidden" name="leadId" value={lead.id} />
                    <Field label="Next in turn from team" htmlFor="rr-team">
                      <Select id="rr-team" name="teamId" required defaultValue={lead.teamId ?? ''}>
                        <option value="" disabled>
                          Choose…
                        </option>
                        {assignTo.teams.map((t) => (
                          <option key={t.id} value={t.id}>
                            {t.name}
                          </option>
                        ))}
                      </Select>
                    </Field>
                  </ActionForm>
                )}
              </Card>
            )}
            {lead.canViewAssignmentHistory && (
              <Card title="Assignment history">
                {spells.length === 0 ? (
                  <EmptyState>Never assigned.</EmptyState>
                ) : (
                  <ol className="space-y-3 text-sm">
                    {spells.map((sp) => (
                      <li key={sp.id} className="border-l-2 border-slate-200 pl-3">
                        <p className="font-medium text-slate-900">
                          {sp.ownerName ?? 'Unassigned'}
                          {sp.teamName ? ` · ${sp.teamName}` : ''}
                        </p>
                        <p className="text-xs text-slate-500">
                          {fmtDateTime(sp.startedAt)} –{' '}
                          {sp.endedAt ? fmtDateTime(sp.endedAt) : 'now'} ·{' '}
                          {SOURCE_LABELS[sp.source] ?? sp.source}
                          {sp.assignedByName ? ` by ${sp.assignedByName}` : ''}
                        </p>
                        {sp.reason && <p className="text-xs text-slate-600">{sp.reason}</p>}
                      </li>
                    ))}
                  </ol>
                )}
              </Card>
            )}
            {lead.canChangeStage && targets.length > 0 && (
              <Card
                title="Change stage"
                description="Moving back needs a reason. Lost needs a reason; Nurture needs a follow-up date."
              >
                <ActionForm action={changeStageAction} submitLabel="Change stage">
                  <input type="hidden" name="leadId" value={lead.id} />
                  <input type="hidden" name="version" value={lead.version} />
                  <Field label="New stage" htmlFor="stage-to">
                    <Select id="stage-to" name="toStage" required defaultValue="">
                      <option value="" disabled>
                        Choose…
                      </option>
                      {targets.map((s: LeadStage) => (
                        <option key={s} value={s}>
                          {STAGE_LABELS[s]}
                        </option>
                      ))}
                    </Select>
                  </Field>
                  <Field label="Lost reason (for Lost)" htmlFor="stage-reason-code">
                    <Select id="stage-reason-code" name="reasonCode" defaultValue="">
                      <option value="">—</option>
                      {Object.entries(LOST_REASONS).map(([code, text]) => (
                        <option key={code} value={code}>
                          {text}
                        </option>
                      ))}
                    </Select>
                  </Field>
                  <Field
                    label="Reason or visit feedback"
                    htmlFor="stage-reason-text"
                    hint="Required when moving back and for a completed visit."
                  >
                    <textarea
                      id="stage-reason-text"
                      name="reasonText"
                      maxLength={1000}
                      rows={2}
                      className={textareaClass}
                    />
                  </Field>
                  <Field label="Visit date and time (for a scheduled visit)" htmlFor="stage-visit">
                    <Input id="stage-visit" name="visitAt" type="datetime-local" />
                  </Field>
                  <Field label="Follow up again on (for Nurture)" htmlFor="stage-nurture">
                    <Input id="stage-nurture" name="nurtureUntil" type="date" />
                  </Field>
                </ActionForm>
              </Card>
            )}
          </div>
        </div>
      </ShownScriptProvider>
    </>
  );
}

function customText(v: unknown): string {
  if (v === undefined || v === null) return '—';
  if (v === true) return 'Yes';
  if (v === false) return 'No';
  return Array.isArray(v) ? v.join(', ') : String(v);
}

function Item({ term, value }: { term: string; value: string }) {
  return (
    <div>
      <dt className="text-xs text-slate-500">{term}</dt>
      <dd className="text-slate-900">{value}</dd>
    </div>
  );
}

const SOURCE_LABELS: Record<string, string> = {
  MANUAL: 'Manual',
  BULK: 'Bulk',
  ROUND_ROBIN: 'Round-robin',
  DEACTIVATION: 'Handover (owner removed)',
  IMPORT: 'Import',
};

const FIELD_LABELS: Record<string, string> = {
  transactionType: 'looking to',
  propertyType: 'property type',
  bhkMin: 'BHK from',
  bhkMax: 'BHK up to',
  budgetMin: 'budget from',
  budgetMax: 'budget up to',
  preferredCity: 'city',
  preferredLocalities: 'localities',
  purpose: 'purpose',
  timeline: 'timeline',
  intent: 'intent',
};

function TimelineBody({ entry: t, leadId }: { entry: TimelineEntry; leadId: string }) {
  const s = t.summary;
  const stage = (v: unknown) => STAGE_LABELS[v as LeadStage] ?? String(v);
  switch (t.type) {
    case 'CREATED':
      return <p>Lead created{s.returning ? ' (returning customer)' : ''}.</p>;
    case 'ENQUIRY':
      return (
        <p>
          New enquiry attached{s.reportedDuplicate ? ' (reported as a returning customer)' : ''}.
        </p>
      );
    case 'ASSIGNED':
      return (
        <p>
          {s.toUserId ? 'Assigned' : 'Moved to the unassigned queue'} (
          {SOURCE_LABELS[String(s.source)] ?? String(s.source)})
          {typeof s.stage === 'string' ? ` · stage ${stage(s.stage)}` : ''}.
        </p>
      );
    case 'FIELD_CHANGED':
      return (
        <p>
          Updated{' '}
          {[
            ...((s.fields as string[] | undefined) ?? []).map((f) => FIELD_LABELS[f] ?? f),
            ...((s.customFields as string[] | undefined) ?? []).map((f) => `custom field ${f}`),
          ].join(', ')}
          .
        </p>
      );
    case 'ARCHIVED':
      return (
        <p>
          Archived{s.bulk ? ' (bulk)' : ''}
          {typeof s.reason === 'string' ? `: ${s.reason}` : ''}.
        </p>
      );
    case 'RESTORED':
      return <p>Restored from the archive.</p>;
    case 'MERGED':
      return typeof s.mergedIntoLeadId === 'string' ? (
        <p>
          Merged into{' '}
          <Link href={`/app/leads/${s.mergedIntoLeadId}` as '/app/leads'} className="tap underline">
            another lead
          </Link>
          .
        </p>
      ) : (
        <p>
          A duplicate lead was merged into this one
          {Array.isArray(s.filled) && s.filled.length
            ? ` (filled: ${(s.filled as string[]).map((f) => FIELD_LABELS[f] ?? f).join(', ')})`
            : ''}
          . Its history appears below, marked “from a merged lead”.
        </p>
      );
    case 'STAGE':
      return (
        <p>
          Stage {stage(s.from)} → {stage(s.to)}
          {Array.isArray(s.implied) && s.implied.length > 0
            ? ` (via ${s.implied.map(stage).join(', ')})`
            : ''}
          {typeof s.reasonCode === 'string'
            ? ` · ${LOST_REASONS[s.reasonCode as keyof typeof LOST_REASONS] ?? s.reasonCode}`
            : ''}
          {typeof s.visitAt === 'string' ? ` · visit ${fmtDateTime(new Date(s.visitAt))}` : ''}
          {typeof s.nurtureUntil === 'string'
            ? ` · follow up ${fmtDateTime(new Date(s.nurtureUntil))}`
            : ''}
          {s.rule === 'FIRST_CONNECTED_INTERACTION'
            ? ' · after the first connected interaction'
            : ''}
        </p>
      );
    case 'NOTE':
      if (!t.note) return <p>Note.</p>;
      return t.note.editable ? (
        <ActionForm action={editNoteAction} submitLabel="Save note" className="space-y-2">
          <input type="hidden" name="leadId" value={leadId} />
          <input type="hidden" name="noteId" value={t.note.id} />
          <textarea
            name="body"
            aria-label="Edit note"
            defaultValue={t.note.body}
            maxLength={5000}
            rows={3}
            className={textareaClass}
          />
          <p className="text-xs text-slate-500">You can edit this note for 15 minutes.</p>
        </ActionForm>
      ) : (
        <p className="whitespace-pre-wrap">
          {t.note.body}
          {t.note.edited && <span className="text-xs text-slate-500"> (edited)</span>}
        </p>
      );
    case 'CONTACT_STATUS': {
      const st = (v: unknown) => CONTACT_STATUS_LABELS[v as ContactStatus] ?? String(v);
      return (
        <p>
          Contact status {st(s.from)} → {st(s.to)}
          {s.origin === 'CARRY_OVER' ? ' (carried over from an earlier lead for this number)' : ''}
          {s.origin === 'MERGE' ? ' (carried over from a merged duplicate)' : ''}
          {typeof s.method === 'string' ? ` · ${CONTACT_METHOD_LABELS[s.method] ?? s.method}` : ''}.
        </p>
      );
    }
    case 'INTERACTION': {
      // FR-085: manual records and (later) provider-verified ones are visibly different.
      const outcome = OUTCOME_LABELS[s.outcome as Outcome] ?? String(s.outcome);
      const happened = typeof s.occurredAt === 'string' ? new Date(s.occurredAt) : null;
      return (
        <div className="space-y-1">
          <p className="flex flex-wrap items-center gap-2">
            <Badge tone={s.source === 'PROVIDER' ? 'good' : 'neutral'}>
              {s.source === 'PROVIDER' ? 'Verified by provider' : 'Logged by user'}
            </Badge>
            <span>
              {CHANNEL_LABELS[s.channel as Channel] ?? String(s.channel)} ·{' '}
              {DIRECTION_LABELS[s.direction as Direction] ?? String(s.direction)} · {outcome}
              {typeof s.durationMinutes === 'number' ? ` · about ${s.durationMinutes} min` : ''}
            </span>
          </p>
          {happened && <p className="text-xs text-slate-500">Happened {fmtDateTime(happened)}</p>}
          {t.interaction?.notes && <p className="whitespace-pre-wrap">{t.interaction.notes}</p>}
        </div>
      );
    }
    case 'SITE_VISIT': {
      const when = (v: unknown) => (typeof v === 'string' ? fmtDateTime(new Date(v)) : '');
      const reason = typeof s.reason === 'string' && s.reason ? ` · ${s.reason}` : '';
      switch (s.action) {
        case 'scheduled':
          return <p>Site visit scheduled for {when(s.scheduledFor)}.</p>;
        case 'confirmed':
          return <p>Site visit confirmed.</p>;
        case 'rescheduled':
          return (
            <p>
              Site visit rescheduled from {when(s.previousScheduledFor)} to {when(s.scheduledFor)}
              {reason}.
            </p>
          );
        case 'cancelled':
          return (
            <p>
              Site visit for {when(s.scheduledFor)} cancelled{reason}.
            </p>
          );
        case 'no_show':
          return (
            <p>
              Site visit for {when(s.scheduledFor)}: no-show{reason}.
            </p>
          );
        case 'attended':
          return <p>Site visit for {when(s.scheduledFor)} attended.</p>;
        default:
          return <p>Site visit updated.</p>;
      }
    }
    case 'TASK': {
      const when = (v: unknown) => (typeof v === 'string' ? fmtDateTime(new Date(v)) : '');
      const reason = typeof s.reason === 'string' && s.reason ? ` · ${s.reason}` : '';
      // Entries before FR-100's other types carry no taskType: they are follow-ups.
      const what =
        typeof s.taskType === 'string' && s.taskType in TASK_TYPE_LABELS
          ? `${TASK_TYPE_LABELS[s.taskType as TaskType]} task`
          : 'Follow-up';
      switch (s.action) {
        case 'scheduled':
          return (
            <p>
              {what} scheduled for {when(s.dueAt)}.
            </p>
          );
        case 'rescheduled':
          return (
            <p>
              {what} rescheduled from {when(s.previousDueAt)} to {when(s.dueAt)}
              {reason}.
            </p>
          );
        case 'completed':
          return (
            <p>
              {what} for {when(s.dueAt)} marked done.
            </p>
          );
        case 'handed_over':
          return (
            <p>
              {what} for {when(s.dueAt)} handed over to the{' '}
              {s.cause === 'DEACTIVATED' ? "lead's owner (previous assignee removed)" : 'new owner'}
              .
            </p>
          );
        case 'cancelled':
          return (
            <p>
              {what} for {when(s.dueAt)} cancelled{reason}.
            </p>
          );
        case 'details_changed':
          // FR-104: end, location (never shown here: it may be an address) and attendees.
          return <p>Meeting details updated (ends {when(s.endAt)}).</p>;
        default:
          return <p>{what} updated.</p>;
      }
    }
    default:
      return <p>{t.type}</p>;
  }
}
