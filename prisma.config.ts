import 'dotenv/config';
import { defineConfig, env } from 'prisma/config';

// Migrations run as crm_migrator (schema owner) in a release step, never on app boot.
export default defineConfig({
  schema: 'prisma/schema.prisma',
  migrations: { path: 'prisma/migrations' },
  datasource: { url: env('DATABASE_MIGRATOR_URL') },
});
