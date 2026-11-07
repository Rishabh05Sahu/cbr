// FR-107 recurring-series fields (ADR-0020), shared by the create form and the edit form: how
// often (daily, or weekly on one weekday), the org-local time, an optional inclusive end date, and
// for meetings the length, location and attendees. Plain markup: the server validates everything.
import { Field, Input, Select } from '@/components/ui';
import type { SeriesRule } from '@/modules/tasks';
import { WEEKDAY_NAMES } from '@/modules/tasks/series-rules';

export interface SeriesDefaults {
  title: string;
  priority: string;
  rule: SeriesRule;
  durationMinutes: number | null;
  location: string | null;
  attendeeUserIds: string[];
}

const PRIORITIES = ['LOW', 'NORMAL', 'HIGH', 'URGENT'] as const;

export function SeriesFields({
  idPrefix,
  people,
  meeting,
  defaults,
}: {
  idPrefix: string;
  people: { userId: string; name: string }[];
  /** Show the meeting fields: always in the create form (for meetings only), or for a meeting. */
  meeting: 'maybe' | boolean;
  defaults?: SeriesDefaults;
}) {
  const r = defaults?.rule;
  return (
    <div className="grid gap-4 sm:grid-cols-2">
      <Field label="Task" htmlFor={`${idPrefix}-title`}>
        <Input
          id={`${idPrefix}-title`}
          name="title"
          maxLength={200}
          required
          defaultValue={defaults?.title}
        />
      </Field>
      <Field label="Priority" htmlFor={`${idPrefix}-priority`}>
        <Select
          id={`${idPrefix}-priority`}
          name="priority"
          defaultValue={defaults?.priority ?? 'NORMAL'}
        >
          {PRIORITIES.map((p) => (
            <option key={p} value={p}>
              {p.charAt(0) + p.slice(1).toLowerCase()}
            </option>
          ))}
        </Select>
      </Field>
      <Field label="Repeats" htmlFor={`${idPrefix}-frequency`}>
        <Select
          id={`${idPrefix}-frequency`}
          name="frequency"
          defaultValue={r?.frequency ?? 'DAILY'}
          required
        >
          <option value="DAILY">Every day</option>
          <option value="WEEKLY">Every week</option>
        </Select>
      </Field>
      <Field label="Day of the week (weekly only)" htmlFor={`${idPrefix}-weekday`}>
        <Select
          id={`${idPrefix}-weekday`}
          name="weekday"
          defaultValue={r?.weekday === null || r?.weekday === undefined ? '0' : String(r.weekday)}
        >
          {WEEKDAY_NAMES.map((d, i) => (
            <option key={d} value={String(i)}>
              {d}
            </option>
          ))}
        </Select>
      </Field>
      <Field label="At (your organisation's time)" htmlFor={`${idPrefix}-time`}>
        <Input
          id={`${idPrefix}-time`}
          name="localTime"
          type="time"
          required
          defaultValue={r?.localTime}
        />
      </Field>
      <Field
        label="Ends on (optional)"
        htmlFor={`${idPrefix}-end`}
        hint="The last day included. Leave empty to repeat until you stop it."
      >
        <Input
          id={`${idPrefix}-end`}
          name="endDate"
          type="date"
          defaultValue={r?.endDate ?? undefined}
        />
      </Field>
      {meeting !== false && (
        <fieldset className="space-y-4 rounded-md border border-slate-200 p-3 sm:col-span-2">
          <legend className="px-1 text-sm font-medium text-slate-800">
            {meeting === 'maybe' ? 'Meeting details (meetings only)' : 'Meeting details'}
          </legend>
          <div className="grid gap-4 sm:grid-cols-2">
            <Field
              label={
                meeting === 'maybe'
                  ? 'Length in minutes (required for a meeting)'
                  : 'Length in minutes'
              }
              htmlFor={`${idPrefix}-duration`}
            >
              <Input
                id={`${idPrefix}-duration`}
                name="durationMinutes"
                type="number"
                min={1}
                max={1440}
                required={meeting === true}
                defaultValue={defaults?.durationMinutes ?? undefined}
              />
            </Field>
            <Field label="Location or link (optional)" htmlFor={`${idPrefix}-location`}>
              <Input
                id={`${idPrefix}-location`}
                name="location"
                maxLength={300}
                defaultValue={defaults?.location ?? undefined}
              />
            </Field>
          </div>
          {people.length > 0 && (
            <fieldset>
              <legend className="text-sm text-slate-800">Attendees (optional)</legend>
              <p className="text-xs text-slate-500">
                Invited to every occurrence and notified in the app.
              </p>
              <ul className="mt-2 max-h-48 space-y-1 overflow-y-auto rounded border border-slate-100 p-2">
                {people.map((p) => (
                  <li key={p.userId}>
                    <label className="tap flex items-center gap-2 text-sm">
                      <input
                        type="checkbox"
                        name="attendeeUserIds"
                        value={p.userId}
                        defaultChecked={defaults?.attendeeUserIds.includes(p.userId)}
                      />
                      {p.name}
                    </label>
                  </li>
                ))}
              </ul>
            </fieldset>
          )}
        </fieldset>
      )}
    </div>
  );
}
