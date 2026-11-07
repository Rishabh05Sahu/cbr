import pino from 'pino';

/**
 * One structured logger. Never log PII, secrets, tokens or full URLs that may carry them
 * (D3: invitation/reset/verification links). Redaction is a safety net, not permission.
 */
export const REDACT_PATHS = [
  'password',
  '*.password',
  'newPassword',
  '*.newPassword',
  'token',
  '*.token',
  'url',
  '*.url',
  'secret',
  '*.secret',
  'email',
  '*.email',
  'to',
  '*.to',
  'phone',
  '*.phone',
  'phoneE164',
  '*.phoneE164',
  'headers.cookie',
  'headers.authorization',
  '*.headers.cookie',
  '*.headers.authorization',
  'body',
  '*.body',
];

export const logger = pino({
  level: process.env.LOG_LEVEL ?? 'info',
  base: {
    service: process.env.SERVICE_NAME ?? (/worker/.test(process.argv[1] ?? '') ? 'worker' : 'web'),
  },
  redact: { paths: REDACT_PATHS, censor: '[redacted]' },
  timestamp: pino.stdTimeFunctions.isoTime,
});

export type Logger = typeof logger;

/** Strips query strings and fragments (tokens travel there) from anything URL-like. */
export function scrubUrls(message: string): string {
  return message.replace(/(https?:\/\/[^\s?#"']+)[?#][^\s"']*/g, '$1?[redacted]');
}
