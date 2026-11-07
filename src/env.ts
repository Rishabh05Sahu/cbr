import { z } from 'zod';

/**
 * Server environment, validated once on first use (repository-structure §2). Shared by the
 * Next.js server and the worker; never import from client components. The migrator URL is
 * used only by the release step (prisma.config.ts), never by the running app.
 */
// Also as `<user>.<project-ref>`, the form Supabase's shared pooler (Supavisor) requires.
const OWNER_OR_ADMIN_USER = /\/\/(postgres|doadmin|crm_migrator)(\.[a-z0-9]{20})?[:@]/;

/**
 * The database role a connection user name logs in as: the name itself, or `<role>` from
 * Supabase's pooler form `<role>.<project-ref>` (20 lower-case letters or digits). Anything
 * else is returned unchanged, so it can only match a role exactly.
 */
export function databaseRoleOf(username: string): string {
  const name = decodeURIComponent(username);
  return /^[a-z_][a-z0-9_]*\.[a-z0-9]{20}$/.test(name) ? name.split('.')[0]! : name;
}

const roleUrl = (expectedRole: string) =>
  z
    .url()
    .refine((u) => !OWNER_OR_ADMIN_USER.test(u), {
      message: 'must not use an owner or admin database user',
    })
    .refine((u) => databaseRoleOf(new URL(u).username) === expectedRole, {
      message: `must connect as ${expectedRole}`,
    });

/** `KEY=` in a .env file means "not set". */
const unsetIfBlank = <T extends z.ZodType>(schema: T) =>
  z.preprocess((v) => (v === '' ? undefined : v), schema.optional());

export const serverEnvSchema = z
  .object({
    NODE_ENV: z.enum(['development', 'test', 'production']).default('development'),
    DATABASE_URL: roleUrl('crm_app'),
    AUTH_DATABASE_URL: roleUrl('crm_auth'),
    PLATFORM_DATABASE_URL: roleUrl('crm_platform'),
    DATABASE_POOL_MAX: z.coerce.number().int().min(1).max(50).default(10),
    // Worker only: the import-file cleanup sweep (role crm_cleanup, M4). Optional: without it
    // the sweep does not run. Only the worker opens this connection.
    CLEANUP_DATABASE_URL: unsetIfBlank(roleUrl('crm_cleanup')),
    REDIS_URL: z.url(),
    SMTP_HOST: z.string().min(1),
    SMTP_PORT: z.coerce.number().int().positive(),
    SMTP_USER: z.string().optional(),
    SMTP_PASSWORD: z.string().optional(),
    EMAIL_FROM: z.string().min(3).default('CBR Property CRM <no-reply@cbr-crm.local>'),
    BETTER_AUTH_URL: z.url(),
    BETTER_AUTH_SECRET: z.string().min(32),
    LOG_LEVEL: z
      .enum(['fatal', 'error', 'warn', 'info', 'debug', 'trace', 'silent'])
      .default('info'),
    // Phase 2 M4 import storage (Supabase Storage, private bucket). Optional: without it the app
    // runs and the import screens say storage is not configured. The service-role key is a
    // server-only secret; it must never get a NEXT_PUBLIC_ prefix.
    SUPABASE_URL: unsetIfBlank(
      z
        .url()
        .refine((u) => /^https:\/\//.test(u) || /^http:\/\/(127\.0\.0\.1|localhost)[:/]/.test(u), {
          message: 'must use https (plain http only for a local stack)',
        }),
    ),
    SUPABASE_SERVICE_ROLE_KEY: unsetIfBlank(
      z
        .string()
        .min(20)
        .refine((k) => !k.startsWith('sb_publishable_'), {
          message: 'must be the secret (service-role) key, not the publishable key',
        }),
    ),
    SUPABASE_IMPORT_BUCKET: z
      .string()
      .regex(/^[a-z0-9][a-z0-9_-]{2,62}$/, 'lower-case letters, digits, "-" and "_"')
      .default('crm-imports'),
    /** Application upload limit; Supabase Free caps objects at 50 MB. */
    IMPORT_MAX_BYTES: z.coerce
      .number()
      .int()
      .min(1024)
      .max(50 * 1024 * 1024)
      .default(20 * 1024 * 1024),
    /**
     * Worker only: how an import batch is committed (M6). 'set' (default since 2026-10-26: the
     * set-based commit, docs/PHASE-2-M6-SET-BASED-IMPORT.md) or 'row' (the previous one-row-at-a-
     * time commit, kept as the ROLLBACK: set IMPORT_COMMIT_STRATEGY=row and restart the worker).
     * Both give the same outcomes; any other value refuses to start.
     */
    IMPORT_COMMIT_STRATEGY: unsetIfBlank(z.enum(['row', 'set'])).transform((v) => v ?? 'set'),
  })
  .refine((e) => !e.SUPABASE_URL === !e.SUPABASE_SERVICE_ROLE_KEY, {
    message: 'SUPABASE_URL and SUPABASE_SERVICE_ROLE_KEY must be set together',
    path: ['SUPABASE_SERVICE_ROLE_KEY'],
  });

export type ServerEnv = z.infer<typeof serverEnvSchema>;

let cached: ServerEnv | undefined;

export function serverEnv(): ServerEnv {
  cached ??= serverEnvSchema.parse(process.env);
  return cached;
}
