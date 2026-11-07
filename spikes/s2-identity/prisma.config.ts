import 'dotenv/config';
import { defineConfig, env } from 'prisma/config';

// Migrations run as crm_migrator (schema owner). The app never uses this URL.
export default defineConfig({
  schema: 'prisma/schema.prisma',
  migrations: { path: 'prisma/migrations' },
  datasource: { url: env('S2_MIGRATOR_URL') },
});
