// Feedback for the lead list's bulk actions (FR-063), kept free of React so it can be unit tested.
// Each action keeps its own useActionState result; the form shows only the action the user started
// last, and only once that run has produced a new result (so an earlier success or refusal never
// stays on screen next to, or instead of, the current one).
import type { ActionResult } from '@/platform/errors';

export type BulkKind = 'archive' | 'team' | 'tag';
type State = ActionResult<unknown> | null;

/** The action started last: its kind, its result object at that moment, and the team/tag chosen. */
export interface CurrentRun {
  kind: BulkKind;
  before: State;
  target?: string;
}

const leads = (n: number) => `${n} lead${n === 1 ? '' : 's'}`;

export function movedMessage(d: { moved: number; unchanged: number }, team = 'the team'): string {
  const already = d.unchanged
    ? `${d.unchanged} ${d.unchanged === 1 ? 'was' : 'were'} already in it`
    : '';
  if (d.moved === 0)
    return already ? `No leads moved to ${team}; ${already}.` : `No leads moved to ${team}.`;
  return `Moved ${leads(d.moved)} to ${team}${already ? `; ${already}` : ''}.`;
}

export function taggedMessage(d: { added: number; alreadyTagged: number }): string {
  const already = d.alreadyTagged ? `${d.alreadyTagged} already had the tag` : '';
  if (d.added === 0) return already ? `No leads tagged; ${already}.` : 'No leads tagged.';
  return `Tagged ${leads(d.added)}${already ? `; ${already}` : ''}.`;
}

export const archivedMessage = (d: { archived: number }) =>
  d.archived === 0 ? 'No leads archived.' : `Archived ${leads(d.archived)}.`;

/**
 * What to show for the current run: nothing until its action returns a result newer than the one
 * it had when it started (pending, or the confirmation was declined), then that result only.
 */
export function bulkFeedback(
  current: CurrentRun | null,
  states: Record<BulkKind, State>,
): { tone: 'success' | 'error'; text: string; conflict: boolean } | null {
  if (!current) return null;
  const s = states[current.kind];
  if (!s || s === current.before) return null;
  if (!s.ok) return { tone: 'error', text: s.error.message, conflict: s.error.code === 'CONFLICT' };
  const text =
    current.kind === 'archive'
      ? archivedMessage(s.data as { archived: number })
      : current.kind === 'team'
        ? movedMessage(s.data as { moved: number; unchanged: number }, current.target)
        : taggedMessage(s.data as { added: number; alreadyTagged: number });
  return { tone: 'success', text, conflict: false };
}
