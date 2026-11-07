# Phase 1 gate spikes

Throwaway proofs of concept for the Phase 1 gate. They are **not production schema**. They run against separate local databases (`crm_s1`, `crm_s2`) and use synthetic data only.

- `s1-tenant-isolation/`: PostgreSQL RLS + `withTenant()` (criteria S1-01…S1-18). Report: [docs/architecture/spikes/S1-report.md](../docs/architecture/spikes/S1-report.md)
- `s2-identity/`: Better Auth 1.7.11 + organization plugin (criteria S2-01…S2-08). Report: [docs/architecture/spikes/S2-report.md](../docs/architecture/spikes/S2-report.md)

Code that graduates to production lives in `src/` (for example `src/platform/db/with-tenant.ts` and `src/lib/uuidv7.ts`). Spike code does not.

## Run

```bash
cp .env.example .env          # local-only placeholder passwords; set BETTER_AUTH_SECRET
pnpm install
pnpm db:up                     # postgres 18.6, valkey 9.0.6, mailpit (ports 55432 / 56379 / 51025, UI 54025)
pnpm spike:s1:migrate && pnpm spike:s1:generate
pnpm spike:s2:migrate && pnpm spike:s2:generate
pnpm spike:s1:test             # ~2.5 min (50,000-transaction concurrency test, 250k-lead seed on first run)
pnpm spike:s2:test             # ~15 s
```

The roles are created by `docker/postgres/init/01-roles.sh` on the **first** start of the Postgres volume. After changing that script, recreate the volume with `docker compose down -v`; this deletes local data.
