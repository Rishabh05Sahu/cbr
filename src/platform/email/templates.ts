// Transactional email templates. Plain, accessible, no tracking pixels.

export type EmailMessage =
  | { template: 'verify-email'; to: string; params: { name: string; url: string } }
  | { template: 'reset-password'; to: string; params: { name: string; url: string } }
  | {
      template: 'invitation';
      to: string;
      params: {
        orgName: string;
        inviterName: string;
        role: string;
        url: string;
        expiresAt: string;
      };
    }
  | { template: 'membership-suspended'; to: string; params: { name: string; orgName: string } }
  | {
      template: 'role-changed';
      to: string;
      params: { name: string; orgName: string; role: string };
    }
  | { template: 'security-notice'; to: string; params: { name: string; notice: string } };

export interface RenderedEmail {
  subject: string;
  text: string;
  html: string;
}

const ROLE_LABEL: Record<string, string> = {
  owner: 'Owner',
  admin: 'Admin',
  sales_manager: 'Sales Manager',
  sales_executive: 'Sales Executive',
  hr_ops: 'HR / Operations',
};

export function roleLabel(role: string): string {
  return ROLE_LABEL[role] ?? role;
}

export function escapeHtml(s: string): string {
  return s
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;')
    .replace(/'/g, '&#39;');
}

function layout(paragraphs: string[], action?: { label: string; url: string }): string {
  const body = paragraphs.map((p) => `<p>${escapeHtml(p)}</p>`).join('');
  const button = action
    ? `<p><a href="${escapeHtml(action.url)}" style="display:inline-block;padding:10px 16px;background:#1e3a8a;color:#fff;text-decoration:none;border-radius:6px">${escapeHtml(action.label)}</a></p>`
    : '';
  return `<!doctype html><html><body style="font-family:system-ui,sans-serif;color:#0f172a;max-width:560px;margin:auto">${body}${button}<p style="color:#64748b;font-size:12px">CBR Property CRM</p></body></html>`;
}

export function render(m: EmailMessage): RenderedEmail {
  switch (m.template) {
    case 'verify-email': {
      const lines = [
        `Hello ${m.params.name},`,
        'Please confirm your email address to finish setting up your CBR Property CRM account.',
      ];
      return {
        subject: 'Confirm your email address',
        text: `${lines.join('\n\n')}\n\n${m.params.url}\n\nIf you did not request this, ignore this email.`,
        html: layout([...lines, 'If you did not request this, ignore this email.'], {
          label: 'Confirm email',
          url: m.params.url,
        }),
      };
    }
    case 'reset-password': {
      const lines = [
        `Hello ${m.params.name},`,
        'Use the link below to choose a new password. It works once and expires in 30 minutes.',
      ];
      return {
        subject: 'Reset your password',
        text: `${lines.join('\n\n')}\n\n${m.params.url}\n\nIf you did not request this, you can ignore this email.`,
        html: layout([...lines, 'If you did not request this, you can ignore this email.'], {
          label: 'Choose a new password',
          url: m.params.url,
        }),
      };
    }
    case 'invitation': {
      const lines = [
        `${m.params.inviterName} invited you to join ${m.params.orgName} on CBR Property CRM as ${roleLabel(m.params.role)}.`,
        `The invitation expires on ${m.params.expiresAt}. Sign in or create an account with this email address to accept it.`,
      ];
      return {
        subject: `Invitation to join ${m.params.orgName}`,
        text: `${lines.join('\n\n')}\n\n${m.params.url}`,
        html: layout(lines, { label: 'View invitation', url: m.params.url }),
      };
    }
    case 'membership-suspended': {
      const lines = [
        `Hello ${m.params.name},`,
        `Your access to ${m.params.orgName} on CBR Property CRM has been suspended by an administrator. Contact your organisation's owner if you think this is a mistake.`,
      ];
      return {
        subject: `Access to ${m.params.orgName} suspended`,
        text: lines.join('\n\n'),
        html: layout(lines),
      };
    }
    case 'role-changed': {
      const lines = [
        `Hello ${m.params.name},`,
        `Your role in ${m.params.orgName} is now ${roleLabel(m.params.role)}.`,
      ];
      return {
        subject: `Your role in ${m.params.orgName} changed`,
        text: lines.join('\n\n'),
        html: layout(lines),
      };
    }
    case 'security-notice': {
      const lines = [
        `Hello ${m.params.name},`,
        m.params.notice,
        'If this was not you, contact your organisation owner or CBR support immediately.',
      ];
      return {
        subject: 'Security alert for your CBR Property CRM account',
        text: lines.join('\n\n'),
        html: layout(lines),
      };
    }
  }
}
