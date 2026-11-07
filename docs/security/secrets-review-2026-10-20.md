# Secrets Review and Git/Docker Closeout (2026-10-20)

> **Scope (owner instruction F):** classify all 21 gitleaks findings, including those in Git-ignored files, and verify that secrets stay out of Git, Docker images, logs and release artefacts.
> **Tool:** gitleaks v8.30.1 (`ghcr.io/gitleaks/gitleaks:v8.30.1`).
> **Runs:**
> - `dir` mode over the whole working tree, ignored files included;
> - a separate `dir` scan of exactly the 212 files Git would commit.
>
> All values were redacted in reports. This document never reproduces a secret.

## 1. Classification of the 21 findings

**Classes:**
- **G:** genuine issue requiring remediation;
- **FP:** false positive, with evidence;
- **DEV:** development-only artefact, safe to exclude;
- **U:** unresolved, needs investigation.

| # | File (all Git-ignored) | Rule | Class | Evidence and handling |
|---|---|---|---|---|
| 1 | `.env` line 27 (`BETTER_AUTH_SECRET`) | generic-api-key | **DEV** | **What it is:** a real random secret, but it is the **local** development key. It signs sessions for local and test databases that hold synthetic data only.<br>**Evidence:** excluded by `.gitignore` (`.env`) and `.dockerignore` (`.env`, `.env.*`). Its value appears in **none** of the 212 committable files and in **no** Docker image (searched in the web, worker and migrate images, §3).<br>**Handling:** never reuse it. Staging and production generate their own 32-byte secrets in the platform secret store (staging runbook §4.1) |
| 2 | `.next/standalone/.env` line 27 | generic-api-key | **DEV** (with hardening) | **What it is:** a copy of #1. `next build` with `output: 'standalone'` **copies `.env` files into the standalone folder**, so a locally built standalone bundle contains local secrets.<br>**Evidence:** the Docker build runs in a context without `.env` (`.dockerignore`); the web image has no `.env*` file (§3).<br>**Hardening added:** the Dockerfile build stage now **fails** if any `.env*` appears in `.next/standalone`.<br>**Rule:** never deploy a locally built `.next/standalone` folder (e.g. by zip upload). Deploy only CI-built images |
| 3 | `.next/cache/.previewinfo` (`previewModeSigningKey`) | generic-api-key | **DEV** | **What it is:** a random key Next.js generates per build for Draft/Preview Mode. The app does not use Draft Mode. It is cache under `.next/` (ignored, never copied into the image). |
| 4 | `.next/cache/.previewinfo` (`previewModeEncryptionKey`) | generic-api-key | **DEV** | Same as #3 |
| 5 | `.next/cache/.rscinfo` (`encryption.key`) | generic-api-key | **DEV** | **What it is:** Next.js's cached Server Actions encryption key for local builds (protects closure-bound action arguments). Local build cache only |
| 6 | `.next/prerender-manifest.json` (`previewModeSigningKey`) | generic-api-key | **DEV** | Per-build preview key (as #3) in local build output |
| 7 | `.next/prerender-manifest.json` (`previewModeEncryptionKey`) | generic-api-key | **DEV** | As #6 |
| 8 | `.next/server/preview-props.json` (`previewModeSigningKey`) | generic-api-key | **DEV** | As #6 |
| 9 | `.next/server/preview-props.json` (`previewModeEncryptionKey`) | generic-api-key | **DEV** | As #6 |
| 10 | `.next/server/server-reference-manifest.json` (`encryptionKey`) | generic-api-key | **DEV** | Local build's Server Actions key (as #5). **Production note:** every Next.js build embeds its Server Actions key in its output, so **container images are confidential**. Use a private registry (DOCR) and do not publish images. Set `NEXT_SERVER_ACTIONS_ENCRYPTION_KEY` from the secret store at CI build time so all web instances share one key (runbook §4.1) |
| 11 | `.next/standalone/.next/prerender-manifest.json` (signing key) | generic-api-key | **DEV** | Standalone copy of #6 |
| 12 | `.next/standalone/.next/prerender-manifest.json` (encryption key) | generic-api-key | **DEV** | Standalone copy of #7 |
| 13 | `.next/standalone/.next/server/preview-props.json` (signing key) | generic-api-key | **DEV** | Standalone copy of #8 |
| 14 | `.next/standalone/.next/server/preview-props.json` (encryption key) | generic-api-key | **DEV** | Standalone copy of #9 |
| 15 | `.next/standalone/.next/server/server-reference-manifest.json` | generic-api-key | **DEV** | Standalone copy of #10 |
| 16 | `.next/server/chunks/ssr/_1zh07yrcpcpqz._.js:453` | private-key | **FP** | Bundled code of the `jose` library's `importPKCS8()`: the string literal `-----BEGIN PRIVATE KEY-----` used as a **format check**, and a regex that strips PEM headers. There is no key body (base64) after the marker. Verified by reading the match context |
| 17 | `.next/server/chunks/ssr/_1kjrpxq_1li-n._.js:453` | private-key | **FP** | Same library code in another route chunk |
| 18 | `.next/server/chunks/ssr/_183n3if0zm6_v._.js:453` | private-key | **FP** | Same |
| 19 | `.next/standalone/.next/server/chunks/ssr/_1kjrpxq_1li-n._.js:453` | private-key | **FP** | Standalone copy of #17 |
| 20 | `.next/standalone/.next/server/chunks/ssr/_1zh07yrcpcpqz._.js:453` | private-key | **FP** | Standalone copy of #16 |
| 21 | `.next/standalone/.next/server/chunks/ssr/_183n3if0zm6_v._.js:453` | private-key | **FP** | Standalone copy of #18 |

**Result:**
- **0 genuine issues** and **0 unresolved**;
- **6 false positives** (one library string, in 3 chunks × 2 copies);
- **15 development-only artefacts** (the local `.env`, its standalone copy, and Next.js per-build keys).

**Hardening applied:**
- a Dockerfile guard against `.env` in standalone output;
- `.gitignore` and `.dockerignore` now also exclude key/cert files (`*.pem`, `*.key`, `*.crt`, `*.p12`, `*.pfx`, `secrets/`);
- `.dockerignore` also excludes recovery results, `docker-compose.yml` and editor folders.

## 2. Repository checks

| Check | Result |
|---|---|
| `.gitignore` excludes secrets, env files and build output | `.env`, `.env.*` (except `.env.example`), key/cert files, `secrets/`, `.next/`, `dist/`, `out/`, `build/`, generated Prisma clients, `node_modules/`, coverage, `*.log` (except synthetic test-evidence logs), managed-run rehearsal output. **PASS** |
| No required source file is ignored | `git status --ignored` lists only: `.env`, `.next/`, `dist/`, `next-env.d.ts`, `node_modules/`, `src/generated/`, the two spike `generated/` folders, `tsconfig.tsbuildinfo`, and local rehearsal logs. All are generated or local. The generated clients are rebuilt by `postinstall` (`prisma generate`). **PASS** |
| `.env.example` has placeholders only | Database passwords are the documented **local-only** placeholders (`local-app-pw` …), used by the local Docker Compose stack, and the file says "never reuse". `BETTER_AUTH_SECRET=replace-with-32-plus-random-bytes`. No real credential. **PASS** |
| Committable files contain no secrets | gitleaks on exactly the 212 files Git would commit: **no leaks**. Also checked:<br>- the local `BETTER_AUTH_SECRET` value: 0 hits;<br>- AWS key ids, DigitalOcean tokens, PEM private keys: 0 hits;<br>- reset/invite URLs and session cookies: 1 hit, a **test fixture** (`logger.test.ts` asserts that `?token=SECRET` is redacted). **PASS** |
| Logs and evidence files | Committed logs (`spikes/results/*.log`) and recovery JSON contain synthetic data only. The Phase 1 full-run log has 0 reset tokens or invitation URLs (D3 check). The managed-run script writes logs with all generated passwords and the admin password replaced by `***`. **PASS** |

## 3. Docker images

Images `web`, `worker` and `migrate` were built from the current tree (2026-10-20) and inspected:

| Check | web | worker | migrate |
|---|---|---|---|
| `.env` / `.env.*` anywhere in the image | none | none | none |
| Local `BETTER_AUTH_SECRET` value under `/app` | 0 | 0 | 0 |
| Local DB placeholder passwords (outside `node_modules`) | 0 | 0 | 0 |
| `.git`, `tests`, `spikes`, `docs`, `coverage`, `.github`, `scripts` | absent | absent | absent |
| `*.pem`, `*.key`, `*.p12` outside `node_modules` | none | none | none |
| Contents of `/app` | `.next`, `node_modules`, `package.json`, `server.js` | `dist`, `node_modules`, `package.json` | `node_modules`, `package.json`, lockfile, workspace file, `prisma/`, `prisma.config.ts`, `src/` (generated client only) |
| Runtime user | uid 1000 (`node`) | uid 1000 | uid 1000 |

**Residual, by design:** the web image contains its build's Next.js Server Actions and preview keys (#10). Treat images as confidential (private registry).

## 4. Not pushed

No remote is configured. Nothing is pushed until a remote is configured and its destination is reviewed (owner instruction F).
