# Local browser testing of imports (fake storage, never the real bucket)

For trying import templates, import notifications and upload failures in a real browser on a
developer machine. The app talks to the **e2e fake Supabase Storage** (`tests/e2e/fake-storage.ts`)
on `127.0.0.1:3199`, never to the bucket configured in `.env`. Synthetic data only. `.env` is not
edited: every setting below is applied to one process by the launcher
`scripts/dev/import-browser-test.mts`.

## What the launcher sets (process environment only)

| Variable | Value | Why |
|---|---|---|
| `SUPABASE_URL` | `http://127.0.0.1:3199` | The fake. `src/env.ts` already accepts plain http for loopback only |
| `SUPABASE_SERVICE_ROLE_KEY` | the fake key `E2E_STORAGE_KEY` in `tests/e2e/fake-storage.ts` (not a secret; only the fake accepts it) | The real key from `.env` is never passed |
| `SUPABASE_IMPORT_BUCKET` | `crm-imports` | The fake's only bucket |
| `BETTER_AUTH_URL` | `http://localhost:3100` | Sign-in from the 3100 origin |
| `CLEANUP_DATABASE_URL` | `''` (blank) | Turns the file cleanup sweep **off** (see below) |

Everything else (local `crm_dev`, Valkey, Mailpit) comes from `.env`. The launcher refuses to
start if any database or Redis URL is not loopback, or if the storage URL, key or bucket is not
the fake's.

**Precedence, verified:** values already in the process environment win over `.env`:
- in the web app, `@next/env` only fills keys that are entirely absent, so a blank value also counts;
- the worker gets an explicit merged environment (`.env`, then the shell, then the overrides).

**Cleanup guard, verified in code:**
1. `src/env.ts`: `CLEANUP_DATABASE_URL: unsetIfBlank(...)`, so blank becomes unset.
2. `cleanupPrisma()` (`src/platform/db/client.ts`) returns `null`.
3. `isCleanupConfigured()` is `false`, so `cleanupLoop()` in `src/worker/main.ts` logs "file cleanup disabled" and returns before any sweep.

The only other code that deletes objects is the export processor (`src/modules/exports/processor.ts`, its own partial export file). Every path uses `importStorage()`/`exportStorage()`, which are built from the overridden `SUPABASE_URL` and key, i.e. the fake.

## Steps

1. **Port 3100 must be free.** A server started from `.env` uses the **real** bucket: stop it first (`web` refuses while 3100 is busy).
2. **Check** (starts nothing): `npx tsx scripts/dev/import-browser-test.mts check`. Every line must say `ok`.
3. **Fake storage** (terminal 1): `npx tsx scripts/dev/import-browser-test.mts storage`. It listens on 127.0.0.1 only and accepts browser uploads (CORS) from exactly `http://localhost:3100`. Files live in memory.
4. **Web app** (terminal 2): `npx tsx scripts/dev/import-browser-test.mts web`. Then confirm the served CSP names the fake and not Supabase:
   `curl -sI http://localhost:3100/login | grep -i content-security-policy` → `connect-src 'self' http://127.0.0.1:3199`.
5. **Worker** (terminal 3, needed for import processing and notifications): `npx tsx scripts/dev/import-browser-test.mts worker`.
   - It prints the checks again; `cleanup sweep disabled` must be `ok`.
   - Its log must then show `file cleanup disabled (CLEANUP_DATABASE_URL or storage not configured)`.
   - The outbox relay also delivers events already queued in `crm_dev` (for example earlier `lead.assigned` events, which give their owner synthetic in-app notifications). They are not modified or discarded.
6. **Sign in** at `http://localhost:3100` with a synthetic `crm_dev` account.

## Stopping

Ctrl+C in each terminal: worker, then web, then storage. Stopping the fake discards every stored file. Import jobs created in `crm_dev` keep pointing at keys that no longer exist, which is harmless:
- with the sweep off, nothing deletes anything;
- a later sweep against any storage treats missing objects as already gone.

## Not covered

- Real Supabase behaviour (its limits, headers, CORS and errors): the fake mirrors only the calls the app makes.
- The four older `crm_dev` imports whose files may still be in the real bucket are out of scope here and are left untouched.
