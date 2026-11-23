// Firebase Cloud Messaging HTTP v1 sender for the Android app (ADR-0027 slice 5). No SDK: an
// OAuth access token is minted from the service-account key (RS256 JWT, cached ~55 min) and each
// message is one POST. Without FCM_SERVICE_ACCOUNT_JSON the sender is disabled.
import { createSign } from 'node:crypto';
import { z } from 'zod';
import { serverEnv } from '@/env';

const serviceAccount = z.object({
  project_id: z.string().min(1),
  client_email: z.email(),
  private_key: z.string().includes('PRIVATE KEY'),
});
type ServiceAccount = z.infer<typeof serviceAccount>;

/** The env value is the JSON file's contents or the same base64-encoded. */
export function parseServiceAccount(raw: string): ServiceAccount {
  const text = raw.trim().startsWith('{') ? raw : Buffer.from(raw, 'base64').toString('utf8');
  return serviceAccount.parse(JSON.parse(text));
}

export interface PushMessage {
  title: string;
  body: string;
  /** Small string map the app reads on tap (link, type). */
  data: Record<string, string>;
}

/** sent; dead = the token is gone (uninstalled, expired): delete it; failed = try another time. */
export type PushResult = 'sent' | 'dead' | 'failed';

export interface PushSender {
  send(token: string, message: PushMessage): Promise<PushResult>;
}

const b64url = (b: Buffer | string) => Buffer.from(b).toString('base64url');

export function signJwt(sa: ServiceAccount, nowSec: number): string {
  const head = b64url(JSON.stringify({ alg: 'RS256', typ: 'JWT' }));
  const claims = b64url(
    JSON.stringify({
      iss: sa.client_email,
      scope: 'https://www.googleapis.com/auth/firebase.messaging',
      aud: 'https://oauth2.googleapis.com/token',
      iat: nowSec,
      exp: nowSec + 3600,
    }),
  );
  const sig = createSign('RSA-SHA256').update(`${head}.${claims}`).sign(sa.private_key);
  return `${head}.${claims}.${b64url(sig)}`;
}

/** FCM v1 body. Marked PRIVATE: a lock screen set to hide sensitive content shows "Contents hidden" (titles name leads). */
export function fcmBody(token: string, m: PushMessage) {
  return {
    message: {
      token,
      notification: { title: m.title.slice(0, 200), body: m.body.slice(0, 500) },
      data: m.data,
      android: {
        priority: 'HIGH',
        notification: {
          channel_id: 'crm_updates',
          visibility: 'PRIVATE',
          icon: 'ic_stat_notify',
          color: '#0B5F66',
        },
      },
    },
  };
}

export function createFcmSender(
  sa: ServiceAccount,
  fetchImpl: typeof fetch = fetch,
  now: () => number = () => Date.now(),
): PushSender {
  let cached: { token: string; until: number } | null = null;

  async function accessToken(): Promise<string> {
    if (cached && cached.until > now()) return cached.token;
    const res = await fetchImpl('https://oauth2.googleapis.com/token', {
      method: 'POST',
      headers: { 'content-type': 'application/x-www-form-urlencoded' },
      body: new URLSearchParams({
        grant_type: 'urn:ietf:params:oauth:grant-type:jwt-bearer',
        assertion: signJwt(sa, Math.floor(now() / 1000)),
      }),
    });
    if (!res.ok) throw new Error(`FCM auth failed (${res.status})`);
    const j = (await res.json()) as { access_token: string; expires_in?: number };
    cached = { token: j.access_token, until: now() + ((j.expires_in ?? 3600) - 300) * 1000 };
    return cached.token;
  }

  return {
    async send(token, message) {
      const res = await fetchImpl(
        `https://fcm.googleapis.com/v1/projects/${encodeURIComponent(sa.project_id)}/messages:send`,
        {
          method: 'POST',
          headers: {
            authorization: `Bearer ${await accessToken()}`,
            'content-type': 'application/json',
          },
          body: JSON.stringify(fcmBody(token, message)),
        },
      );
      if (res.ok) return 'sent';
      const text = await res.text().catch(() => '');
      // 404 UNREGISTERED: the app was uninstalled or the token rotated. 400 INVALID_ARGUMENT
      // naming the token: malformed. Both mean the row is useless.
      if (res.status === 404 || /UNREGISTERED/.test(text)) return 'dead';
      if (res.status === 400 && /registration token/i.test(text)) return 'dead';
      if (res.status === 401) cached = null;
      return 'failed';
    },
  };
}

let sender: PushSender | null | undefined;

/** The configured sender, or null when FCM is not set up (push is then skipped). */
export function pushSender(): PushSender | null {
  if (sender === undefined) {
    const raw = serverEnv().FCM_SERVICE_ACCOUNT_JSON;
    sender = raw ? createFcmSender(parseServiceAccount(raw)) : null;
  }
  return sender;
}
