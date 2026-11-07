'use client';
// One decision on a review case. If someone else decided the case first, the server refuses
// (CONFLICT) and the case leaves the open list; instead of letting it vanish silently, the
// queue reopens with a notice naming what the other person decided (M5 §I.4 U3).
import { useRouter } from 'next/navigation';
import { useActionState, useEffect } from 'react';
import { Button } from '@/components/ui';
import { resolveCaseAction } from '@/modules/leads/actions';

export function CaseDecision({
  caseId,
  decision,
  label,
  confirm,
  successMessage,
}: {
  caseId: string;
  decision: 'dismiss' | 'restore' | 'keep_archived';
  label: string;
  confirm?: string;
  successMessage: string;
}) {
  const router = useRouter();
  const [state, action, pending] = useActionState(resolveCaseAction, null);
  const conflict = state !== null && !state.ok && state.error.code === 'CONFLICT';
  useEffect(() => {
    if (conflict)
      router.replace(`/app/leads/review?conflict=${encodeURIComponent(caseId)}` as '/app/leads');
  }, [conflict, caseId, router]);
  return (
    <form
      action={action}
      className="inline-flex flex-col items-end"
      onSubmit={(e) => {
        if (confirm && !window.confirm(confirm)) e.preventDefault();
      }}
    >
      <input type="hidden" name="caseId" value={caseId} />
      <input type="hidden" name="decision" value={decision} />
      <Button type="submit" variant="secondary" disabled={pending}>
        {label}
      </Button>
      {state?.ok && (
        <span role="status" className="mt-1 w-0 min-w-full text-xs text-green-800">
          {successMessage}
        </span>
      )}
      {state && !state.ok && !conflict && (
        <span role="alert" className="mt-1 w-0 min-w-full text-xs text-red-700">
          {state.error.message}
        </span>
      )}
    </form>
  );
}
