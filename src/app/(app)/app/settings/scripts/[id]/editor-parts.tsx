// Parts of the script editor page that are rendered (and tested) together with the live preview.
//
// Ids: editor controls use the `draft-` prefix and preview headings `view-` (script-content.tsx),
// so a page showing both never repeats an id and each label still points at its own control.
//
// Feedback: both forms stay mounted (a remount would drop a refused form's message and what the
// user typed, e.g. after a version conflict refreshes the page). A save always leaves a draft and
// a publish always removes it, so "Draft saved." shows only while there is a draft and
// "Published." only while there is none: publishing hides the old "Draft saved.", and saving a
// new draft hides the old "Published.".
import { ActionForm } from '@/components/action-form';
import { Field, Input } from '@/components/ui';
import { MAX_OBJECTIONS, MAX_SECTION_CHARS, type ScriptContent } from '@/modules/scripts';
import { publishScriptAction } from '@/modules/scripts/actions';

const textareaClass = 'block w-full rounded-md border border-slate-300 px-3 py-2 text-sm';
const SECTIONS = [
  ['opening', 'Opening'],
  ['questions', 'Qualification questions'],
  ['pitch', 'Pitch points'],
  ['closing', 'Closing / next step'],
] as const;

export const draftFieldId = (key: string) => `draft-${key}`;

export const showFeedback = {
  draftSaved: (draftVersionNo: number | null) => draftVersionNo !== null,
  published: (draftVersionNo: number | null) => draftVersionNo === null,
};

/** The draft's sections and objection rows (existing rows plus two blank ones). */
export function DraftFields({ editing }: { editing: ScriptContent }) {
  const objectionRows = [
    ...editing.objections,
    ...Array.from({ length: 2 }, () => ({ objection: '', response: { text: '', html: '' } })),
  ].slice(0, MAX_OBJECTIONS);
  return (
    <>
      {SECTIONS.map(([key, label]) => (
        <Field key={key} label={label} htmlFor={draftFieldId(key)}>
          <textarea
            id={draftFieldId(key)}
            name={key}
            rows={key === 'opening' || key === 'closing' ? 3 : 5}
            maxLength={MAX_SECTION_CHARS}
            defaultValue={editing[key].text}
            className={textareaClass}
          />
        </Field>
      ))}
      <fieldset className="space-y-3">
        <legend className="text-sm font-medium text-slate-900">
          Objection handling (objection → response)
        </legend>
        {objectionRows.map((o, i) => (
          <div key={i} className="space-y-2 rounded-md border border-slate-200 p-3">
            <Field label={`Objection ${i + 1}`} htmlFor={draftFieldId(`obj-${i}`)}>
              <Input
                id={draftFieldId(`obj-${i}`)}
                name="objection"
                maxLength={300}
                defaultValue={o.objection}
              />
            </Field>
            <Field label={`Response ${i + 1}`} htmlFor={draftFieldId(`resp-${i}`)}>
              <textarea
                id={draftFieldId(`resp-${i}`)}
                name="response"
                rows={2}
                maxLength={MAX_SECTION_CHARS}
                defaultValue={o.response.text}
                className={textareaClass}
              />
            </Field>
          </div>
        ))}
        <p className="text-xs text-slate-600">
          Empty rows are ignored. Save to get more blank rows (up to {MAX_OBJECTIONS}).
        </p>
      </fieldset>
    </>
  );
}

/** Publish the draft; without one the form stays mounted so its last result stays visible. */
export function PublishForm({
  scriptId,
  draftVersionNo,
  draftVersion,
}: {
  scriptId: string;
  draftVersionNo: number | null;
  draftVersion: number;
}) {
  return (
    <ActionForm
      action={publishScriptAction}
      {...(draftVersionNo ? { submitLabel: `Publish version ${draftVersionNo}` } : {})}
      successMessage="Published."
      showSuccess={showFeedback.published(draftVersionNo)}
    >
      {draftVersionNo ? (
        <>
          <input type="hidden" name="scriptId" value={scriptId} />
          <input type="hidden" name="draftVersion" value={draftVersion} />
        </>
      ) : (
        <p className="text-sm text-slate-600">
          No unpublished changes. Save the content to create a draft.
        </p>
      )}
    </ActionForm>
  );
}
