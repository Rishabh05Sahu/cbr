'use client';
// Wraps a Server Action that returns ActionResult: pending state on the submit button,
// a summary of errors (including field errors), and an optional success message.
// Children are server-rendered fields (functions cannot cross the server/client boundary).
//
// M5 §I.4: the form keeps what the user typed when the server refuses it (it is only cleared
// after a success, U6); field errors are listed by their visible label, never the internal
// field name (U4), and the matching inputs are marked invalid; the message spans the whole form,
// so it cannot push grid columns around (U7); and a version conflict refreshes the page so it
// shows the record as it is now (U2).
import { useRouter } from 'next/navigation';
import { startTransition, useActionState, useEffect, useRef, type ReactNode } from 'react';
import type { ActionResult } from '@/platform/errors';
import { Alert, Button } from './ui';

export type FormAction = (
  prev: ActionResult<unknown> | null,
  formData: FormData,
) => Promise<ActionResult<unknown>>;

/** "fullName" → "Full name", "preferred_city" → "Preferred city". */
export function humanizeFieldName(name: string): string {
  const words = name
    .split('.')
    .pop()!
    .replace(/_/g, ' ')
    .replace(/([a-z0-9])([A-Z])/g, '$1 $2')
    .toLowerCase()
    .trim();
  return words.charAt(0).toUpperCase() + words.slice(1);
}

/**
 * One line per field error, named by its label. Custom-field messages already name their field
 * (custom-fields.ts), and form-level errors ("_") have no field, so those are shown as they are.
 */
export function fieldErrorLines(
  fieldErrors: Record<string, string[]>,
  labels: Record<string, string> = {},
): string[] {
  return Object.entries(fieldErrors).flatMap(([key, msgs]) =>
    msgs.map((m) =>
      key === '_' || key.startsWith('customFields.')
        ? m
        : `${labels[key] ?? humanizeFieldName(key)}: ${m}`,
    ),
  );
}

/** A warning string carried by a successful result's data, if any. */
export function warningOf(data: unknown): string | null {
  const w = (data as { warning?: unknown } | null | undefined)?.warning;
  return typeof w === 'string' && w ? w : null;
}

/** Form control names that a server error key may refer to. */
function controlNames(key: string): string[] {
  if (key.startsWith('customFields.')) return [`cf.${key.slice('customFields.'.length)}`];
  return [key, `keep.${key}`];
}

export function ActionForm({
  action,
  children,
  submitLabel,
  successMessage,
  className,
  fieldLabels,
  resetOnSuccess = true,
  showSuccess = true,
}: {
  action: FormAction;
  children: ReactNode;
  submitLabel?: string;
  successMessage?: string;
  className?: string;
  /** Visible labels for field names whose humanised form would be wrong ("fullName" → "Name"). */
  fieldLabels?: Record<string, string>;
  /** Clear the inputs after a success (default). Values are always kept after a refusal. */
  resetOnSuccess?: boolean;
  /** Show the success message for the last result. False once the page no longer reflects it. */
  showSuccess?: boolean;
}) {
  const [state, formAction, pending] = useActionState(action, null);
  const formRef = useRef<HTMLFormElement>(null);
  const router = useRouter();
  const fieldErrors = state && !state.ok ? (state.error.fieldErrors ?? {}) : {};
  const lines = fieldErrorLines(fieldErrors, fieldLabels);

  useEffect(() => {
    const form = formRef.current;
    if (!form || !state) return;
    if (state.ok) {
      if (resetOnSuccess) form.reset();
    } else if (state.error.code === 'CONFLICT') {
      router.refresh();
    }
    // Mark the controls the server refused, and only those.
    for (const el of form.querySelectorAll('[aria-invalid="true"][data-server-invalid]')) {
      el.removeAttribute('aria-invalid');
      el.removeAttribute('data-server-invalid');
    }
    if (!state.ok)
      for (const key of Object.keys(state.error.fieldErrors ?? {}))
        for (const name of controlNames(key))
          for (const el of form.querySelectorAll(`[name="${CSS.escape(name)}"]`)) {
            el.setAttribute('aria-invalid', 'true');
            el.setAttribute('data-server-invalid', '');
          }
  }, [state, resetOnSuccess, router]);

  return (
    <form
      ref={formRef}
      action={formAction}
      // Submitting through a transition (not the form action) stops React from clearing the
      // inputs after every submission, including refused ones.
      onSubmit={(e) => {
        e.preventDefault();
        const data = new FormData(e.currentTarget, (e.nativeEvent as SubmitEvent).submitter);
        startTransition(() => formAction(data));
      }}
      className={className ?? 'space-y-4'}
    >
      {state && !state.ok && (
        <div className="col-span-full">
          <Alert tone="error">
            {state.error.message}
            {lines.length > 0 && (
              <ul className="mt-1 list-disc pl-5">
                {lines.map((l) => (
                  <li key={l}>{l}</li>
                ))}
              </ul>
            )}
          </Alert>
        </div>
      )}
      {state?.ok && successMessage && showSuccess && (
        <div className="col-span-full">
          <Alert tone="success">{successMessage}</Alert>
        </div>
      )}
      {state?.ok && showSuccess && warningOf(state.data) && (
        // A saved result can carry a warning (e.g. FR-104 overlapping meetings).
        <div className="col-span-full">
          <Alert tone="warn">{warningOf(state.data)}</Alert>
        </div>
      )}
      {children}
      {submitLabel && (
        <Button type="submit" disabled={pending}>
          {pending ? 'Saving…' : submitLabel}
        </Button>
      )}
    </form>
  );
}
