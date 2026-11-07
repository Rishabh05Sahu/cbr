// Email adapter (integration-strategy §8). Local: SMTP to Mailpit. Production provider
// (SES ap-south-1 recommended, not yet selected — OD-13) plugs in behind the same interface.
import nodemailer from 'nodemailer';
import { serverEnv } from '@/env';
import { render, type EmailMessage } from './templates';

export interface EmailSender {
  send(message: EmailMessage): Promise<{ messageId: string }>;
}

export function createSmtpSender(): EmailSender {
  const env = serverEnv();
  const transport = nodemailer.createTransport({
    host: env.SMTP_HOST,
    port: env.SMTP_PORT,
    secure: env.SMTP_PORT === 465,
    ...(env.SMTP_USER ? { auth: { user: env.SMTP_USER, pass: env.SMTP_PASSWORD ?? '' } } : {}),
    // Never let nodemailer log message bodies (they contain single-use links).
    logger: false,
    debug: false,
  });
  return {
    async send(message) {
      const r = render(message);
      const info = await transport.sendMail({
        from: env.EMAIL_FROM,
        to: message.to,
        subject: r.subject,
        text: r.text,
        html: r.html,
      });
      return { messageId: info.messageId };
    },
  };
}
