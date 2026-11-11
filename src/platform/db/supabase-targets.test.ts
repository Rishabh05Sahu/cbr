// Offline checks of the QA / production target selection in scripts/db/acceptance-env.mjs
// (--target qa|prod): which file is read, what may be in it, that QA and production never share
// a project or a password, and that production writes need the typed confirmation.
import { mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { PassThrough } from 'node:stream';
import { pathToFileURL } from 'node:url';
import { afterEach, beforeAll, beforeEach, describe, expect, it } from 'vitest';

const root = join(__dirname, '..', '..', '..');
const CA = join(__dirname, '__fixtures__', 'test-only-ca.crt');
const HOST = 'aws-0-ap-south-1.pooler.supabase.com'; // synthetic: never connected to
const ROLES = ['migrator', 'app', 'auth', 'platform', 'cleanup'] as const;
const URL_VAR: Record<string, string> = {
  migrator: 'ACCEPTANCE_DATABASE_MIGRATOR_URL',
  app: 'ACCEPTANCE_DATABASE_URL',
  auth: 'ACCEPTANCE_AUTH_DATABASE_URL',
  platform: 'ACCEPTANCE_PLATFORM_DATABASE_URL',
  cleanup: 'ACCEPTANCE_CLEANUP_DATABASE_URL',
};

/** A complete, valid target file for one project; `tag` keeps passwords distinct per target. */
function targetVars(ref: string, tag: string): Record<string, string> {
  const e: Record<string, string> = {
    ACCEPTANCE_PROJECT_REF: ref,
    ACCEPTANCE_PGHOST: HOST,
    ACCEPTANCE_PGPORT: '5432',
    ACCEPTANCE_PGDATABASE: 'postgres',
    ACCEPTANCE_PGUSER: `postgres.${ref}`,
    ACCEPTANCE_PGPASSWORD: `Admin-${tag}-synthetic-0123456789ab`,
    ACCEPTANCE_PGSSLMODE: 'verify-full',
    ACCEPTANCE_PGSSLROOTCERT: CA,
  };
  for (const r of ROLES) {
    const pw = `${r}-${tag}-synthetic-0123456789abcdef`;
    e[`ACCEPTANCE_CRM_${r.toUpperCase()}_PASSWORD`] = pw;
    e[URL_VAR[r]!] = `postgresql://crm_${r}.${ref}:${pw}@${HOST}:5432/postgres`;
  }
  return e;
}
const QA_REF = 'qaqaqaqaqa0123456789';
const PROD_REF = 'prodprodpr0123456789';
const dotenv = (vars: Record<string, string>) =>
  Object.entries(vars)
    .map(([k, v]) => `${k}=${v}`)
    .join('\n');

type Env = Record<string, string>;
type Mod = {
  takeTarget: (args: string[]) => { target?: string; rest: string[] };
  loadTargetEnv: (target: string | undefined, opts: { dir: string; checkGit: boolean }) => Env;
  validateAcceptance: (env: Env, need: string) => { errors: string[] };
  confirmProduction: (
    ref: string,
    action: string,
    io: { input: NodeJS.ReadableStream & { isTTY?: boolean }; output: NodeJS.WritableStream },
  ) => Promise<boolean>;
};
let mod: Mod;
beforeAll(async () => {
  mod = (await import(
    pathToFileURL(join(root, 'scripts', 'db', 'acceptance-env.mjs')).href
  )) as Mod;
});

let dir: string;
beforeEach(() => {
  dir = mkdtempSync(join(tmpdir(), 'crm-targets-'));
  // The local development settings: never a target, but their passwords must not be reused.
  writeFileSync(
    join(dir, '.env'),
    dotenv({
      DATABASE_URL: 'postgresql://crm_app:local-app-pw@127.0.0.1:55432/crm_dev',
      ACCEPTANCE_PROJECT_REF: 'accaccaccacc01234567',
    }),
  );
});
afterEach(() => rmSync(dir, { recursive: true, force: true }));
const load = (t?: string) => mod.loadTargetEnv(t, { dir, checkGit: false });

describe('--target option', () => {
  it('takes qa or prod out of the arguments and leaves the rest in order', () => {
    expect(mod.takeTarget(['--target', 'qa', '--deploy'])).toEqual({
      target: 'qa',
      rest: ['--deploy'],
    });
    expect(mod.takeTarget(['--record-committed', 'x', '--target', 'prod'])).toEqual({
      target: 'prod',
      rest: ['--record-committed', 'x'],
    });
    expect(mod.takeTarget(['--status'])).toEqual({ target: undefined, rest: ['--status'] });
  });

  it('refuses a missing, unknown or repeated target', () => {
    expect(() => mod.takeTarget(['--target'])).toThrow(/qa, prod/);
    expect(() => mod.takeTarget(['--target', 'production'])).toThrow(/qa, prod/);
    expect(() => mod.takeTarget(['--target', 'qa', '--target', 'prod'])).toThrow(/twice/);
  });
});

describe('target files', () => {
  it('without a target, reads .env unchanged (the acceptance project)', () => {
    expect(load().ACCEPTANCE_PROJECT_REF).toBe('accaccaccacc01234567');
  });

  it('with a target, uses only that file’s ACCEPTANCE_* values, never .env’s', () => {
    writeFileSync(join(dir, '.env.supabase-qa'), dotenv(targetVars(QA_REF, 'qa')));
    const env = load('qa');
    expect(env.ACCEPTANCE_PROJECT_REF).toBe(QA_REF);
    expect(env.DATABASE_URL).toMatch(/crm_dev/); // kept for the local-reuse check only
    expect(mod.validateAcceptance(env, 'all').errors).toEqual([]);
  });

  it('refuses a missing file or one holding anything but ACCEPTANCE_* variables', () => {
    expect(() => load('prod')).toThrow(/\.env\.supabase-prod does not exist/);
    writeFileSync(
      join(dir, '.env.supabase-prod'),
      dotenv({ ...targetVars(PROD_REF, 'prod'), DATABASE_URL: 'postgresql://x' }),
    );
    expect(() => load('prod')).toThrow(/only ACCEPTANCE_\* variables \(found DATABASE_URL\)/);
  });

  it('refuses QA and production pointing at the same Supabase project', () => {
    writeFileSync(join(dir, '.env.supabase-qa'), dotenv(targetVars(PROD_REF, 'qa')));
    writeFileSync(join(dir, '.env.supabase-prod'), dotenv(targetVars(PROD_REF, 'prod')));
    expect(() => load('prod')).toThrow(/same Supabase project/);
  });

  it('fails validation when production reuses a QA role password', () => {
    writeFileSync(join(dir, '.env.supabase-qa'), dotenv(targetVars(QA_REF, 'qa')));
    const prod = targetVars(PROD_REF, 'prod');
    const reused = targetVars(QA_REF, 'qa').ACCEPTANCE_CRM_APP_PASSWORD!;
    prod.ACCEPTANCE_CRM_APP_PASSWORD = reused;
    prod.ACCEPTANCE_DATABASE_URL = `postgresql://crm_app.${PROD_REF}:${reused}@${HOST}:5432/postgres`;
    writeFileSync(join(dir, '.env.supabase-prod'), dotenv(prod));
    const { errors } = mod.validateAcceptance(load('prod'), 'all');
    expect(errors.join('\n')).toMatch(/other target/);
    expect(errors.join('\n')).not.toContain(reused);
  });
});

describe('production confirmation', () => {
  function answer(lines: string[], tty = true) {
    const input = Object.assign(new PassThrough(), { isTTY: tty });
    const output = new PassThrough();
    let said = '';
    output.on('data', (d) => (said += String(d)));
    // Feed one answer per question, as a person would.
    let i = 0;
    output.on('data', (d) => {
      // Prompts end with a space; the header line ends with a newline.
      if (String(d).endsWith(' ')) {
        if (i < lines.length) input.write(`${lines[i++]}\n`);
      }
    });
    return { io: { input, output }, said: () => said };
  }

  it('passes only with "yes" and the first four characters of the ref', async () => {
    const ok = answer(['yes', PROD_REF.slice(0, 4)]);
    await expect(mod.confirmProduction(PROD_REF, 'apply', ok.io)).resolves.toBe(true);
    expect(ok.said()).not.toContain(PROD_REF); // masked
  });

  it('refuses without a backup, with a wrong ref or without a terminal', async () => {
    await expect(mod.confirmProduction(PROD_REF, 'apply', answer(['no']).io)).resolves.toBe(false);
    await expect(
      mod.confirmProduction(PROD_REF, 'apply', answer(['yes', 'qaqa']).io),
    ).resolves.toBe(false);
    await expect(mod.confirmProduction(PROD_REF, 'apply', answer([], false).io)).resolves.toBe(
      false,
    );
  });
});
