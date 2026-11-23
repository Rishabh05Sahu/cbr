import { createVerify, generateKeyPairSync } from 'node:crypto';
import { describe, expect, it } from 'vitest';
import { createFcmSender, fcmBody, parseServiceAccount, signJwt } from './fcm';

const { privateKey, publicKey } = generateKeyPairSync('rsa', { modulusLength: 2048 });
const sa = {
  project_id: 'cbr-crm-test',
  client_email: 'push@cbr-crm-test.iam.gserviceaccount.com',
  private_key: privateKey.export({ type: 'pkcs8', format: 'pem' }).toString(),
};
const message = { title: 'Lead assigned: R. Khan', body: 'From Bayut', data: { type: 'X' } };

describe('service account', () => {
  it('reads the JSON file contents or the same base64-encoded', () => {
    const json = JSON.stringify({ ...sa, type: 'service_account' });
    expect(parseServiceAccount(json).project_id).toBe('cbr-crm-test');
    expect(parseServiceAccount(Buffer.from(json).toString('base64')).client_email).toBe(
      sa.client_email,
    );
    expect(() => parseServiceAccount('{"project_id":"x"}')).toThrow();
  });

  it('signs an RS256 JWT for the FCM scope', () => {
    const jwt = signJwt(sa, 1_800_000_000);
    const [h, c, s] = jwt.split('.');
    expect(JSON.parse(Buffer.from(h!, 'base64url').toString())).toEqual({
      alg: 'RS256',
      typ: 'JWT',
    });
    expect(JSON.parse(Buffer.from(c!, 'base64url').toString())).toMatchObject({
      iss: sa.client_email,
      scope: 'https://www.googleapis.com/auth/firebase.messaging',
      exp: 1_800_003_600,
    });
    expect(
      createVerify('RSA-SHA256')
        .update(`${h}.${c}`)
        .verify(publicKey, Buffer.from(s!, 'base64url')),
    ).toBe(true);
  });
});

describe('message', () => {
  it('hides the content on the lock screen and uses the app channel', () => {
    const b = fcmBody('tok', message);
    expect(b.message.android.notification).toMatchObject({
      visibility: 'PRIVATE',
      channel_id: 'crm_updates',
    });
    expect(b.message.notification.title).toBe('Lead assigned: R. Khan');
  });
});

describe('sender', () => {
  const fake = (replies: { status: number; body?: string }[]) => {
    const calls: string[] = [];
    const f = (async (url: string) => {
      calls.push(String(url));
      if (String(url).includes('oauth2')) {
        return new Response(JSON.stringify({ access_token: 'at', expires_in: 3600 }));
      }
      const r = replies.shift()!;
      return new Response(r.body ?? '{}', { status: r.status });
    }) as typeof fetch;
    return { f, calls };
  };

  it('maps FCM replies: ok, dead token, other failure; reuses the access token', async () => {
    const { f, calls } = fake([
      { status: 200 },
      {
        status: 404,
        body: '{"error":{"status":"NOT_FOUND","details":[{"errorCode":"UNREGISTERED"}]}}',
      },
      {
        status: 400,
        body: '{"error":{"message":"The registration token is not a valid FCM registration token"}}',
      },
      { status: 503 },
    ]);
    const s = createFcmSender(sa, f, () => 1_800_000_000_000);
    expect(await s.send('a', message)).toBe('sent');
    expect(await s.send('b', message)).toBe('dead');
    expect(await s.send('c', message)).toBe('dead');
    expect(await s.send('d', message)).toBe('failed');
    expect(calls.filter((u) => u.includes('oauth2'))).toHaveLength(1);
    expect(calls[1]).toBe('https://fcm.googleapis.com/v1/projects/cbr-crm-test/messages:send');
  });
});
