'use client';
// FR-107: the caller's active recurring series on My Day, each with Edit (future occurrences only)
// and Stop (no further occurrences; the open task stays). Stopping asks for a second, in-page
// confirmation; no browser dialog. The server re-checks ownership, the version and every value.
import { startTransition, useActionState, useState, type FormEvent } from 'react';
import { fieldErrorLines } from '@/components/action-form';
import { Alert, Badge, Button } from '@/components/ui';
import type { SeriesView } from '@/modules/tasks';
import { stopSeriesAction, updateSeriesAction } from '@/modules/tasks/actions';
import { TASK_TYPE_LABELS, type TaskType } from '@/modules/tasks/follow-up-rules';
import type { ActionResult } from '@/platform/errors';
import { SeriesFields } from './series-fields';

const LABELS = {
  title: 'Task',
  frequency: 'Repeats',
  weekday: 'Day of the week',
  localTime: 'Time',
  endDate: 'Ends on',
  durationMinutes: 'Length',
  location: 'Location or link',
  attendeeUserIds: 'Attendees',
};
const due = (d: Date) =>
  d.toLocaleString('en-IN', {
    day: 'numeric',
    month: 'short',
    hour: 'numeric',
    minute: '2-digit',
    timeZone: 'Asia/Kolkata',
  });

export function SeriesList({
  series,
  people,
}: {
  series: SeriesView[];
  people: { userId: string; name: string }[];
}) {
  return (
    <ul aria-label="Repeating tasks" className="divide-y divide-slate-100">
      {series.map((s) => (
        <SeriesItem key={s.id} s={s} people={people} />
      ))}
    </ul>
  );
}

type State = ActionResult<unknown> | null;

function SeriesItem({ s, people }: { s: SeriesView; people: { userId: string; name: string }[] }) {
  const [editState, edit, editing] = useActionState(updateSeriesAction, null);
  const [stopState, stop, stopping] = useActionState(stopSeriesAction, null);
  const [panel, setPanel] = useState<'edit' | 'stop' | null>(null);
  const [last, setLast] = useState<{ kind: 'edit' | 'stop'; before: State } | null>(null);
  const states = { edit: editState, stop: stopState };
  const result = last && states[last.kind] !== last.before ? states[last.kind] : null;
  // A stopped series stays in the list (no re-render) showing its new state, without controls.
  const stopped = stopState?.ok === true;
  const open = result?.ok || stopped ? null : panel;
  const submit =
    (kind: 'edit' | 'stop', action: (fd: FormData) => void) => (e: FormEvent<HTMLFormElement>) => {
      e.preventDefault();
      const data = new FormData(e.currentTarget);
      setLast({ kind, before: states[kind] });
      startTransition(() => action(data));
    };
  const errors =
    result && !result.ok ? fieldErrorLines(result.error.fieldErrors ?? {}, LABELS) : [];
  const hidden = (
    <>
      <input type="hidden" name="seriesId" value={s.id} />
      <input type="hidden" name="version" value={s.version} />
    </>
  );
  return (
    <li className="space-y-2 py-3 text-sm" data-testid="series-item">
      <div className="flex flex-wrap items-center gap-2">
        <span className="font-medium text-slate-900">{s.title}</span>
        <Badge>{TASK_TYPE_LABELS[s.type as TaskType]}</Badge>
        {stopped && <Badge tone="warn">Stopped</Badge>}
      </div>
      <p className="text-slate-700">{s.summary}</p>
      <p className="text-xs text-slate-600">
        {s.nextDueAt ? `Current occurrence: ${due(s.nextDueAt)}` : 'No open occurrence'}
      </p>
      {result?.ok && last && (
        <Alert tone="success">
          {last.kind === 'edit'
            ? 'Saved. Future occurrences use the new details.'
            : 'Series stopped. The current task is unchanged.'}
        </Alert>
      )}
      {result && !result.ok && (
        <Alert tone="error">
          {result.error.message}
          {errors.length > 0 && (
            <ul className="mt-1 list-disc pl-5">
              {errors.map((l) => (
                <li key={l}>{l}</li>
              ))}
            </ul>
          )}
        </Alert>
      )}
      <div className="flex flex-wrap gap-2" hidden={stopped}>
        <Button
          type="button"
          variant="secondary"
          aria-expanded={open === 'edit'}
          onClick={() => {
            setLast(null);
            setPanel(open === 'edit' ? null : 'edit');
          }}
        >
          Edit series…
        </Button>
        <Button
          type="button"
          variant="ghost"
          aria-expanded={open === 'stop'}
          onClick={() => {
            setLast(null);
            setPanel(open === 'stop' ? null : 'stop');
          }}
        >
          Stop series…
        </Button>
      </div>
      {open === 'edit' && (
        <form onSubmit={submit('edit', edit)} className="space-y-3">
          {hidden}
          <p className="text-xs text-slate-600">
            Changes apply to future occurrences only. The current task keeps its details.
          </p>
          <SeriesFields
            idPrefix={`se-${s.id}`}
            people={people}
            meeting={s.type === 'MEETING'}
            defaults={s}
          />
          <Button type="submit" disabled={editing || stopping}>
            {editing ? 'Saving…' : 'Save series'}
          </Button>
        </form>
      )}
      {open === 'stop' && (
        <form onSubmit={submit('stop', stop)} className="space-y-2">
          {hidden}
          <p className="text-slate-700">
            No further occurrences will be created. The current task stays; complete or cancel it as
            usual.
          </p>
          <Button type="submit" variant="danger" disabled={editing || stopping}>
            {stopping ? 'Stopping…' : 'Stop this series'}
          </Button>
        </form>
      )}
    </li>
  );
}
