// S1-09 outside-wrapper access blocked: lint rejects raw-client imports outside the db
// gateway; a raw-client query at runtime sees 0 tenant rows.
import { ESLint } from 'eslint';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { createAppClient, createMigratorClient } from '../db/clients';
import { seedOrg } from './fixtures';

const eslint = new ESLint({ cwd: process.cwd() });

async function restrictedImportErrors(code: string, filePath: string) {
  const [result] = await eslint.lintText(code, { filePath });
  return result!.messages.filter((m) => m.ruleId === 'no-restricted-imports');
}

const RAW_IMPORTS = [
  "import { PrismaClient } from '@prisma/client';",
  "import { PrismaClient } from '../../generated/prisma/client';",
  "import { PrismaPg } from '@prisma/adapter-pg';",
  "import pg from 'pg';",
];

describe('S1-09 lint rule', () => {
  it.each(RAW_IMPORTS)('rejects `%s` in a business module', async (code) => {
    const errors = await restrictedImportErrors(
      `${code}\nexport {};\n`,
      'src/modules/leads/infra/lead-repo.ts',
    );
    expect(errors).toHaveLength(1);
  });

  it.each(RAW_IMPORTS)('rejects `%s` in app routes', async (code) => {
    const errors = await restrictedImportErrors(
      `${code}\nexport {};\n`,
      'src/app/api/leads/route.ts',
    );
    expect(errors).toHaveLength(1);
  });

  it.each(RAW_IMPORTS)('allows `%s` inside src/platform/db', async (code) => {
    const errors = await restrictedImportErrors(
      `${code}\nexport {};\n`,
      'src/platform/db/client.ts',
    );
    expect(errors).toHaveLength(0);
  });

  it('rejects importing the auth library outside src/platform/auth', async () => {
    const code = `import { betterAuth } from 'better-auth';\nexport { betterAuth };\n`;
    expect(await restrictedImportErrors(code, 'src/modules/leads/application/x.ts')).toHaveLength(
      1,
    );
    expect(await restrictedImportErrors(code, 'src/platform/db/client.ts')).toHaveLength(1);
    expect(await restrictedImportErrors(code, 'src/platform/auth/auth.ts')).toHaveLength(0);
  });

  it('rejects raw database clients inside src/platform/auth too', async () => {
    const code = `import pg from 'pg';\nexport { pg };\n`;
    expect(await restrictedImportErrors(code, 'src/platform/auth/auth.ts')).toHaveLength(1);
  });

  it('allows the gateway API (withTenant) everywhere', async () => {
    const errors = await restrictedImportErrors(
      "import { createTenantRunner } from '@/platform/db/with-tenant';\nexport { createTenantRunner };\n",
      'src/modules/leads/application/list.ts',
    );
    expect(errors).toHaveLength(0);
  });
});

describe('S1-09 raw client at runtime', () => {
  const migrator = createMigratorClient(1);
  const app = createAppClient(1);
  beforeAll(() => seedOrg(migrator, 'Foxtrot'));
  afterAll(async () => {
    await app.close();
    await migrator.close();
  });

  it('a query on the raw crm_app client (no wrapper) returns 0 tenant rows', async () => {
    expect(await app.prisma.lead.findMany()).toEqual([]);
    expect(await app.prisma.organizationMembership.findMany()).toEqual([]);
    expect(await app.prisma.$queryRaw`SELECT * FROM task`).toEqual([]);
  });
});
