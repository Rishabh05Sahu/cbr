// FR-095 "rich text, limited formatting (sanitised)" for call script sections (ADR-0011).
//
// Authors write a small markup in a plain textarea:
//   blank line        new paragraph          a line inside a paragraph   line break
//   "- " or "* "      bullet list item       "1. " or "1) "              numbered list item
//   **text**          bold                   _text_                      italic
// The server converts it to HTML (every character of the author's text is HTML-escaped first,
// so markup is the only way to produce a tag) and then passes the result through sanitize-html
// with a strict allowlist. Stored HTML is sanitized again when rendered, so a later change to the
// allowlist also applies to old content. Sanitization reduces, but does not by itself remove,
// every XSS risk: keep sanitize-html updated (supply-chain policy, T21) and render only through
// renderScriptHtml.
import sanitizeHtml from 'sanitize-html';

/** Tags the product needs: paragraphs, line breaks, bold, italic, lists. No attributes at all. */
export const SCRIPT_HTML_ALLOWED_TAGS = ['p', 'br', 'strong', 'em', 'ul', 'ol', 'li'] as const;

const SANITIZE_OPTIONS: sanitizeHtml.IOptions = {
  allowedTags: [...SCRIPT_HTML_ALLOWED_TAGS],
  allowedAttributes: {},
  allowedSchemes: [],
  allowedSchemesAppliedToAttributes: [],
  allowProtocolRelative: false,
  allowVulnerableTags: false,
  // Content of these is dropped with the tag, never shown as text.
  nonTextTags: [
    'script',
    'style',
    'textarea',
    'option',
    'noscript',
    'iframe',
    'object',
    'svg',
    'math',
  ],
  disallowedTagsMode: 'discard',
  // Map common formatting tags onto the allowlist instead of dropping their text.
  transformTags: { b: 'strong', i: 'em' },
};

/** The only HTML sanitizer for script content (write path and render path). */
export function sanitizeScriptHtml(html: string): string {
  return sanitizeHtml(html, SANITIZE_OPTIONS);
}

const escapeHtml = (s: string) =>
  s.replace(/[&<>"']/g, (c) =>
    c === '&' ? '&amp;' : c === '<' ? '&lt;' : c === '>' ? '&gt;' : c === '"' ? '&quot;' : '&#39;',
  );

/** Bold and italic inside one escaped line. */
function inline(escaped: string): string {
  return escaped
    .replace(/\*\*(?=\S)(.+?)(?<=\S)\*\*/g, '<strong>$1</strong>')
    .replace(/(^|[\s(])_(?=\S)(.+?)(?<=\S)_(?=$|[\s).,;:!?])/g, '$1<em>$2</em>');
}

const BULLET = /^\s*[-*]\s+(.*)$/;
const NUMBERED = /^\s*\d{1,3}[.)]\s+(.*)$/;

/** Author markup → sanitized HTML. Empty or whitespace-only text gives ''. */
export function markupToHtml(text: string): string {
  const blocks = text
    .replace(/\r\n?/g, '\n')
    .split(/\n\s*\n/)
    .map((b) => b.split('\n').filter((l) => l.trim() !== ''))
    .filter((lines) => lines.length > 0);
  const html = blocks
    .map((lines) => {
      const list = lines.every((l) => BULLET.test(l))
        ? { tag: 'ul', re: BULLET }
        : lines.every((l) => NUMBERED.test(l))
          ? { tag: 'ol', re: NUMBERED }
          : null;
      if (list)
        return `<${list.tag}>${lines
          .map((l) => `<li>${inline(escapeHtml(l.replace(list.re, '$1').trim()))}</li>`)
          .join('')}</${list.tag}>`;
      return `<p>${lines.map((l) => inline(escapeHtml(l.trim()))).join('<br />')}</p>`;
    })
    .join('');
  return sanitizeScriptHtml(html);
}
