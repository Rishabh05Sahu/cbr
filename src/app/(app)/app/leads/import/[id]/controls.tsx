'use client';
// Interactive steps of one import. Every button calls a Server Action that re-checks role,
// uploader, status and version; the page shows only what the server reports after a refresh, so
// nothing claims success before the server has confirmed it. Buttons lock while a request runs.
import { useRouter } from 'next/navigation';
import { useEffect, useState, useTransition } from 'react';
import { Alert, Button, Field, Select } from '@/components/ui';
import {
  cancelImportAction,
  chooseSheetAction,
  confirmImportAction,
  resumeImportAction,
  submitMappingAction,
} from '@/modules/imports/actions';
import type { ActionResult } from '@/platform/errors';

type Result = ActionResult<unknown>;

function useServerStep() {
  const router = useRouter();
  const [pending, start] = useTransition();
  const [error, setError] = useState<Result | null>(null);
  const run = (fn: () => Promise<Result>) =>
    start(async () => {
      setError(null);
      const r = await fn();
      if (!r.ok) setError(r);
      router.refresh();
    });
  return { pending, error, run };
}

function Problem({ result }: { result: Result | null }) {
  if (!result || result.ok) return null;
  const fields = Object.entries(result.error.fieldErrors ?? {});
  return (
    <Alert tone="error">
      {result.error.message}
      {fields.length > 0 && (
        <ul className="mt-1 list-disc pl-5">
          {fields.map(([k, msgs]) => (
            <li key={k}>
              {k} {msgs.join(', ')}
            </li>
          ))}
        </ul>
      )}
    </Alert>
  );
}

/** Re-renders the page from the server while the worker is busy (status survives a refresh). */
export function AutoRefresh({ everyMs = 2000 }: { everyMs?: number }) {
  const router = useRouter();
  useEffect(() => {
    const t = setInterval(() => router.refresh(), everyMs);
    return () => clearInterval(t);
  }, [router, everyMs]);
  return (
    <p className="text-sm text-slate-600" aria-live="polite">
      Working… this page updates by itself.
    </p>
  );
}

export function SheetPicker({
  importId,
  version,
  sheets,
  current,
}: {
  importId: string;
  version: number;
  sheets: string[];
  current: string | null;
}) {
  const { pending, error, run } = useServerStep();
  const [sheet, setSheet] = useState(current ?? sheets[0] ?? '');
  return (
    <div className="space-y-2">
      <Problem result={error} />
      <div className="flex flex-wrap items-end gap-2">
        <div className="min-w-48">
          <Field label="Worksheet" htmlFor="sheet">
            <Select id="sheet" value={sheet} onChange={(e) => setSheet(e.target.value)}>
              {sheets.map((s) => (
                <option key={s} value={s}>
                  {s}
                </option>
              ))}
            </Select>
          </Field>
        </div>
        <Button
          variant="secondary"
          disabled={pending || sheet === current}
          onClick={() => run(() => chooseSheetAction(importId, { sheet, version }))}
        >
          Read this sheet
        </Button>
      </div>
    </div>
  );
}

export interface MappingFormProps {
  importId: string;
  version: number;
  headers: string[];
  fields: { field: string; label: string; required: boolean; hint?: string }[];
  mapping: Record<string, number>;
  sources: { id: string; name: string }[];
  defaultSourceId: string | null;
  duplicatePolicy: 'ATTACH' | 'SKIP';
  assignment: { mode: string; target?: string; teamId?: string };
  dryRun: boolean;
  people: { userId: string; name: string }[];
  teams: { id: string; name: string }[];
  orgQueue: boolean;
}

export function MappingForm(p: MappingFormProps) {
  const { pending, error, run } = useServerStep();
  const [mapping, setMapping] = useState<Record<string, string>>(
    Object.fromEntries(p.fields.map((f) => [f.field, p.mapping[f.field]?.toString() ?? ''])),
  );
  const [source, setSource] = useState(p.defaultSourceId ?? '');
  const [policy, setPolicy] = useState(p.duplicatePolicy);
  const [assign, setAssign] = useState(
    p.assignment.mode === 'target'
      ? (p.assignment.target ?? '')
      : p.assignment.mode === 'round_robin'
        ? `rr:${p.assignment.teamId}`
        : p.orgQueue
          ? 'none'
          : '',
  );
  const [dryRun, setDryRun] = useState(p.dryRun);

  const assignment = () =>
    assign === 'none' || assign === ''
      ? { mode: 'none' }
      : assign.startsWith('rr:')
        ? { mode: 'round_robin', teamId: assign.slice(3) }
        : { mode: 'target', target: assign };

  return (
    <form
      className="space-y-4"
      onSubmit={(e) => {
        e.preventDefault();
        run(() =>
          submitMappingAction(p.importId, {
            mapping: Object.fromEntries(Object.entries(mapping).filter(([, v]) => v !== '')),
            defaultSourceId: source,
            duplicatePolicy: policy,
            assignment: assignment(),
            dryRun,
            version: p.version,
          }),
        );
      }}
    >
      <Problem result={error} />
      <div className="overflow-x-auto">
        <table className="min-w-full text-left text-sm">
          <thead className="border-b text-xs uppercase text-slate-500">
            <tr>
              <th className="py-2 pr-4">Lead field</th>
              <th className="py-2">Column in your file</th>
            </tr>
          </thead>
          <tbody className="divide-y divide-slate-100">
            {p.fields.map((f) => (
              <tr key={f.field}>
                <td className="py-2 pr-4">
                  <label htmlFor={`map-${f.field}`} className="font-medium">
                    {f.label}
                    {f.required && <span className="text-red-700"> *</span>}
                  </label>
                  {f.hint && <div className="text-xs text-slate-500">{f.hint}</div>}
                </td>
                <td className="py-2">
                  {/* A w-full select adds no minimum width to an auto-sized table column, so
                      on a phone the long hints squeezed it to ~50 px ("Nar"); keep it readable. */}
                  <Select
                    id={`map-${f.field}`}
                    className="min-w-40"
                    value={mapping[f.field] ?? ''}
                    onChange={(e) => setMapping({ ...mapping, [f.field]: e.target.value })}
                  >
                    <option value="">Not imported</option>
                    {p.headers.map((h, i) => (
                      <option key={i} value={String(i)}>
                        {h || `(column ${i + 1}, no heading)`}
                      </option>
                    ))}
                  </Select>
                </td>
              </tr>
            ))}
          </tbody>
        </table>
      </div>

      <div className="grid gap-4 sm:grid-cols-2">
        <Field
          label="Lead source when the row has none"
          htmlFor="default-source"
          hint="Used for rows whose Source cell is blank. A Source name that is not an active source is reported as a row problem."
        >
          <Select id="default-source" value={source} onChange={(e) => setSource(e.target.value)}>
            <option value="">Unknown</option>
            {p.sources.map((s) => (
              <option key={s.id} value={s.id}>
                {s.name}
              </option>
            ))}
          </Select>
        </Field>
        <Field label="When the phone matches an open lead" htmlFor="dup-policy">
          <Select
            id="dup-policy"
            value={policy}
            onChange={(e) => setPolicy(e.target.value as 'ATTACH' | 'SKIP')}
          >
            <option value="ATTACH">Add the enquiry to that lead and tell its owner</option>
            <option value="SKIP">Skip the row</option>
          </Select>
        </Field>
        <Field label="Who owns the new leads" htmlFor="assign">
          <Select id="assign" value={assign} onChange={(e) => setAssign(e.target.value)}>
            {p.orgQueue && <option value="none">Nobody yet (unassigned queue)</option>}
            {p.people.map((u) => (
              <option key={u.userId} value={`user:${u.userId}`}>
                {u.name}
              </option>
            ))}
            {p.teams.map((t) => (
              <option key={t.id} value={`team:${t.id}`}>
                Team queue: {t.name}
              </option>
            ))}
            {p.teams.map((t) => (
              <option key={`rr-${t.id}`} value={`rr:${t.id}`}>
                In turn within: {t.name}
              </option>
            ))}
          </Select>
        </Field>
        <div className="flex items-center gap-2 pt-6">
          <input
            id="dry-run"
            type="checkbox"
            checked={dryRun}
            onChange={(e) => setDryRun(e.target.checked)}
          />
          <label htmlFor="dry-run" className="text-sm">
            Dry run only: check every row and show the results, but never import
          </label>
        </div>
      </div>
      <Button type="submit" disabled={pending}>
        {pending ? 'Starting checks…' : 'Check rows'}
      </Button>
    </form>
  );
}

export function ConfirmPanel({
  importId,
  version,
  rows,
  duplicateFile,
  attestationText,
}: {
  importId: string;
  version: number;
  rows: number;
  duplicateFile: boolean;
  attestationText: string;
}) {
  const { pending, error, run } = useServerStep();
  const [attest, setAttest] = useState(false);
  const [ack, setAck] = useState(false);
  return (
    <div className="space-y-3">
      <Problem result={error} />
      {duplicateFile && (
        <div className="flex items-start gap-2">
          <input
            id="ack"
            type="checkbox"
            checked={ack}
            onChange={(e) => setAck(e.target.checked)}
          />
          <label htmlFor="ack" className="text-sm">
            This exact file was imported before. Import it again anyway.
          </label>
        </div>
      )}
      <div className="flex items-start gap-2">
        <input
          id="attest"
          type="checkbox"
          checked={attest}
          onChange={(e) => setAttest(e.target.checked)}
        />
        <label htmlFor="attest" className="text-sm">
          {attestationText}
        </label>
      </div>
      <Button
        disabled={pending || !attest || (duplicateFile && !ack)}
        onClick={() =>
          run(() =>
            confirmImportAction(importId, {
              attest,
              acknowledgeDuplicateFile: ack,
              version,
            }),
          )
        }
      >
        {pending ? 'Starting…' : `Import ${rows.toLocaleString('en-IN')} rows`}
      </Button>
    </div>
  );
}

export function JobButtons({
  importId,
  canCancel,
  canResume,
}: {
  importId: string;
  canCancel: boolean;
  canResume: boolean;
}) {
  const { pending, error, run } = useServerStep();
  const [confirming, setConfirming] = useState(false);
  if (!canCancel && !canResume) return null;
  return (
    <div className="space-y-2">
      <Problem result={error} />
      <div className="flex flex-wrap gap-2">
        {canResume && (
          <Button disabled={pending} onClick={() => run(() => resumeImportAction(importId))}>
            Resume import
          </Button>
        )}
        {canCancel &&
          (confirming ? (
            <>
              <Button
                variant="danger"
                disabled={pending}
                onClick={() => run(() => cancelImportAction(importId))}
              >
                Yes, cancel the import
              </Button>
              <Button variant="ghost" disabled={pending} onClick={() => setConfirming(false)}>
                Keep it
              </Button>
            </>
          ) : (
            <Button variant="secondary" disabled={pending} onClick={() => setConfirming(true)}>
              Cancel import
            </Button>
          ))}
      </div>
    </div>
  );
}
