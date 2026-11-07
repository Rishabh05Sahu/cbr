'use client';
// Bulk assignment for the unassigned queue (FR-063 assign, FR-073): the server-rendered rows
// carry checkboxes named "leadId"; one button assigns them to a person or queue, the other deals
// them round-robin within a team. The server re-checks scope, eligibility and every lead.
import { useActionState, type ReactNode } from 'react';
import { Alert, Button, Field, Select } from '@/components/ui';
import { bulkAssignAction, roundRobinAction } from '@/modules/leads/actions';

type Option = { value: string; label: string };

export function BulkAssignForm({
  children,
  targets,
  teams,
}: {
  children: ReactNode;
  targets: Option[];
  teams: Option[];
}) {
  const [bulk, bulkAction, bulkPending] = useActionState(bulkAssignAction, null);
  const [rr, rrAction, rrPending] = useActionState(roundRobinAction, null);
  const last = [bulk, rr].find((s) => s && !s.ok) ?? null;
  const done =
    (bulk?.ok && 'Assigned.') ||
    (rr?.ok && `Assigned ${(rr.data as { assigned: unknown[] }).assigned.length} in turn.`) ||
    null;
  const pending = bulkPending || rrPending;
  return (
    <form className="space-y-4">
      {last && !last.ok && <Alert tone="error">{last.error.message}</Alert>}
      {done && <Alert tone="success">{done}</Alert>}
      {children}
      <div className="grid gap-4 border-t border-slate-100 pt-4 sm:grid-cols-2">
        <div className="space-y-2">
          <Field label="Assign selected to" htmlFor="bulk-target">
            <Select id="bulk-target" name="target" defaultValue="">
              <option value="">Choose…</option>
              {targets.map((t) => (
                <option key={t.value} value={t.value}>
                  {t.label}
                </option>
              ))}
            </Select>
          </Field>
          <Button type="submit" formAction={bulkAction} disabled={pending}>
            Assign selected
          </Button>
        </div>
        {teams.length > 0 && (
          <div className="space-y-2">
            <Field label="Or deal selected in turn within" htmlFor="bulk-team">
              <Select id="bulk-team" name="teamId" defaultValue="">
                <option value="">Choose a team…</option>
                {teams.map((t) => (
                  <option key={t.value} value={t.value}>
                    {t.label}
                  </option>
                ))}
              </Select>
            </Field>
            <Button type="submit" variant="secondary" formAction={rrAction} disabled={pending}>
              Round-robin selected
            </Button>
          </div>
        )}
      </div>
    </form>
  );
}
