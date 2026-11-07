// Prisma config used ONLY by scripts/db/migrate-supabase.mjs to record applied migrations
// (`prisma migrate resolve --applied`). Deliberately does not load .env: its only connection is
// CRM_SUPABASE_MIGRATOR_URL, a name no .env file defines, which the wrapper builds from
// ACCEPTANCE_DATABASE_MIGRATOR_URL with strict TLS and passes in the child's environment only.
// Without it, Prisma has no URL and stops; it can never fall back to the local DATABASE_MIGRATOR_URL.
// CRM_SUPABASE_MIGRATIONS_DIR exists for the offline tests' synthetic migrations only.
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';

const repo = join(dirname(fileURLToPath(import.meta.url)), '..', '..');
const url = process.env.CRM_SUPABASE_MIGRATOR_URL;
if (!url || !/[?&]sslaccept=strict(&|$)/.test(url) || !/[?&]sslcert=/.test(url))
  throw new Error('CRM_SUPABASE_MIGRATOR_URL is missing or not strict TLS; refusing to connect');

const config = {
  schema: join(repo, 'prisma', 'schema.prisma'),
  migrations: {
    path: process.env.CRM_SUPABASE_MIGRATIONS_DIR || join(repo, 'prisma', 'migrations'),
  },
  datasource: { url },
};
export default config;
