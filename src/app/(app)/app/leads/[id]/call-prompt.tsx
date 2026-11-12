'use client';
// FR-082: after a Call or WhatsApp tap (under two hours ago, nothing logged since), ask the person
// to log the outcome. "Log the outcome" jumps to the outcome sheet, which the server already
// prefilled with the channel and the tap time. Dismissing hides it for this tap on this browser
// only; the tap still counts as unlogged.
import { useSyncExternalStore, useState } from 'react';
import { Button } from '@/components/ui';

const key = (id: string) => `crm.callPrompt.dismissed.${id}`;
function wasDismissed(id: string): boolean {
  try {
    return window.localStorage.getItem(key(id)) === '1';
  } catch {
    return false;
  }
}
const noSubscribe = () => () => {};

export function CallPrompt({ intentId, text }: { intentId: string; text: string }) {
  const stored = useSyncExternalStore(
    noSubscribe,
    () => wasDismissed(intentId),
    () => false,
  );
  const [dismissed, setDismissed] = useState(false);
  if (stored || dismissed) return null;
  return (
    <div
      role="status"
      data-testid="call-prompt"
      className="mb-6 flex flex-wrap items-center gap-3 rounded-lg border border-blue-200 bg-blue-50 p-4 text-sm text-blue-950"
    >
      <span className="grow">{text}</span>
      <a
        href="#log-interaction"
        className="tap inline-flex items-center rounded-md bg-blue-700 px-3 py-2 font-medium text-white hover:bg-blue-800 focus:outline-none focus-visible:ring-2 focus-visible:ring-blue-600"
      >
        Log the outcome
      </a>
      <Button
        type="button"
        variant="secondary"
        onClick={() => {
          try {
            window.localStorage.setItem(key(intentId), '1');
          } catch {
            // Storage unavailable: hide it for this visit only.
          }
          setDismissed(true);
        }}
      >
        Not now
      </Button>
    </div>
  );
}
