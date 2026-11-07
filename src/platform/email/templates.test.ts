import { describe, expect, it } from 'vitest';
import { escapeHtml, render } from './templates';

describe('email templates', () => {
  it('escapes user-controlled values in HTML', () => {
    const r = render({
      template: 'invitation',
      to: 'x@example.test',
      params: {
        orgName: '<script>alert(1)</script>',
        inviterName: 'A "B"',
        role: 'sales_executive',
        url: 'https://crm.test/invite/1?x="y"',
        expiresAt: '27 Oct 2026',
      },
    });
    expect(r.html).not.toContain('<script>');
    expect(r.html).toContain('&lt;script&gt;');
    expect(r.subject).toBe('Invitation to join <script>alert(1)</script>');
    expect(r.text).toContain('Sales Executive');
  });

  it('reset email states single use and 30-minute expiry', () => {
    const r = render({
      template: 'reset-password',
      to: 'x@example.test',
      params: { name: 'A', url: 'https://crm.test/r' },
    });
    expect(r.text).toMatch(/works once and expires in 30 minutes/);
  });

  it('escapeHtml covers all special characters', () => {
    expect(escapeHtml(`<>&"'`)).toBe('&lt;&gt;&amp;&quot;&#39;');
  });
});
