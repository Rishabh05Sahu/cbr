// FR-104 meeting details in a form: end time (required for a meeting), "location or link" and
// internal attendees (any active member, owner decision 2026-10-30). Used by the add-task forms
// (lead page, My Day), where the fields apply only when the type is Meeting, and by the edit
// form of a meeting. Plain markup: the server validates and refuses these fields on other types.
import { Field, Input } from '@/components/ui';

export interface MeetingPerson {
  userId: string;
  name: string;
}

export function MeetingFields({
  idPrefix,
  people,
  endAtLocal = null,
  location = null,
  attendeeIds = [],
  meetingOnly = true,
}: {
  idPrefix: string;
  /** Who may be invited (the caller is never listed). */
  people: MeetingPerson[];
  endAtLocal?: string | null;
  location?: string | null;
  attendeeIds?: string[];
  /** In an add-task form: the fields are for meetings only (said in the legend). */
  meetingOnly?: boolean;
}) {
  return (
    <fieldset className="space-y-4 rounded-md border border-slate-200 p-3 sm:col-span-2">
      <legend className="px-1 text-sm font-medium text-slate-800">
        {meetingOnly ? 'Meeting details (meetings only)' : 'Meeting details'}
      </legend>
      <div className="grid gap-4 sm:grid-cols-2">
        <Field
          label={meetingOnly ? 'Ends at (required for a meeting)' : 'Ends at'}
          htmlFor={`${idPrefix}-end`}
        >
          <Input
            id={`${idPrefix}-end`}
            name="endAt"
            type="datetime-local"
            defaultValue={endAtLocal ?? undefined}
            required={!meetingOnly}
          />
        </Field>
        <Field label="Location or link (optional)" htmlFor={`${idPrefix}-location`}>
          <Input
            id={`${idPrefix}-location`}
            name="location"
            maxLength={300}
            defaultValue={location ?? undefined}
          />
        </Field>
      </div>
      {people.length > 0 && (
        <fieldset>
          <legend className="text-sm text-slate-800">Attendees (optional)</legend>
          <p className="text-xs text-slate-500">
            They see the meeting on their My Day and are notified in the app. Inviting someone does
            not give them access to the lead.
          </p>
          <ul className="mt-2 max-h-48 space-y-1 overflow-y-auto rounded border border-slate-100 p-2">
            {people.map((p) => (
              <li key={p.userId}>
                <label className="tap flex items-center gap-2 text-sm">
                  <input
                    type="checkbox"
                    name="attendeeUserIds"
                    value={p.userId}
                    defaultChecked={attendeeIds.includes(p.userId)}
                  />
                  {p.name}
                </label>
              </li>
            ))}
          </ul>
        </fieldset>
      )}
    </fieldset>
  );
}

/** One line for a meeting's end, location and attendees (lead page and My Day rows). */
export function meetingSummary(
  t: { endAt: Date | null; location: string | null; attendees: MeetingPerson[] },
  fmt: (d: Date) => string,
): string[] {
  const out: string[] = [];
  if (t.endAt) out.push(`Until ${fmt(t.endAt)}`);
  if (t.location) out.push(`Where: ${t.location}`);
  if (t.attendees.length) out.push(`With: ${t.attendees.map((a) => a.name).join(', ')}`);
  return out;
}
