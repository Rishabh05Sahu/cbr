// FR-057/FR-099 script panel, rendered to static HTML (no DOM environment in this repo): the
// drawer markup, the best match first, the no-match state, and the contact restriction for
// Do-Not-Contact and invalid-number leads. A script is reading material: no contact links or forms.
import { createElement, type ComponentProps } from 'react';
import { renderToStaticMarkup } from 'react-dom/server';
import { describe, expect, it } from 'vitest';
import { ScriptPanel, scriptPanelNotice, type PanelScript } from './script-panel';

const script = (id: string, name: string): PanelScript => ({
  id,
  name,
  versionId: `v-${id}`,
  versionNo: 2,
  versionLine: 'Version 2 · published 28 Oct 2026, 10:02',
  targeting: createElement('span', null, `targets of ${name}`),
  content: createElement('p', null, `content of ${name}`),
});
type Props = ComponentProps<typeof ScriptPanel>;
const panel = (p: Partial<Props>) =>
  renderToStaticMarkup(
    createElement(ScriptPanel, {
      scripts: [script('s1', 'Apartment buyers'), script('s2', 'Buyers')],
      contactStatus: 'OK',
      matchedOn: 'looking to: Buy · property type: Apartment · language: mr · source: Walk-in',
      allScriptsHref: '/app/scripts',
      ...p,
    }),
  );

describe('ScriptPanel', () => {
  it('shows the best match and opens the matching scripts in a labelled drawer', () => {
    const html = panel({});
    expect(html).toContain('Best match: Apartment buyers (2 matching scripts)');
    expect(html).toMatch(/<button[^>]*aria-haspopup="dialog"[^>]*>Open script<\/button>/);
    // The drawer is a closed native dialog until opened, named by its heading.
    const dialog = /<dialog([^>]*)>/.exec(html)![1]!;
    expect(dialog).not.toContain(' open');
    const labelledBy = /aria-labelledby="([^"]+)"/.exec(dialog)![1];
    expect(html).toContain(`<h2 id="${labelledBy}"`);
    // Best match first and shown; the other match is hidden until chosen.
    expect(html).toMatch(/aria-pressed="true"[^>]*>Apartment buyers \(best match\)</);
    expect(html).toMatch(/aria-pressed="false"[^>]*>Buyers</);
    expect(html).toMatch(/<div data-script-id="s1">.*content of Apartment buyers/);
    expect(html).toMatch(/<div hidden="" data-script-id="s2">/);
  });

  it('names a single match without a chooser', () => {
    const html = panel({ scripts: [script('s1', 'Buyers')] });
    expect(html).toContain('Best match: Buyers<');
    expect(html).not.toContain('Matching scripts');
  });

  it('explains a missing match with the details used and links to all scripts, no drawer', () => {
    const html = panel({ scripts: [] });
    expect(html).toContain(
      'No published script matches this lead (looking to: Buy · property type: Apartment · language: mr · source: Walk-in).',
    );
    expect(html).toContain('href="/app/scripts"');
    expect(html).not.toContain('<dialog');
  });

  it('repeats the contact restriction inside the drawer for do-not-contact and invalid leads', () => {
    expect(scriptPanelNotice('OK')).toBeNull();
    const dnc = panel({ contactStatus: 'DO_NOT_CONTACT' });
    expect(dnc).toMatch(/<dialog[\s\S]*role="alert"[\s\S]*Do not contact\./);
    expect(dnc).toContain('A script does not permit calling or messaging them');
    const invalid = panel({ contactStatus: 'INVALID' });
    expect(invalid).toMatch(/<dialog[\s\S]*role="status"[\s\S]*Invalid number\./);
    expect(panel({ contactStatus: 'OK' })).not.toMatch(/Do not contact|Invalid number/);
  });

  it('offers no contact actions: no tel, sms or WhatsApp links and no forms', () => {
    for (const contactStatus of ['OK', 'DO_NOT_CONTACT', 'INVALID'] as const) {
      const html = panel({ contactStatus });
      expect(html).not.toMatch(/tel:|sms:|wa\.me|whatsapp:|mailto:/i);
      expect(html).not.toContain('<form');
    }
  });
});
