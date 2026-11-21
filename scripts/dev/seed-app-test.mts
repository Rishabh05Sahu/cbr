// Local test logins for the Android app (ADR-0027): an organisation "CBR Test Realty" in the LOCAL
// database with an Owner (authenticator enrolled) and a Sales Executive, plus a few sample leads
// and follow-ups. Refuses to run against anything but a local database.
//
//   npx tsx --env-file=.env scripts/dev/seed-app-test.mts
//
// Prints the passwords, the Owner's authenticator setup key and recovery codes once. Run again
// only after deleting the organisation (it refuses when the test accounts already exist).
import { randomInt } from 'node:crypto';
import { auth } from '@/platform/auth/auth';
import { resolveRequestContext } from '@/platform/auth/context';
import { createUserWithPassword } from '@/platform/auth/org-admin';
import * as leads from '@/modules/leads';
import * as tasks from '@/modules/tasks';
import { secretFromUri, totp } from '../../tests/support/totp';

const OWNER = { email: 'owner@cbr-test.example', name: 'Test Owner' };
const EXEC = { email: 'exec@cbr-test.example', name: 'Test Executive' };

for (const k of ['DATABASE_URL', 'AUTH_DATABASE_URL']) {
  const host = new URL(process.env[k] ?? 'postgresql://none').hostname;
  if (host !== '127.0.0.1' && host !== 'localhost') {
    console.error(`${k} is not a local database (${host}). This script is for local testing only.`);
    process.exit(1);
  }
}

function password(): string {
  const sets = ['ABCDEFGHJKLMNPQRSTUVWXYZ', 'abcdefghijkmnopqrstuvwxyz', '23456789'];
  const all = sets.join('');
  const chars = sets.map((s) => s[randomInt(s.length)]!);
  while (chars.length < 14) chars.push(all[randomInt(all.length)]!);
  return chars.sort(() => randomInt(3) - 1).join('');
}

function cookies(h: Headers, prev = ''): Headers {
  const jar = new Map(prev.split('; ').filter(Boolean).map((p) => [p.split('=')[0]!, p]));
  for (const c of h.getSetCookie()) {
    const pair = c.split(';')[0]!;
    const name = pair.split('=')[0]!;
    if (pair.endsWith('=') || /max-age=0/i.test(c)) jar.delete(name);
    else jar.set(name, pair);
  }
  return new Headers({ cookie: [...jar.values()].join('; ') });
}

async function signIn(email: string, pw: string, secret?: string): Promise<Headers> {
  const r = await auth().api.signInEmail({ body: { email, password: pw }, returnHeaders: true });
  let jar = cookies(r.headers);
  if ('twoFactorRedirect' in r.response && r.response.twoFactorRedirect && secret) {
    const v = await auth().api.verifyTOTP({ headers: jar, body: { code: totp(secret) }, returnHeaders: true });
    jar = cookies(v.headers, jar.get('cookie') ?? '');
  }
  return jar;
}

const ctx = await auth().$context;
for (const u of [OWNER, EXEC]) {
  if (await ctx.internalAdapter.findUserByEmail(u.email)) {
    console.error(`${u.email} already exists. Delete the test organisation first, or reuse its logins.`);
    process.exit(1);
  }
}

const ownerPw = password();
const execPw = password();
const owner = await createUserWithPassword({ ...OWNER, password: ownerPw, emailVerified: true });
const exec = await createUserWithPassword({ ...EXEC, password: execPw, emailVerified: true });

const org = await auth().api.createOrganization({
  body: { name: 'CBR Test Realty', slug: `cbr-test-${randomInt(1e6)}`, userId: owner.id },
});
if (!org) throw new Error('organisation not created');
await ctx.adapter.update({
  model: 'organization',
  where: [{ field: 'id', value: org.id }],
  update: { timeZone: 'Asia/Dubai', locale: 'en-AE' },
});
await auth().api.addMember({ body: { userId: exec.id, organizationId: org.id, role: 'sales_executive' } });

// Owners must have an authenticator (item D).
const ownerJar = await signIn(OWNER.email, ownerPw);
const enabled = await auth().api.enableTwoFactor({ headers: ownerJar, body: { password: ownerPw } });
if (enabled.method !== 'totp') throw new Error('expected TOTP');
const secret = secretFromUri(enabled.totpURI);
await auth().api.verifyTOTP({ headers: ownerJar, body: { code: totp(secret) } });

// Sample leads owned by the executive, with follow-ups due today and overdue.
const execJar = await signIn(EXEC.email, execPw);
await auth().api.setActiveOrganization({ headers: execJar, body: { organizationId: org.id } });
const r = await resolveRequestContext(execJar);
if (!r.ok) throw new Error(`no context: ${r.reason}`);
const dubai = (offsetHours: number) => {
  const d = new Date(Date.now() + 4 * 3600_000 + offsetHours * 3600_000);
  return d.toISOString().slice(0, 16); // org-local datetime-local value
};
const samples = [
  { fullName: 'Rahul Khan', primaryPhone: '+971501234561', preferredCity: 'Dubai', due: 2 },
  { fullName: 'Sara Mansour', primaryPhone: '+971501234562', preferredCity: 'Dubai', due: 5 },
  { fullName: 'Ali Raza', primaryPhone: '+971501234563', preferredCity: 'Sharjah', due: null },
];
for (const s of samples) {
  const c = await leads.createLead(r.ctx, {
    fullName: s.fullName,
    primaryPhone: s.primaryPhone,
    preferredCity: s.preferredCity,
  });
  if (c.status === 'created' && s.due !== null)
    await tasks.scheduleFollowUp(r.ctx, c.leadId, { dueAt: dubai(s.due), title: `Call ${s.fullName}` });
}

console.log(`
Local test organisation "CBR Test Realty" (Asia/Dubai) created.

OWNER            ${OWNER.email}
  password       ${ownerPw}
  authenticator  setup key ${secret}   (Google Authenticator → + → Enter a setup key, time-based)
  recovery codes ${enabled.backupCodes.join('  ')}

SALES EXECUTIVE  ${EXEC.email}
  password       ${execPw}

Sample leads: ${samples.map((s) => s.fullName).join(', ')} (owned by the executive).
`);
process.exit(0);
