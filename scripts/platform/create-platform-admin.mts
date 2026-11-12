// Creates the first CBR platform administrator: a confirmed account with platform_role
// PLATFORM_ADMIN. Public sign-up is invitation-only, so the first platform admin cannot be
// created through the app. Run from your own machine; writes as crm_auth (the auth library's
// role), exactly as server-side provisioning does (src/platform/auth/org-admin.ts).
//
//   npx tsx --env-file=.env.vercel scripts/platform/create-platform-admin.mts \
//     --email you@example.com --name "Your Name" [--password-out secrets/platform-admin.txt]
//
// Password: typed at a hidden prompt, or with --password-out a strong one is generated and
// written to that (git-ignored) file. Never pass a password on the command line.
// Needs AUTH_DATABASE_URL, plus DATABASE_CA_CERT when the URL has no ssl* parameters.
// An existing account is refused unless --promote is given (then it is confirmed and promoted;
// its password is left unchanged).
import { execFileSync } from 'node:child_process';
import { randomInt } from 'node:crypto';
import fs from 'node:fs';
import path from 'node:path';
import readline from 'node:readline';
import { hashPassword } from 'better-auth/crypto';
import pg from 'pg';
import { normalizePem } from '../../src/env';
import { uuidv7 } from '../../src/lib/uuidv7';
import { SUPABASE_ROOT_2021_CA } from '../../src/platform/db/supabase-root-ca';

const MIN = 12; // src/platform/auth/auth.ts minPasswordLength
const MAX = 128;

function arg(name: string): string | undefined {
  const i = process.argv.indexOf(`--${name}`);
  return i > 0 ? process.argv[i + 1] : undefined;
}

function fail(msg: string): never {
  console.error(`create-platform-admin: ${msg}`);
  process.exit(1);
}

function generatePassword(): string {
  const sets = ['ABCDEFGHJKLMNPQRSTUVWXYZ', 'abcdefghijkmnopqrstuvwxyz', '23456789', '@#%+=!?'];
  const all = sets.join('');
  const chars = sets.map((s) => s[randomInt(s.length)]!);
  while (chars.length < 20) chars.push(all[randomInt(all.length)]!);
  for (let i = chars.length - 1; i > 0; i--) {
    const j = randomInt(i + 1);
    [chars[i], chars[j]] = [chars[j]!, chars[i]!];
  }
  return chars.join('');
}

function promptHidden(question: string): Promise<string> {
  if (!process.stdin.isTTY) fail('no terminal for the password prompt; use --password-out');
  return new Promise((resolve) => {
    const rl = readline.createInterface({ input: process.stdin, output: process.stdout });
    const out = rl as unknown as { _writeToOutput: (s: string) => void };
    let muted = false;
    out._writeToOutput = (s) => {
      if (!muted || s.includes('\n')) process.stdout.write(muted ? '\n' : s);
    };
    rl.question(question, (answer) => {
      rl.close();
      resolve(answer);
    });
    muted = true;
  });
}

function assertGitIgnored(file: string) {
  try {
    execFileSync('git', ['check-ignore', '-q', file], { stdio: 'ignore' });
  } catch {
    fail(`${file} is not git-ignored; put it under secrets/`);
  }
}

const email = arg('email')?.trim().toLowerCase();
const name = arg('name')?.trim();
const passwordOut = arg('password-out');
const promote = process.argv.includes('--promote');
if (!email || !/^[^@\s]+@[^@\s]+\.[^@\s]+$/.test(email)) fail('--email is required');
if (!name || name.length < 2) fail('--name is required');

const url = process.env.AUTH_DATABASE_URL;
if (!url) fail('AUTH_DATABASE_URL is not set (run with --env-file=<file>)');
if (!/^postgres(ql)?:\/\/crm_auth[.:@]/.test(url))
  fail('AUTH_DATABASE_URL must connect as crm_auth');
const caRaw = process.env.DATABASE_CA_CERT?.trim();
const ca = caRaw
  ? caRaw === 'supabase-root-2021'
    ? SUPABASE_ROOT_2021_CA
    : normalizePem(caRaw)
  : undefined;
if (caRaw && !ca) fail('DATABASE_CA_CERT is not a PEM certificate or supabase-root-2021');

let password: string | undefined;
if (!promote) {
  if (passwordOut) {
    assertGitIgnored(passwordOut);
    password = generatePassword();
  } else {
    password = await promptHidden(`Password for ${email} (${MIN}-${MAX} characters): `);
    const again = await promptHidden('Repeat the password: ');
    if (password !== again) fail('the passwords do not match');
  }
  if (password.length < MIN || password.length > MAX)
    fail(`the password must be ${MIN}-${MAX} characters`);
}

const client = new pg.Client({
  connectionString: url,
  ...(ca ? { ssl: { ca, rejectUnauthorized: true } } : {}),
});
await client.connect();
try {
  await client.query('BEGIN');
  const existing = await client.query<{ id: string }>(
    'SELECT id FROM "user" WHERE email = $1 FOR UPDATE',
    [email],
  );
  if (existing.rows[0]) {
    if (!promote) fail(`${email} already has an account; add --promote to make it platform admin`);
    await client.query(
      `UPDATE "user" SET platform_role = 'PLATFORM_ADMIN', email_verified = true, updated_at = now()
        WHERE id = $1`,
      [existing.rows[0].id],
    );
    await client.query('COMMIT');
    console.log(`promoted ${email} to platform admin (confirmed); password unchanged`);
  } else {
    if (promote) fail(`${email} has no account to promote`);
    const id = uuidv7();
    await client.query(
      `INSERT INTO "user" (id, name, email, email_verified, platform_role)
       VALUES ($1, $2, $3, true, 'PLATFORM_ADMIN')`,
      [id, name, email],
    );
    await client.query(
      `INSERT INTO account (id, account_id, provider_id, user_id, password, updated_at)
       VALUES ($1, $2::text, 'credential', $2::uuid, $3, now())`,
      [uuidv7(), id, await hashPassword(password!)],
    );
    await client.query('COMMIT');
    if (passwordOut) {
      fs.mkdirSync(path.dirname(passwordOut), { recursive: true });
      fs.writeFileSync(passwordOut, `${email}\n${password}\n`, { mode: 0o600 });
      console.log(
        `created platform admin ${email} (confirmed); password written to ${passwordOut}`,
      );
    } else {
      console.log(`created platform admin ${email} (confirmed)`);
    }
  }
} catch (err) {
  await client.query('ROLLBACK').catch(() => {});
  throw err;
} finally {
  await client.end();
}
