// Inputs for the org's active custom fields (FR-064, M5), named "cf.<key>". Used by the manual
// create form and the lead page. The browser checks are a convenience only: the server converts
// each value by the field's declared type and validates it strictly (custom-fields.ts).
import { Field, Input, Select } from '@/components/ui';

export interface CustomFieldInputDef {
  key: string;
  label: string;
  type: string;
  required: boolean;
  options?: readonly string[];
}

export function CustomFieldInputs({
  fields,
  values = {},
  errors = {},
  requireRequired = true,
}: {
  fields: readonly CustomFieldInputDef[];
  values?: Record<string, unknown>;
  errors?: Record<string, string[]>;
  /** Mark required fields as required in the browser (create); the server always checks. */
  requireRequired?: boolean;
}) {
  if (!fields.length) return null;
  return (
    <>
      {fields.map((f) => {
        const id = `cf-${f.key}`;
        const name = `cf.${f.key}`;
        const v = values[f.key];
        const label = `${f.label}${f.required ? ' (required)' : ''}`;
        const error = errors[`customFields.${f.key}`];
        const required = requireRequired && f.required;
        let control;
        switch (f.type) {
          case 'number':
            control = (
              <Input
                id={id}
                name={name}
                inputMode="decimal"
                pattern="-?[0-9]+(\.[0-9]+)?"
                defaultValue={typeof v === 'number' ? String(v) : ''}
                required={required}
              />
            );
            break;
          case 'date':
            control = (
              <Input
                id={id}
                name={name}
                type="date"
                defaultValue={typeof v === 'string' ? v : ''}
                required={required}
              />
            );
            break;
          case 'boolean':
            control = (
              <Select
                id={id}
                name={name}
                defaultValue={v === true ? 'true' : v === false ? 'false' : ''}
                required={required}
              >
                <option value="">—</option>
                <option value="true">Yes</option>
                <option value="false">No</option>
              </Select>
            );
            break;
          case 'single_select':
            control = (
              <Select
                id={id}
                name={name}
                defaultValue={typeof v === 'string' ? v : ''}
                required={required}
              >
                <option value="">—</option>
                {(f.options ?? []).map((o) => (
                  <option key={o} value={o}>
                    {o}
                  </option>
                ))}
              </Select>
            );
            break;
          case 'multi_select':
            control = (
              <Select
                id={id}
                name={name}
                multiple
                size={Math.min(5, f.options?.length ?? 1)}
                defaultValue={Array.isArray(v) ? (v as string[]) : []}
                required={required}
              >
                {(f.options ?? []).map((o) => (
                  <option key={o} value={o}>
                    {o}
                  </option>
                ))}
              </Select>
            );
            break;
          default:
            control = (
              <Input
                id={id}
                name={name}
                maxLength={500}
                defaultValue={typeof v === 'string' ? v : ''}
                required={required}
              />
            );
        }
        return (
          <Field key={f.key} label={label} htmlFor={id} error={error}>
            {control}
          </Field>
        );
      })}
    </>
  );
}
