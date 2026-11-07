'use client';
// Bulk actions on the lead list (FR-063): server-rendered rows carry checkboxes named "item"
// ("<leadId>:<version>"). One form, one submit button per action (each with its own server action
// via formAction); only the actions the page allows are shown. Every action is all or nothing on
// the server, and each confirmation names the count and the target team or tag.
import {
  useActionState,
  useEffect,
  useRef,
  useState,
  type MouseEvent,
  type ReactNode,
} from 'react';
import { Alert, Button, Field, Select } from '@/components/ui';
import { bulkAddTagAction, bulkArchiveAction, bulkChangeTeamAction } from '@/modules/leads/actions';
import { bulkFeedback, type BulkKind, type CurrentRun } from './bulk-feedback';

type Option = { id: string; name: string };

export function BulkActionsForm({
  children,
  max,
  empty = false,
  archive,
  teams,
  tags,
}: {
  children: ReactNode;
  max: number;
  /** No rows to act on (children is the empty state): only the last result is shown. */
  empty?: boolean;
  archive: boolean;
  /** Teams the caller may move leads to (null: no permission). */
  teams: Option[] | null;
  /** The org's tags (null: no permission). */
  tags: Option[] | null;
}) {
  const [archiveState, archiveAction, archivePending] = useActionState(bulkArchiveAction, null);
  const [teamState, teamAction, teamPending] = useActionState(bulkChangeTeamAction, null);
  const [tagState, tagAction, tagPending] = useActionState(bulkAddTagAction, null);
  const [count, setCount] = useState(0);
  const [teamId, setTeamId] = useState('');
  const [tagId, setTagId] = useState('');
  const form = useRef<HTMLFormElement>(null);
  const recount = () =>
    setCount(form.current?.querySelectorAll('input[name="item"]:checked').length ?? 0);
  // The list is re-rendered after every action: count what is still checked.
  useEffect(recount, [archiveState, teamState, tagState]);
  const pending = archivePending || teamPending || tagPending;
  const leadsWord = (n: number) => `${n} selected lead${n === 1 ? '' : 's'}`;

  /** Refuses an empty or too large selection, then asks for confirmation; true when it goes ahead. */
  const guard = (e: MouseEvent<HTMLButtonElement>, message: string) => {
    if (count === 0) {
      e.preventDefault();
      window.alert('Select at least one lead.');
    } else if (count > max) {
      e.preventDefault();
      window.alert(`Select at most ${max} leads.`);
    } else if (!window.confirm(message)) e.preventDefault();
    else return true;
    return false;
  };
  const teamName = teams?.find((t) => t.id === teamId)?.name;
  const tagName = tags?.find((t) => t.id === tagId)?.name;
  // Only the action started last is reported, and only with the result of that run.
  const [current, setCurrent] = useState<CurrentRun | null>(null);
  const states = { archive: archiveState, team: teamState, tag: tagState };
  const start = (kind: BulkKind, target?: string) =>
    setCurrent({ kind, before: states[kind], ...(target ? { target } : {}) });
  const feedback = bulkFeedback(current, states);

  return (
    <form ref={form} onChange={recount} className="space-y-4">
      {feedback && (
        <Alert tone={feedback.tone}>
          {feedback.text}
          {feedback.conflict && ' The list will show the current versions.'}
        </Alert>
      )}
      {children}
      {!empty && (
        <div className="space-y-4 border-t border-slate-100 pt-4">
          <p className="text-sm text-slate-600" aria-live="polite">
            {count} selected · up to {max} at a time, all or none.
          </p>
          {teams && (
            <div className="flex flex-wrap items-end gap-3">
              <Field label="Change team to" htmlFor="bulk-team">
                <Select
                  id="bulk-team"
                  name="teamId"
                  value={teamId}
                  onChange={(e) => setTeamId(e.target.value)}
                  className="w-64 max-w-full"
                >
                  <option value="">Choose a team</option>
                  {teams.map((t) => (
                    <option key={t.id} value={t.id}>
                      {t.name}
                    </option>
                  ))}
                </Select>
              </Field>
              <Button
                type="submit"
                variant="secondary"
                formAction={teamAction}
                disabled={pending || count === 0 || !teamId}
                onClick={(e) => {
                  if (
                    guard(
                      e,
                      `Move ${leadsWord(count)} to the team “${teamName}”? Owners stay the same.`,
                    )
                  )
                    start('team', teamName);
                }}
              >
                {teamPending ? 'Changing…' : 'Change team'}
              </Button>
            </div>
          )}
          {tags && (
            <div className="flex flex-wrap items-end gap-3">
              <Field
                label="Add tag"
                htmlFor="bulk-tag"
                {...(tags.length === 0
                  ? { hint: 'No tags yet: an Owner or Admin adds them under Lead tags.' }
                  : {})}
              >
                <Select
                  id="bulk-tag"
                  name="tagId"
                  value={tagId}
                  onChange={(e) => setTagId(e.target.value)}
                  className="w-64 max-w-full"
                >
                  <option value="">Choose a tag</option>
                  {tags.map((t) => (
                    <option key={t.id} value={t.id}>
                      {t.name}
                    </option>
                  ))}
                </Select>
              </Field>
              <Button
                type="submit"
                variant="secondary"
                formAction={tagAction}
                disabled={pending || count === 0 || !tagId}
                onClick={(e) => {
                  if (guard(e, `Add the tag “${tagName}” to ${leadsWord(count)}?`)) start('tag');
                }}
              >
                {tagPending ? 'Tagging…' : 'Add tag'}
              </Button>
            </div>
          )}
          {archive && (
            <div className="flex flex-wrap items-end gap-3">
              <Field label="Reason (optional)" htmlFor="bulk-archive-reason">
                <input
                  id="bulk-archive-reason"
                  name="reason"
                  maxLength={500}
                  className="block w-64 max-w-full rounded-md border border-slate-300 px-3 py-2 text-sm"
                />
              </Field>
              <Button
                type="submit"
                variant="danger"
                formAction={archiveAction}
                disabled={pending || count === 0}
                onClick={(e) => {
                  if (guard(e, `Archive ${leadsWord(count)}? They can be restored later.`))
                    start('archive');
                }}
              >
                {archivePending ? 'Archiving…' : 'Archive selected'}
              </Button>
            </div>
          )}
        </div>
      )}
    </form>
  );
}
