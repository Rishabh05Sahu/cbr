// Renders a script version's five sections (FR-095). The only HTML sink for script content: the
// stored HTML (sanitized on write) is passed through the same sanitizer again here, so nothing
// outside the allowlist reaches the page even if stored content predates a stricter allowlist.
import { Badge } from '@/components/ui';
import { sanitizeScriptHtml, type ScriptContent, type ScriptTargeting } from '@/modules/scripts';
import { LABELS } from '../leads/labels';

const HEADINGS = {
  opening: 'Opening',
  questions: 'Qualification questions',
  pitch: 'Pitch points',
  closing: 'Closing / next step',
} as const;

/**
 * Preview heading ids use their own `view-` prefix: the editor shows the preview beside its fields.
 * Pages that show several scripts at once (the lead-page script panel) pass a prefix per script.
 */
export const previewHeadingId = (key: string, prefix = 'view') => `${prefix}-${key}`;

const proseClass =
  'text-sm text-slate-800 [&_li]:mb-1 [&_ol]:list-decimal [&_ol]:pl-5 [&_p]:mb-2 [&_ul]:list-disc [&_ul]:pl-5';

function Html({ html }: { html: string }) {
  return (
    <div className={proseClass} dangerouslySetInnerHTML={{ __html: sanitizeScriptHtml(html) }} />
  );
}

export function ScriptContentView({
  content,
  idPrefix,
}: {
  content: ScriptContent;
  idPrefix?: string;
}) {
  const hid = (key: string) => previewHeadingId(key, idPrefix);
  const section = (key: keyof typeof HEADINGS) =>
    content[key].html ? (
      <section key={key} aria-labelledby={hid(key)} className="space-y-1">
        <h3 id={hid(key)} className="text-sm font-semibold text-slate-900">
          {HEADINGS[key]}
        </h3>
        <Html html={content[key].html} />
      </section>
    ) : null;
  const empty =
    !content.opening.html &&
    !content.questions.html &&
    !content.pitch.html &&
    !content.closing.html &&
    content.objections.length === 0;
  if (empty) return <p className="text-sm text-slate-600">No content yet.</p>;
  return (
    <div className="space-y-5">
      {section('opening')}
      {section('questions')}
      {section('pitch')}
      {content.objections.length > 0 && (
        <section aria-labelledby={hid('objections')} className="space-y-2">
          <h3 id={hid('objections')} className="text-sm font-semibold text-slate-900">
            Objection handling
          </h3>
          <dl className="space-y-3">
            {content.objections.map((o, i) => (
              <div key={i} className="rounded-md border border-slate-200 p-3">
                <dt className="text-sm font-medium text-slate-900">“{o.objection}”</dt>
                <dd className="mt-1">{o.response.html ? <Html html={o.response.html} /> : '—'}</dd>
              </div>
            ))}
          </dl>
        </section>
      )}
      {section('closing')}
    </div>
  );
}

/** Targeting as small badges ("Any lead" when untargeted). */
export function TargetingBadges({
  t,
  sourceNames,
}: {
  t: ScriptTargeting;
  sourceNames: Map<string, string>;
}) {
  const items = [
    ...t.transactionTypes.map((c) => LABELS[c] ?? c),
    ...t.propertyTypes.map((c) => LABELS[c] ?? c),
    ...t.languages,
    ...t.sourceIds.map((id) => sourceNames.get(id) ?? 'Unknown source'),
  ];
  return (
    <span className="inline-flex flex-wrap gap-1">
      {items.length === 0 ? (
        <Badge>Any lead</Badge>
      ) : (
        items.map((x, i) => <Badge key={i}>{x}</Badge>)
      )}
    </span>
  );
}
