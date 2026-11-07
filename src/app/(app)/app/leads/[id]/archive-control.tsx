'use client';
// Archive / restore for the lead page (FR-061). One component owns both actions, so the message
// always describes the action that actually ran ("Archived." never turns into "Restored." when
// the button swaps; M5 §I.4 U1). A refusal — the page was stale (version conflict) or someone
// else already archived or restored the lead — is explained and the page is refreshed from the
// server, so it never keeps showing an editable view of an outdated record (U2). The message
// sits below the button in a full-width line, so the button never moves.
import { useRouter } from 'next/navigation';
import { useActionState, useEffect, useState } from 'react';
import { Button } from '@/components/ui';
import { archiveLeadAction, restoreLeadAction } from '@/modules/leads/actions';

export function ArchiveControl({
  leadId,
  version,
  archived,
}: {
  leadId: string;
  version: number;
  archived: boolean;
}) {
  const router = useRouter();
  const [archiveState, archive, archiving] = useActionState(archiveLeadAction, null);
  const [restoreState, restore, restoring] = useActionState(restoreLeadAction, null);
  const [last, setLast] = useState<'archive' | 'restore' | null>(null);
  const state = last === 'archive' ? archiveState : last === 'restore' ? restoreState : null;
  const refused = state !== null && !state.ok;

  useEffect(() => {
    if (refused) router.refresh();
  }, [refused, state, router]);

  const kind = archived ? 'restore' : 'archive';
  return (
    <form
      action={archived ? restore : archive}
      onSubmit={(e) => {
        const question = archived
          ? 'Restore this lead?'
          : 'Archive this lead? It becomes read-only until restored.';
        if (!window.confirm(question)) e.preventDefault();
        else setLast(kind);
      }}
      className="space-y-2"
    >
      <input type="hidden" name="leadId" value={leadId} />
      <input type="hidden" name="version" value={String(version)} />
      <Button
        type="submit"
        variant={archived ? 'secondary' : 'danger'}
        disabled={archiving || restoring}
      >
        {archived ? 'Restore lead' : 'Archive lead'}
      </Button>
      <div className="min-h-5 text-sm" aria-live="polite">
        {state?.ok && (
          <p role="status" className="text-green-800">
            {last === 'archive' ? 'Archived.' : 'Restored.'}
          </p>
        )}
        {refused && (
          <p role="alert" className="text-red-700">
            {state.error.message}. The page now shows the lead as it is.
          </p>
        )}
      </div>
    </form>
  );
}
