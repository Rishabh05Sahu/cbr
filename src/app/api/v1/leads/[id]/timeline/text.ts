// Timeline entries as plain sentences for the Android app (owner request 2026-11-24: lead
// history in the app). The same wording as the website's lead page (TimelineBody in
// src/app/(app)/app/leads/[id]/page.tsx), without links or forms. `kind` lets the app pick an icon.
import { fmtDateTime } from '@/app/(app)/app/leads/labels';
import {
  CHANNEL_LABELS,
  DIRECTION_LABELS,
  OUTCOME_LABELS,
  type Channel,
  type Direction,
  type Outcome,
} from '@/modules/interactions';
import {
  CONTACT_METHOD_LABELS,
  CONTACT_STATUS_LABELS,
  LOST_REASONS,
  STAGE_LABELS,
  type ContactStatus,
  type LeadStage,
  type TimelineEntry,
} from '@/modules/leads';
import { TASK_TYPE_LABELS } from '@/modules/tasks/follow-up-rules';

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
  fullName: 'name',
  alternatePhoneE164: 'alternate number',
  email: 'email',
  preferredLanguage: 'language',
  preferredContactMethod: 'preferred contact',
};

export type TimelineKind =
  'call' | 'stage' | 'visit' | 'task' | 'note' | 'assigned' | 'status' | 'edit' | 'lead';

export interface TimelineLine {
  kind: TimelineKind;
  text: string;
  /** Extra lines: an interaction's notes, a note's body. */
  detail: string | null;
}

const when = (v: unknown) => (typeof v === 'string' ? fmtDateTime(new Date(v)) : '');
const stage = (v: unknown) => STAGE_LABELS[v as LeadStage] ?? String(v);

export function timelineLine(t: TimelineEntry): TimelineLine {
  const s = t.summary;
  const line = (kind: TimelineKind, text: string, detail: string | null = null) => ({
    kind,
    text,
    detail,
  });
  const reason = typeof s.reason === 'string' && s.reason ? ` · ${s.reason}` : '';
  switch (t.type) {
    case 'CREATED':
      return line('lead', `Lead created${s.returning ? ' (returning customer)' : ''}.`);
    case 'ENQUIRY':
      return line(
        'lead',
        `New enquiry attached${s.reportedDuplicate ? ' (reported as a returning customer)' : ''}.`,
      );
    case 'ASSIGNED':
      return line(
        'assigned',
        `${s.toUserId ? 'Assigned' : 'Moved to the unassigned queue'} (${
          SOURCE_LABELS[String(s.source)] ?? String(s.source)
        })${typeof s.stage === 'string' ? ` · stage ${stage(s.stage)}` : ''}.`,
      );
    case 'FIELD_CHANGED':
      return line(
        'edit',
        `Updated ${[
          ...((s.fields as string[] | undefined) ?? []).map((f) => FIELD_LABELS[f] ?? f),
          ...((s.customFields as string[] | undefined) ?? []).map((f) => `custom field ${f}`),
        ].join(', ')}.`,
      );
    case 'ARCHIVED':
      return line(
        'lead',
        `Archived${s.bulk ? ' (bulk)' : ''}${typeof s.reason === 'string' ? `: ${s.reason}` : ''}.`,
      );
    case 'RESTORED':
      return line('lead', 'Restored from the archive.');
    case 'MERGED':
      return line(
        'lead',
        typeof s.mergedIntoLeadId === 'string'
          ? 'Merged into another lead.'
          : 'A duplicate lead was merged into this one.',
      );
    case 'STAGE':
      return line(
        'stage',
        `Stage ${stage(s.from)} → ${stage(s.to)}${
          Array.isArray(s.implied) && s.implied.length > 0
            ? ` (via ${s.implied.map(stage).join(', ')})`
            : ''
        }${
          typeof s.reasonCode === 'string'
            ? ` · ${LOST_REASONS[s.reasonCode as keyof typeof LOST_REASONS] ?? s.reasonCode}`
            : ''
        }${typeof s.visitAt === 'string' ? ` · visit ${when(s.visitAt)}` : ''}${
          typeof s.nurtureUntil === 'string' ? ` · follow up ${when(s.nurtureUntil)}` : ''
        }`,
        typeof s.reasonText === 'string' && s.reasonText ? s.reasonText : null,
      );
    case 'NOTE':
      return line('note', 'Note', t.note?.body ?? null);
    case 'CONTACT_STATUS': {
      const st = (v: unknown) => CONTACT_STATUS_LABELS[v as ContactStatus] ?? String(v);
      return line(
        'status',
        `Contact status ${st(s.from)} → ${st(s.to)}${
          s.origin === 'CARRY_OVER' ? ' (carried over from an earlier lead for this number)' : ''
        }${s.origin === 'MERGE' ? ' (carried over from a merged duplicate)' : ''}${
          typeof s.method === 'string' ? ` · ${CONTACT_METHOD_LABELS[s.method] ?? s.method}` : ''
        }.`,
      );
    }
    case 'INTERACTION': {
      const outcome = OUTCOME_LABELS[s.outcome as Outcome] ?? String(s.outcome);
      return line(
        'call',
        `${CHANNEL_LABELS[s.channel as Channel] ?? String(s.channel)} · ${
          DIRECTION_LABELS[s.direction as Direction] ?? String(s.direction)
        } · ${outcome}${
          typeof s.durationMinutes === 'number' ? ` · about ${s.durationMinutes} min` : ''
        }`,
        t.interaction?.notes ?? null,
      );
    }
    case 'SITE_VISIT':
      switch (s.action) {
        case 'scheduled':
          return line('visit', `Site visit scheduled for ${when(s.scheduledFor)}.`);
        case 'confirmed':
          return line('visit', 'Site visit confirmed.');
        case 'rescheduled':
          return line(
            'visit',
            `Site visit rescheduled from ${when(s.previousScheduledFor)} to ${when(s.scheduledFor)}${reason}.`,
          );
        case 'cancelled':
          return line('visit', `Site visit for ${when(s.scheduledFor)} cancelled${reason}.`);
        case 'no_show':
          return line('visit', `Site visit for ${when(s.scheduledFor)}: no-show${reason}.`);
        case 'attended':
          return line('visit', `Site visit for ${when(s.scheduledFor)} attended.`);
        default:
          return line('visit', 'Site visit updated.');
      }
    case 'TASK': {
      const what =
        typeof s.taskType === 'string' && s.taskType in TASK_TYPE_LABELS
          ? `${TASK_TYPE_LABELS[s.taskType as keyof typeof TASK_TYPE_LABELS]} task`
          : 'Follow-up';
      switch (s.action) {
        case 'scheduled':
          return line('task', `${what} scheduled for ${when(s.dueAt)}.`);
        case 'rescheduled':
          return line(
            'task',
            `${what} rescheduled from ${when(s.previousDueAt)} to ${when(s.dueAt)}${reason}.`,
          );
        case 'completed':
          return line('task', `${what} for ${when(s.dueAt)} marked done.`);
        case 'handed_over':
          return line(
            'task',
            `${what} for ${when(s.dueAt)} handed over to the ${
              s.cause === 'DEACTIVATED' ? "lead's owner (previous assignee removed)" : 'new owner'
            }.`,
          );
        case 'cancelled':
          return line('task', `${what} for ${when(s.dueAt)} cancelled${reason}.`);
        case 'details_changed':
          return line('task', `Meeting details updated (ends ${when(s.endAt)}).`);
        default:
          return line('task', `${what} updated.`);
      }
    }
    default:
      return line('lead', t.type);
  }
}
