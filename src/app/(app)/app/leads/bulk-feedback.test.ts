// Lead list bulk-action feedback: only the latest run's result is shown, and counts read correctly.
import { describe, expect, it } from 'vitest';
import type { ActionResult } from '@/platform/errors';
import {
  archivedMessage,
  bulkFeedback,
  movedMessage,
  taggedMessage,
  type BulkKind,
} from './bulk-feedback';

type S = ActionResult<unknown> | null;
const ok = (data: unknown): S => ({ ok: true, data });
const fail = (code: string, message: string): S => ({ ok: false, error: { code, message } });
const none: Record<BulkKind, S> = { archive: null, team: null, tag: null };

describe('count wording', () => {
  it.each([
    [{ moved: 1, unchanged: 0 }, 'Moved 1 lead to North Sales.'],
    [{ moved: 3, unchanged: 0 }, 'Moved 3 leads to North Sales.'],
    [{ moved: 1, unchanged: 3 }, 'Moved 1 lead to North Sales; 3 were already in it.'],
    [{ moved: 2, unchanged: 1 }, 'Moved 2 leads to North Sales; 1 was already in it.'],
    [{ moved: 0, unchanged: 1 }, 'No leads moved to North Sales; 1 was already in it.'],
    [{ moved: 0, unchanged: 0 }, 'No leads moved to North Sales.'],
  ])('moved %o', (d, text) => expect(movedMessage(d, 'North Sales')).toBe(text));

  it('falls back to "the team" when the team name is not known', () =>
    expect(movedMessage({ moved: 2, unchanged: 0 })).toBe('Moved 2 leads to the team.'));

  it.each([
    [{ added: 1, alreadyTagged: 0 }, 'Tagged 1 lead.'],
    [{ added: 3, alreadyTagged: 0 }, 'Tagged 3 leads.'],
    [{ added: 1, alreadyTagged: 3 }, 'Tagged 1 lead; 3 already had the tag.'],
    [{ added: 2, alreadyTagged: 1 }, 'Tagged 2 leads; 1 already had the tag.'],
    [{ added: 0, alreadyTagged: 4 }, 'No leads tagged; 4 already had the tag.'],
  ])('tagged %o', (d, text) => expect(taggedMessage(d)).toBe(text));

  it.each([
    [0, 'No leads archived.'],
    [1, 'Archived 1 lead.'],
    [2, 'Archived 2 leads.'],
  ])('archived %i', (n, text) => expect(archivedMessage({ archived: n })).toBe(text));

  it('never says "lead(s)"', () => {
    for (const n of [0, 1, 2])
      expect(
        [
          movedMessage({ moved: n, unchanged: n }),
          taggedMessage({ added: n, alreadyTagged: n }),
          archivedMessage({ archived: n }),
        ].join(' '),
      ).not.toContain('(s)');
  });
});

describe('only the latest run is shown', () => {
  const refusal = fail(
    'RULE_VIOLATION',
    '2 selected leads are owned by someone who is not in that team',
  );

  it('shows nothing before any action, and nothing while the started run is pending', () => {
    expect(bulkFeedback(null, { ...none, team: refusal })).toBeNull();
    // Started a tag run: the earlier team refusal is no longer shown, and the tag result is not yet in.
    expect(bulkFeedback({ kind: 'tag', before: null }, { ...none, team: refusal })).toBeNull();
  });

  it('a failure followed by a success shows only the success', () => {
    const states = { ...none, team: refusal };
    expect(bulkFeedback({ kind: 'team', before: null, target: 'North Sales' }, states)).toEqual({
      tone: 'error',
      text: refusal!.ok ? '' : refusal!.error.message,
      conflict: false,
    });
    const tagged = ok({ added: 3, alreadyTagged: 0 });
    expect(bulkFeedback({ kind: 'tag', before: null }, { ...states, tag: tagged })).toEqual({
      tone: 'success',
      text: 'Tagged 3 leads.',
      conflict: false,
    });
  });

  it('a success followed by a failure shows only the failure', () => {
    const archived = ok({ archived: 2 });
    const stale = fail('CONFLICT', '1 selected lead changed since the list was loaded');
    expect(
      bulkFeedback({ kind: 'team', before: null }, { ...none, archive: archived, team: stale }),
    ).toEqual({
      tone: 'error',
      text: '1 selected lead changed since the list was loaded',
      conflict: true,
    });
  });

  it('repeating the same action hides its previous result until the new one arrives', () => {
    const first = ok({ moved: 3, unchanged: 0 });
    const run = { kind: 'team' as const, before: first, target: 'North Sales' };
    expect(bulkFeedback(run, { ...none, team: first })).toBeNull();
    const second = ok({ moved: 1, unchanged: 3 });
    expect(bulkFeedback(run, { ...none, team: second })?.text).toBe(
      'Moved 1 lead to North Sales; 3 were already in it.',
    );
  });

  it('a success followed by another success shows only the latest', () => {
    const states = {
      archive: ok({ archived: 1 }),
      team: ok({ moved: 2, unchanged: 0 }),
      tag: ok({ added: 1, alreadyTagged: 3 }),
    };
    expect(bulkFeedback({ kind: 'archive', before: null }, states)?.text).toBe('Archived 1 lead.');
    expect(bulkFeedback({ kind: 'tag', before: null }, states)?.text).toBe(
      'Tagged 1 lead; 3 already had the tag.',
    );
  });

  it('passes server error messages through unchanged', () => {
    const forbidden = fail('FORBIDDEN', 'You do not have permission to do that');
    expect(
      bulkFeedback({ kind: 'archive', before: null }, { ...none, archive: forbidden }),
    ).toEqual({ tone: 'error', text: 'You do not have permission to do that', conflict: false });
  });
});
