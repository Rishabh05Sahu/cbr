import { describe, expect, it } from 'vitest';
import { databaseRoleOf, serverEnvSchema } from './env';

const valid = {
  DATABASE_URL: 'postgresql://crm_app:pw@127.0.0.1:55432/crm_dev',
  AUTH_DATABASE_URL: 'postgresql://crm_auth:pw@127.0.0.1:55432/crm_dev',
  PLATFORM_DATABASE_URL: 'postgresql://crm_platform:pw@127.0.0.1:55432/crm_dev',
  REDIS_URL: 'redis://127.0.0.1:56379',
  SMTP_HOST: '127.0.0.1',
  SMTP_PORT: '51025',
  BETTER_AUTH_URL: 'http://localhost:3000',
  BETTER_AUTH_SECRET: 'x'.repeat(44),
};

describe('serverEnvSchema', () => {
  it('accepts a complete environment', () => {
    expect(serverEnvSchema.parse(valid).SMTP_PORT).toBe(51025);
  });

  it.each(['postgres', 'doadmin', 'crm_migrator'])('rejects DATABASE_URL using %s', (user) => {
    const r = serverEnvSchema.safeParse({
      ...valid,
      DATABASE_URL: `postgresql://${user}:pw@host/db`,
    });
    expect(r.success).toBe(false);
  });

  it('rejects swapped role URLs (auth library must not get crm_app, app must not get crm_auth)', () => {
    expect(
      serverEnvSchema.safeParse({ ...valid, DATABASE_URL: valid.AUTH_DATABASE_URL }).success,
    ).toBe(false);
    expect(
      serverEnvSchema.safeParse({ ...valid, AUTH_DATABASE_URL: valid.DATABASE_URL }).success,
    ).toBe(false);
  });

  it('CLEANUP_DATABASE_URL is optional and must connect as crm_cleanup', () => {
    expect(serverEnvSchema.parse(valid).CLEANUP_DATABASE_URL).toBeUndefined();
    expect(serverEnvSchema.parse({ ...valid, CLEANUP_DATABASE_URL: '' }).CLEANUP_DATABASE_URL).toBe(
      undefined,
    );
    const ok = 'postgresql://crm_cleanup:pw@127.0.0.1:55432/crm_dev';
    expect(serverEnvSchema.parse({ ...valid, CLEANUP_DATABASE_URL: ok }).CLEANUP_DATABASE_URL).toBe(
      ok,
    );
    for (const user of ['crm_app', 'crm_definer', 'crm_migrator', 'postgres'])
      expect(
        serverEnvSchema.safeParse({
          ...valid,
          CLEANUP_DATABASE_URL: `postgresql://${user}:pw@127.0.0.1:55432/crm_dev`,
        }).success,
        user,
      ).toBe(false);
  });

  it('rejects a short auth secret', () => {
    expect(serverEnvSchema.safeParse({ ...valid, BETTER_AUTH_SECRET: 'short' }).success).toBe(
      false,
    );
  });

  it('Supabase storage is optional, but URL and key must be set together', () => {
    const base = serverEnvSchema.parse(valid);
    expect(base.SUPABASE_URL).toBeUndefined();
    const blank = serverEnvSchema.parse({
      ...valid,
      SUPABASE_URL: '',
      SUPABASE_SERVICE_ROLE_KEY: '',
    });
    expect(blank.SUPABASE_URL).toBeUndefined();
    expect(base.SUPABASE_IMPORT_BUCKET).toBe('crm-imports');
    expect(base.IMPORT_MAX_BYTES).toBe(20 * 1024 * 1024);
    const url = 'https://example-project.supabase.co';
    const key = 'sb_secret_' + 'x'.repeat(30);
    expect(serverEnvSchema.safeParse({ ...valid, SUPABASE_URL: url }).success).toBe(false);
    expect(serverEnvSchema.safeParse({ ...valid, SUPABASE_SERVICE_ROLE_KEY: key }).success).toBe(
      false,
    );
    expect(
      serverEnvSchema.safeParse({ ...valid, SUPABASE_URL: url, SUPABASE_SERVICE_ROLE_KEY: key })
        .success,
    ).toBe(true);
  });

  it('rejects plain-http remote storage, the publishable key, bad buckets and > 50 MB limits', () => {
    const ok = {
      ...valid,
      SUPABASE_URL: 'https://example-project.supabase.co',
      SUPABASE_SERVICE_ROLE_KEY: 'sb_secret_' + 'x'.repeat(30),
    };
    for (const bad of [
      { SUPABASE_URL: 'http://example-project.supabase.co' },
      { SUPABASE_SERVICE_ROLE_KEY: 'sb_publishable_' + 'x'.repeat(30) },
      { SUPABASE_IMPORT_BUCKET: 'Public Bucket' },
      { IMPORT_MAX_BYTES: String(51 * 1024 * 1024) },
    ])
      expect(serverEnvSchema.safeParse({ ...ok, ...bad }).success, JSON.stringify(bad)).toBe(false);
    expect(
      serverEnvSchema.safeParse({ ...ok, SUPABASE_URL: 'http://127.0.0.1:54321' }).success,
    ).toBe(true);
  });
});

describe('IMPORT_COMMIT_STRATEGY (M6 import commit switch)', () => {
  it("defaults to the set-based commit ('set'), also when blank", () => {
    expect(serverEnvSchema.parse(valid).IMPORT_COMMIT_STRATEGY).toBe('set');
    expect(
      serverEnvSchema.parse({ ...valid, IMPORT_COMMIT_STRATEGY: '' }).IMPORT_COMMIT_STRATEGY,
    ).toBe('set');
  });

  it("selects the row-by-row rollback only when explicitly 'row'; 'set' is accepted too", () => {
    expect(
      serverEnvSchema.parse({ ...valid, IMPORT_COMMIT_STRATEGY: 'row' }).IMPORT_COMMIT_STRATEGY,
    ).toBe('row');
    expect(
      serverEnvSchema.parse({ ...valid, IMPORT_COMMIT_STRATEGY: 'set' }).IMPORT_COMMIT_STRATEGY,
    ).toBe('set');
  });

  it.each(['SET', 'sets', 'batch', 'true', '1', ' set'])(
    'refuses %j (the worker does not start)',
    (v) => {
      expect(serverEnvSchema.safeParse({ ...valid, IMPORT_COMMIT_STRATEGY: v }).success).toBe(
        false,
      );
    },
  );
});

describe('Supabase shared-pooler user names (<role>.<project-ref>)', () => {
  const REF = 'abcdefghij0123456789';
  const pooled = (role: string, u: string) =>
    u
      .replace(`//${role}:`, `//${role}.${REF}:`)
      .replace('127.0.0.1:55432', 'aws-0-ap-south-1.pooler.supabase.com:5432');

  it('maps the pooler form to the role, and nothing else', () => {
    expect(databaseRoleOf(`crm_app.${REF}`)).toBe('crm_app');
    expect(databaseRoleOf('crm_app')).toBe('crm_app');
    // Not a project ref (length, characters): left unchanged, so it cannot match a role.
    for (const odd of [
      `crm_app.${REF}x`,
      'crm_app.short',
      `crm_app.${REF.toUpperCase()}`,
      `crm_app.${REF}.x`,
    ])
      expect(databaseRoleOf(odd)).toBe(odd);
  });

  it('accepts each runtime role through the pooler as itself', () => {
    const env = serverEnvSchema.parse({
      ...valid,
      DATABASE_URL: pooled('crm_app', valid.DATABASE_URL),
      AUTH_DATABASE_URL: pooled('crm_auth', valid.AUTH_DATABASE_URL),
      PLATFORM_DATABASE_URL: pooled('crm_platform', valid.PLATFORM_DATABASE_URL),
    });
    expect(new URL(env.DATABASE_URL).username).toBe(`crm_app.${REF}`);
  });

  it('still refuses the wrong role, or an admin, in the pooler form', () => {
    expect(
      serverEnvSchema.safeParse({
        ...valid,
        DATABASE_URL: pooled('crm_auth', valid.AUTH_DATABASE_URL),
      }).success,
    ).toBe(false);
    for (const admin of ['postgres', 'crm_migrator'])
      expect(
        serverEnvSchema.safeParse({
          ...valid,
          DATABASE_URL: `postgresql://${admin}.${REF}:pw@aws-0-ap-south-1.pooler.supabase.com:5432/postgres`,
        }).success,
      ).toBe(false);
  });
});

describe('DATABASE_CA_CERT (CA as text, for hosts without a CA file)', () => {
  const body = 'A'.repeat(64) + 'B'.repeat(10) + '==';
  const want = `-----BEGIN CERTIFICATE-----\n${'A'.repeat(64)}\n${'B'.repeat(10)}==\n-----END CERTIFICATE-----`;
  const BS = String.fromCharCode(92);

  it.each([
    ['real line breaks', `-----BEGIN CERTIFICATE-----\n${body}\n-----END CERTIFICATE-----`],
    ['CRLF line breaks', `-----BEGIN CERTIFICATE-----\r\n${body}\r\n-----END CERTIFICATE-----\r\n`],
    [
      'literal \n on one line',
      `-----BEGIN CERTIFICATE-----${BS}n${body}${BS}n-----END CERTIFICATE-----`,
    ],
    [
      'spaces instead of line breaks',
      `-----BEGIN CERTIFICATE----- ${body.slice(0, 40)} ${body.slice(40)} -----END CERTIFICATE-----`,
    ],
    ['surrounding quotes', `"-----BEGIN CERTIFICATE-----\n${body}\n-----END CERTIFICATE-----"`],
  ])('rebuilds the PEM from %s', (_name, raw) => {
    expect(serverEnvSchema.parse({ ...valid, DATABASE_CA_CERT: raw }).DATABASE_CA_CERT).toBe(want);
  });

  it('treats a blank value as unset', () => {
    expect(
      serverEnvSchema.parse({ ...valid, DATABASE_CA_CERT: '' }).DATABASE_CA_CERT,
    ).toBeUndefined();
  });

  it.each([
    ['not a cert'],
    ['-----BEGIN CERTIFICATE-----'],
    ['-----BEGIN CERTIFICATE-----\nnot*base64!\n-----END CERTIFICATE-----'],
  ])('rejects %j', (raw) => {
    expect(serverEnvSchema.safeParse({ ...valid, DATABASE_CA_CERT: raw }).success).toBe(false);
  });

  it('rejects ssl* URL parameters, which would override the CA', () => {
    const r = serverEnvSchema.safeParse({
      ...valid,
      DATABASE_CA_CERT: `-----BEGIN CERTIFICATE-----\n${body}\n-----END CERTIFICATE-----`,
      AUTH_DATABASE_URL: `${valid.AUTH_DATABASE_URL}?sslmode=no-verify`,
    });
    expect(r.success).toBe(false);
  });
  it('accepts the name supabase-root-2021 for the bundled Supabase root CA', () => {
    const ca = serverEnvSchema.parse({
      ...valid,
      DATABASE_CA_CERT: ' supabase-root-2021 ',
    }).DATABASE_CA_CERT;
    expect(ca).toMatch(/^-----BEGIN CERTIFICATE-----\nMIIDxDCCAqygAwIBAgIUbLxMod62P2ktCiAkxnKJ/);
    expect(ca).toMatch(/-----END CERTIFICATE-----$/);
  });
});
