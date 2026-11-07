'use client';

// FR-057 script panel / FR-099 drawer: the published call scripts that match this lead (FR-096
// order, best match first; ADR-0011 decision 8), opened in a drawer without leaving the page. The
// script text is rendered on the server (sanitized there) and passed in as children. A script is
// reading material only: this panel has no call, message or link-out actions, and on a
// Do-Not-Contact or invalid-number lead the drawer repeats the page's contact restriction
// (ADR-0011 decision 11).
import { useId, useRef, useState, type ReactNode } from 'react';
import { Alert, Button, Card } from '@/components/ui';
import type { ContactStatus } from '@/modules/leads';
import { useShownScript } from './shown-script';

export interface PanelScript {
  id: string;
  name: string;
  /** The live version shown (FR-098 records this exact version). */
  versionId: string;
  versionNo: number;
  /** "Version 3 · published 28 Oct 2026, 10:02" */
  versionLine: string;
  /** Targeting badges, rendered on the server. */
  targeting: ReactNode;
  /** The live version's sections, rendered and sanitized on the server. */
  content: ReactNode;
}

/** The restriction shown in the panel; null when the lead may be contacted normally. */
export function scriptPanelNotice(status: ContactStatus): ReactNode {
  if (status === 'DO_NOT_CONTACT')
    return (
      <Alert tone="error">
        <strong>Do not contact.</strong> This person asked not to be contacted. A script does not
        permit calling or messaging them; use it only if they contact you.
      </Alert>
    );
  if (status === 'INVALID')
    return (
      <Alert tone="warn">
        <strong>Invalid number.</strong> Check the number before contacting. A script does not
        change that.
      </Alert>
    );
  return null;
}

export function ScriptPanel({
  scripts,
  contactStatus,
  matchedOn,
  allScriptsHref,
}: {
  scripts: PanelScript[];
  contactStatus: ContactStatus;
  /** The lead details matching uses, for the "no match" explanation. */
  matchedOn: string;
  allScriptsHref: string;
}) {
  const dialog = useRef<HTMLDialogElement>(null);
  const [selected, setSelected] = useState(scripts[0]?.id ?? null);
  const titleId = useId();
  const best = scripts[0];
  const current = scripts.find((s) => s.id === selected) ?? best;
  const notice = scriptPanelNotice(contactStatus);
  // FR-098: the version on screen while the drawer is open is the one an interaction records.
  const { setShown } = useShownScript();
  const show = (s: PanelScript) =>
    setShown({ versionId: s.versionId, name: s.name, versionNo: s.versionNo });

  if (!best)
    return (
      <Card title="Call script">
        <p className="text-sm text-slate-700" data-testid="script-panel-empty">
          No published script matches this lead ({matchedOn}).{' '}
          <a href={allScriptsHref} className="tap underline">
            Browse all scripts
          </a>
        </p>
      </Card>
    );

  return (
    <Card
      title="Call script"
      description={
        scripts.length > 1
          ? `Best match: ${best.name} (${scripts.length} matching scripts)`
          : `Best match: ${best.name}`
      }
      actions={
        <Button
          variant="secondary"
          aria-haspopup="dialog"
          onClick={() => {
            dialog.current?.showModal();
            show(current!);
          }}
          data-testid="script-panel-open"
        >
          Open script
        </Button>
      }
    >
      <dialog
        ref={dialog}
        aria-labelledby={titleId}
        data-testid="script-panel"
        // Clicking the backdrop (the dialog element itself, outside the panel) closes it.
        onClick={(e) => {
          if (e.target === e.currentTarget) e.currentTarget.close();
        }}
        className="fixed inset-y-0 right-0 left-auto m-0 h-dvh max-h-dvh w-full max-w-lg border-0 bg-white p-0 shadow-xl backdrop:bg-slate-900/40"
      >
        <div className="flex h-full flex-col">
          <div className="flex items-start justify-between gap-2 border-b border-slate-200 p-4">
            <div className="min-w-0">
              <h2 id={titleId} className="text-base font-semibold text-slate-900">
                {current!.name}
              </h2>
              <p className="mt-1 text-xs text-slate-600">{current!.versionLine}</p>
            </div>
            <Button variant="ghost" onClick={() => dialog.current?.close()} aria-label="Close">
              Close
            </Button>
          </div>
          <div className="flex-1 space-y-4 overflow-y-auto p-4">
            {notice}
            {scripts.length > 1 && (
              <div role="group" aria-label="Matching scripts" className="flex flex-wrap gap-2">
                {scripts.map((s, i) => (
                  <Button
                    key={s.id}
                    variant={s.id === current!.id ? 'primary' : 'secondary'}
                    aria-pressed={s.id === current!.id}
                    onClick={() => {
                      setSelected(s.id);
                      show(s);
                    }}
                  >
                    {i === 0 ? `${s.name} (best match)` : s.name}
                  </Button>
                ))}
              </div>
            )}
            {scripts.map((s) => (
              <div key={s.id} hidden={s.id !== current!.id} data-script-id={s.id}>
                <div className="mb-3">{s.targeting}</div>
                {s.content}
              </div>
            ))}
          </div>
        </div>
      </dialog>
    </Card>
  );
}
