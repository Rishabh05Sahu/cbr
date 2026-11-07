import { ActionForm } from '@/components/action-form';
import { ActionFormButton } from '@/components/action-form-button';
import { Badge, Card, EmptyState, Field, Input, PageHeader, Select } from '@/components/ui';
import { CUSTOM_FIELD_TYPES, listCustomFields, MAX_ACTIVE_CUSTOM_FIELDS } from '@/modules/leads';
import {
  createCustomFieldAction,
  setCustomFieldArchivedAction,
  updateCustomFieldAction,
} from '@/modules/leads/actions';
import { pageContext, pageRequire } from '@/platform/auth/session';

const TYPE_LABELS: Record<string, string> = {
  text: 'Text',
  number: 'Number',
  date: 'Date',
  boolean: 'Yes / No',
  single_select: 'One choice',
  multi_select: 'Several choices',
};
const textarea = 'block w-full rounded-md border border-slate-300 px-3 py-2 text-sm';

/**
 * Custom lead fields (FR-064, D5): Owner/Admin. At most 30 active; key and type are fixed once
 * created (stored values are never reinterpreted) and a key is never reused, even after archiving.
 * The server enforces all of this; the form only explains it.
 */
export default async function CustomFieldsPage() {
  const { ctx } = await pageContext();
  pageRequire(ctx, 'org.settings.manage');
  const fields = await listCustomFields(ctx, { includeArchived: true });
  const active = fields.filter((f) => !f.archived).length;

  return (
    <>
      <PageHeader
        title="Custom lead fields"
        description={`${active} of ${MAX_ACTIVE_CUSTOM_FIELDS} active fields. They appear on the lead form, the lead page and the import mapping.`}
      />
      <div className="space-y-4">
        <Card
          title="Add a field"
          description="The key and type cannot be changed later, and a key cannot be reused once archived."
        >
          <ActionForm
            action={createCustomFieldAction}
            submitLabel="Add field"
            successMessage="Field added."
            className="grid gap-4 sm:grid-cols-2"
          >
            <Field label="Label" htmlFor="cf-new-label">
              <Input id="cf-new-label" name="label" required maxLength={100} />
            </Field>
            <Field
              label="Key"
              htmlFor="cf-new-key"
              hint="2–40 lower-case letters, digits and underscores, starting with a letter"
            >
              <Input
                id="cf-new-key"
                name="key"
                required
                pattern="[a-z][a-z0-9_]{1,39}"
                maxLength={40}
              />
            </Field>
            <Field label="Type" htmlFor="cf-new-type">
              <Select id="cf-new-type" name="type" required defaultValue="text">
                {CUSTOM_FIELD_TYPES.map((t) => (
                  <option key={t} value={t}>
                    {TYPE_LABELS[t] ?? t}
                  </option>
                ))}
              </Select>
            </Field>
            <Field
              label="Options (choice fields only)"
              htmlFor="cf-new-options"
              hint="One per line, at most 50"
            >
              <textarea id="cf-new-options" name="options" rows={3} className={textarea} />
            </Field>
            <label className="flex items-center gap-2 text-sm">
              <input type="checkbox" name="required" /> Required on new leads (manual and import)
            </label>
          </ActionForm>
        </Card>

        <Card title="Fields">
          {fields.length === 0 ? (
            <EmptyState>No custom fields yet.</EmptyState>
          ) : (
            <ul className="divide-y divide-slate-100">
              {fields.map((f) => (
                <li key={f.id} className="space-y-3 py-4">
                  <div className="flex flex-wrap items-center justify-between gap-2">
                    <p className="text-sm">
                      <span className="font-medium text-slate-900">{f.label}</span>{' '}
                      <code className="text-xs text-slate-500">{f.key}</code> ·{' '}
                      {TYPE_LABELS[f.type] ?? f.type}
                      {f.required && ' · required'}{' '}
                      {f.archived && <Badge tone="warn">Archived</Badge>}
                    </p>
                    <ActionFormButton
                      action={setCustomFieldArchivedAction}
                      fields={{
                        fieldId: f.id,
                        version: String(f.version),
                        archived: f.archived ? 'false' : 'true',
                      }}
                      label={f.archived ? 'Restore' : 'Archive'}
                      variant={f.archived ? 'secondary' : 'danger'}
                      {...(f.archived
                        ? {}
                        : {
                            confirm:
                              'Archive this field? Stored values stay visible but no new values can be entered.',
                          })}
                    />
                  </div>
                  {!f.archived && (
                    <details>
                      <summary className="tap cursor-pointer text-sm underline">Edit</summary>
                      <ActionForm
                        action={updateCustomFieldAction}
                        submitLabel="Save"
                        successMessage="Saved."
                        className="mt-3 grid gap-4 sm:grid-cols-2"
                      >
                        <input type="hidden" name="fieldId" value={f.id} />
                        <input type="hidden" name="version" value={f.version} />
                        <Field label="Label" htmlFor={`cf-${f.id}-label`}>
                          <Input
                            id={`cf-${f.id}-label`}
                            name="label"
                            defaultValue={f.label}
                            required
                            maxLength={100}
                          />
                        </Field>
                        {(f.type === 'single_select' || f.type === 'multi_select') && (
                          <Field
                            label="Options"
                            htmlFor={`cf-${f.id}-options`}
                            hint="One per line. An option still used by a lead cannot be removed."
                          >
                            <textarea
                              id={`cf-${f.id}-options`}
                              name="options"
                              rows={3}
                              defaultValue={(f.options ?? []).join('\n')}
                              className={textarea}
                            />
                          </Field>
                        )}
                        <label className="flex items-center gap-2 text-sm">
                          <input type="checkbox" name="required" defaultChecked={f.required} />{' '}
                          Required on new leads
                        </label>
                      </ActionForm>
                    </details>
                  )}
                </li>
              ))}
            </ul>
          )}
        </Card>
      </div>
    </>
  );
}
