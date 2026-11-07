'use client';
// A one-button form for row actions (suspend, approve, …) with optional confirmation.
//
// M5 §I.4: the result belongs to one action — when the same spot renders a different action
// (another label), its state starts fresh, so a message never describes the wrong action (U1);
// the message wraps within the button's own width, so the button does not move when it appears
// (U2); and a version conflict refreshes the page so it shows the current record (U2).
import { useRouter } from 'next/navigation';
import { useActionState, useEffect } from 'react';
import type { FormAction } from './action-form';
import { Button } from './ui';

type Props = {
  action: FormAction;
  fields: Record<string, string>;
  label: string;
  variant?: 'primary' | 'secondary' | 'danger' | 'ghost';
  confirm?: string;
  successMessage?: string;
};

export function ActionFormButton(props: Props) {
  return <ActionFormButtonInner key={props.label} {...props} />;
}

function ActionFormButtonInner({
  action,
  fields,
  label,
  variant = 'secondary',
  confirm,
  successMessage,
}: Props) {
  const [state, formAction, pending] = useActionState(action, null);
  const router = useRouter();
  useEffect(() => {
    if (state && !state.ok && state.error.code === 'CONFLICT') router.refresh();
  }, [state, router]);
  return (
    <form
      action={formAction}
      className="inline-flex flex-col items-end"
      onSubmit={(e) => {
        if (confirm && !window.confirm(confirm)) e.preventDefault();
      }}
    >
      {Object.entries(fields).map(([k, v]) => (
        <input key={k} type="hidden" name={k} value={v} />
      ))}
      <Button type="submit" variant={variant} disabled={pending}>
        {label}
      </Button>
      {state?.ok && successMessage && (
        <span role="status" className="mt-1 w-0 min-w-full text-xs text-green-800">
          {successMessage}
        </span>
      )}
      {state && !state.ok && (
        <span role="alert" className="mt-1 w-0 min-w-full text-xs text-red-700">
          {state.error.message}
        </span>
      )}
    </form>
  );
}
