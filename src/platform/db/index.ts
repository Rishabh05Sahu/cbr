// Public API of the db gateway for modules: the tenant runner and transaction types only.
// Raw clients (src/platform/db/client.ts) are importable only from src/platform/** (lint).
import type { Prisma } from '@/generated/prisma/client';

export { tenantRunner } from './client';
export { TenantContextError, type TenantContext } from './with-tenant';
export type { Prisma };

/** Transaction client handed to module code inside withTenant(). */
export type Tx = Prisma.TransactionClient;
