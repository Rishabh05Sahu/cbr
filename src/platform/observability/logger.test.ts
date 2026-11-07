import { Writable } from 'node:stream';
import pino from 'pino';
import { describe, expect, it } from 'vitest';
import { REDACT_PATHS, scrubUrls } from './logger';

describe('logger redaction', () => {
  it('redacts secrets, tokens, URLs and contact details', () => {
    let out = '';
    const sink = new Writable({
      write(chunk, _enc, cb) {
        out += chunk.toString();
        cb();
      },
    });
    const log = pino({ redact: { paths: REDACT_PATHS, censor: '[redacted]' } }, sink);
    log.info(
      {
        token: 't0k3n',
        url: 'http://x/accept?id=abc',
        email: 'a@b.test',
        user: { password: 'pw', email: 'c@d.test' },
        headers: { cookie: 'session=1' },
      },
      'event',
    );
    expect(out).not.toMatch(/t0k3n|abc|a@b\.test|c@d\.test|session=1|"pw"/);
  });

  it('scrubs query strings from URLs in free text', () => {
    expect(scrubUrls('open https://crm.test/reset-password?token=SECRET now')).toBe(
      'open https://crm.test/reset-password?[redacted] now',
    );
    expect(scrubUrls('no url here')).toBe('no url here');
  });
});
