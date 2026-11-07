// FR-095 sanitized rich text: the allowlist keeps the product's formatting and drops everything
// else (scripts, handlers, URLs, styles, SVG/embeds, malformed markup), and author markup can
// only produce allowlisted tags because the author's text is escaped first.
import { describe, expect, it } from 'vitest';
import { markupToHtml, sanitizeScriptHtml, SCRIPT_HTML_ALLOWED_TAGS } from './rich-text';

/** A "<" that does not open or close an allowlisted tag. */
const ONLY_ALLOWED_TAGS = new RegExp(`<(?!/?(${SCRIPT_HTML_ALLOWED_TAGS.join('|')})[\\s/>])`);

describe('sanitizeScriptHtml (allowlist)', () => {
  it('keeps exactly the allowed formatting', () => {
    expect(SCRIPT_HTML_ALLOWED_TAGS).toEqual(['p', 'br', 'strong', 'em', 'ul', 'ol', 'li']);
    const ok =
      '<p>Hello <strong>sir</strong>, <em>madam</em><br />next</p><ul><li>a</li></ul><ol><li>b</li></ol>';
    expect(sanitizeScriptHtml(ok)).toBe(ok);
    expect(sanitizeScriptHtml('<b>bold</b> <i>it</i>')).toBe('<strong>bold</strong> <em>it</em>');
  });

  it.each([
    ['script tag', '<p>hi</p><script>alert(1)</script>', '<p>hi</p>'],
    ['script with src', '<script src="https://evil.test/x.js"></script>ok', 'ok'],
    ['event handler', '<p onclick="alert(1)" onmouseover="x()">hi</p>', '<p>hi</p>'],
    ['img onerror', '<img src=x onerror=alert(1)>text', 'text'],
    ['javascript: link', '<a href="javascript:alert(1)">click</a>', 'click'],
    ['data: link', '<a href="data:text/html;base64,PHNjcmlwdD4=">x</a>', 'x'],
    ['vbscript: link', '<a href="vbscript:msgbox(1)">x</a>', 'x'],
    ['style attribute', '<p style="background:url(javascript:alert(1))">x</p>', '<p>x</p>'],
    ['style tag', '<style>body{display:none}</style>shown', 'shown'],
    ['svg', '<svg onload=alert(1)><script>alert(1)</script></svg>after', 'after'],
    ['svg with foreignObject', '<svg><foreignObject><p>x</p></foreignObject></svg>y', 'y'],
    ['math', '<math><mtext><img src=x onerror=alert(1)></mtext></math>z', 'z'],
    ['iframe', '<iframe src="https://evil.test"></iframe>k', 'k'],
    ['object/embed', '<object data="x.swf"></object><embed src="x.swf">m', 'm'],
    ['form/input', '<form action="https://evil.test"><input value="x"></form>n', 'n'],
    ['meta refresh', '<meta http-equiv="refresh" content="0;url=https://evil.test">o', 'o'],
    ['class/id attributes', '<p class="x" id="y" data-z="1">p</p>', '<p>p</p>'],
  ])('removes %s', (_, input, expected) => {
    expect(sanitizeScriptHtml(input)).toBe(expected);
  });

  it('copes with malformed markup without letting anything through', () => {
    const out = sanitizeScriptHtml('<p>open <strong>bold<p onclick=x>"><script>alert(1)</script');
    expect(out).not.toMatch(/<script|onclick|alert\(1\)<\/script/i);
    expect(out).not.toMatch(/<(?!\/?(p|br|strong|em|ul|ol|li)\b)/);
    expect(sanitizeScriptHtml('<<script>script>alert(1)<</script>/script>')).not.toMatch(
      /<script/i,
    );
    expect(sanitizeScriptHtml('<scr<script>ipt>alert(1)</scr</script>ipt>')).not.toMatch(
      /<script/i,
    );
  });

  it('is idempotent (stored HTML can be sanitized again at render)', () => {
    const once = sanitizeScriptHtml('<p onclick=x>a <b>b</b><script>c</script></p>');
    expect(sanitizeScriptHtml(once)).toBe(once);
  });
});

describe('markupToHtml (author markup)', () => {
  it('turns paragraphs, line breaks, lists, bold and italic into allowed HTML', () => {
    const md = [
      'Namaste! **Thank you** for your _enquiry_.',
      'May I take two minutes?',
      '',
      '- Budget?',
      '- Preferred area?',
      '',
      '1. Explain the project',
      '2) Share the brochure',
    ].join('\n');
    expect(markupToHtml(md)).toBe(
      '<p>Namaste! <strong>Thank you</strong> for your <em>enquiry</em>.<br />May I take two minutes?</p>' +
        '<ul><li>Budget?</li><li>Preferred area?</li></ul>' +
        '<ol><li>Explain the project</li><li>Share the brochure</li></ol>',
    );
  });

  it('escapes the author’s own HTML instead of interpreting it', () => {
    const out = markupToHtml('<script>alert(1)</script> <img src=x onerror=alert(1)> **ok**');
    expect(out).toBe(
      '<p>&lt;script&gt;alert(1)&lt;/script&gt; &lt;img src=x onerror=alert(1)&gt; <strong>ok</strong></p>',
    );
    expect(out).not.toMatch(/<script|<img/);
  });

  it('cannot smuggle markup through the bold or italic syntax', () => {
    const out = markupToHtml('**<b onmouseover=alert(1)>x</b>** _"><svg onload=alert(1)>_');
    // Only allowlisted tags exist as real markup; the rest is escaped, visible text.
    expect(out).not.toMatch(ONLY_ALLOWED_TAGS);
    expect(out).not.toMatch(/<[a-z]+[^>]*\son[a-z]+=/i);
    expect(out).toContain('&lt;svg onload=alert(1)&gt;');
    expect(out).toContain('&lt;b onmouseover=alert(1)&gt;');
  });

  it('gives an empty string for blank input and keeps snake_case words intact', () => {
    expect(markupToHtml('   \n\n  ')).toBe('');
    expect(markupToHtml('use lead_source_id here')).toBe('<p>use lead_source_id here</p>');
  });
});
