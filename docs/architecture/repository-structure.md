# Repository Structure and Code Conventions

> Status: Phase 0 proposal for Phase 1 scaffolding. Nothing below has been created yet. Folder names follow current Next.js 16 App Router conventions (`src/app`, route groups, `proxy.ts`).

## 1. Proposed layout

```
cbr-property-crm/
├─ docs/                          # this blueprint, ADRs, runbooks
├─ prisma/
│  ├─ schema.prisma               # data model (Prisma 7, prisma-client generator)
│  ├─ migrations/                 # SQL migrations incl. raw RLS/constraints
│  └─ README.md                   # what lives in raw SQL and why
├─ prisma.config.ts               # Prisma 7 config (schema path, migrations, datasource)
├─ src/
│  ├─ app/                        # Next.js App Router: routing + presentation only
│  │  ├─ (auth)/login, reset, invite/[token]
│  │  ├─ (app)/                   # authenticated tenant app, layout resolves org context
│  │  │  ├─ my-day/
│  │  │  ├─ leads/ , leads/[leadId]/
│  │  │  ├─ imports/ , tasks/ , calendar/ , leave/
│  │  │  ├─ properties/ , visits/ , deals/
│  │  │  ├─ dashboard/ , reports/
│  │  │  └─ settings/ (org, team, users, scripts, integrations, audit)
│  │  ├─ (platform)/platform/      # platform admin, separate auth gate
│  │  ├─ share/[token]/           # public property share pages
│  │  └─ api/
│  │     ├─ webhooks/[provider]/[token]/route.ts
│  │     ├─ v1/leads/route.ts     # inbound lead API (Phase 6)
│  │     ├─ files/[id]/download/route.ts
│  │     └─ health/route.ts
│  ├─ proxy.ts                    # coarse auth redirect, headers, request id
│  ├─ modules/                    # business modules (see module-boundaries.md)
│  │  └─ leads/
│  │     ├─ index.ts              # PUBLIC API of the module (only importable entry)
│  │     ├─ actions.ts            # 'use server' thin adapters (Zod parse → command)
│  │     ├─ application/          # commands & queries (authorise, transact, audit, outbox)
│  │     ├─ domain/               # pure logic & types (state machine, dedup rules)
│  │     ├─ infra/                # repositories (Prisma), mappers
│  │     ├─ jobs/                 # job handlers owned by this module
│  │     ├─ schemas.ts            # Zod input/output schemas (shared with forms)
│  │     ├─ ui/                   # module-specific components
│  │     └─ __tests__/
│  ├─ integrations/               # provider adapters: exotel/, smartflo/, meta-whatsapp/, email/, storage/
│  ├─ platform/                   # technical foundations (not business)
│  │  ├─ db/                      # prisma client, withTenant(), tx helpers
│  │  ├─ auth/                    # auth library setup, session → RequestContext
│  │  ├─ authz/                   # permission catalog, authorize(), scopeFor()
│  │  ├─ queue/                   # BullMQ queues, outbox relay, job registry
│  │  ├─ observability/           # logger (pino), Sentry, request id
│  │  ├─ rate-limit/
│  │  └─ crypto/                  # envelope encryption for integration secrets
│  ├─ components/ui/              # shadcn/ui primitives (generated, lightly customised)
│  ├─ components/                 # shared, business-agnostic composites (DataTable, EmptyState)
│  ├─ lib/                        # tiny generic helpers: money.ts, phone.ts, dates.ts (each tested)
│  ├─ env.ts                      # Zod-validated env (server) + allow-listed public env
│  └─ worker/
│     └─ main.ts                  # worker entrypoint: registers module job handlers + schedulers
├─ tests/
│  ├─ e2e/                        # Playwright
│  ├─ load/                       # k6
│  ├─ fixtures/                   # import corpus, seed builders
│  └─ isolation/                  # tenant isolation + permission matrix suites
├─ docker/ , docker-compose.yml   # local Postgres 18, Valkey, Mailpit (object storage: Phase 2)
├─ spikes/                        # Phase 1 gate spikes S1/S2 (throwaway; see spikes/README.md)
├─ infra/                         # Terraform (hosting), added when environments are created
└─ .github/workflows/             # CI
```

### Why this structure

- `src/app` only routes and renders, so business logic can be tested without Next.js.
- **Vertical modules** keep everything about "leads" together and make boundaries enforceable (`eslint-plugin-boundaries` or `no-restricted-imports` patterns: only `@/modules/<x>` index imports across modules).
- `platform/` holds technical cross-cutting code. `lib/` is deliberately tiny, so it doesn't become a dumping ground.
- Layers within a module exist only where they add value. A simple query may go `page → module query → repo`. We don't add pass-through "service" classes.

## 2. Code quality conventions

| Area | Convention |
|---|---|
| **TypeScript** | `strict: true`, `noUncheckedIndexedAccess`, `exactOptionalPropertyTypes`, `noImplicitOverride`. ESM (`"type": "module"`, Prisma 7 requirement). No `any` (lint error) except with `// eslint-disable-next-line` + reason |
| **Naming** | Files kebab-case; React components PascalCase; DB tables snake_case singular via Prisma `@@map`; Prisma models PascalCase; enums SCREAMING_SNAKE; permission codes `resource.action`; audit actions `entity.verb_past` (`lead.reassigned`); job names `module.verb` |
| **Validation** | Zod 4 at every trust boundary: Server Action input, Route Handler body/query, job payload, env, provider webhook payload (after signature check), JSONB settings. Schemas live in `schemas.ts` and are reused by forms (`@hookform/resolvers/zod` or similar) |
| **Errors** | Domain errors are typed (`NotFound`, `Forbidden`, `Conflict`, `ValidationFailed`, `RuleViolation`) and mapped once to UI/HTTP. Server Actions return `{ ok: true, data } | { ok: false, error: { code, message, fieldErrors? } }` and don't throw to the client. Unexpected errors are logged and reported, and the user sees a generic message with the request id |
| **Logging** | pino, structured, one logger with context (`requestId`, `orgId`, `userId`, `module`). Never log PII or secrets (redaction paths). Levels: error = needs action; warn = degraded; info = business events at low volume; debug off in prod |
| **Environment variables** | Single `src/env.ts` validated at boot; `server-only` guard; `NEXT_PUBLIC_` allow-list; `.env.example` documents every variable; `.env*` gitignored |
| **Database migrations** | Prisma Migrate. One migration per PR where possible. Raw SQL for RLS/constraints in the same migration. Expand/contract. Reviewed by a second engineer. Never edit an applied migration |
| **Testing** | See testing-strategy.md. New module = isolation + permission tests before merge |
| **Runtime & package manager** | **Node.js 24.x LTS** (enters Maintenance LTS 2026-10-20, supported to 2028-04-30; Prisma 7 supports `^24.0.0`; Node 26 not yet listed by Prisma 7, UNVERIFIED). Pin via `.nvmrc`/`engines`. **pnpm 12.x**, pinned as `packageManager: pnpm@12.12.1` (newest release meeting the 7-day `minimumReleaseAge`; 12.14.0 was 4 days old at scaffolding). Corepack is not bundled from Node 25, so install pnpm directly. Supply-chain settings in `pnpm-workspace.yaml`: `minimumReleaseAge`, `allowBuilds` (not the removed `onlyBuiltDependencies`) |
| **Dependencies** | pnpm lockfile committed. Justify each new runtime dependency in the PR. Prefer well-maintained packages. Renovate weekly. Pin exact versions for `next` (≥ 16.4.1 security floor; 16.4.2 current), `prisma` + `@prisma/client` (7.10.1; **`prisma@latest` resolves to an 8.0 RC**, so never install unpinned), `better-auth`, `bullmq`. **Phase 1 Step 1 pins:** TypeScript **6.0.3** (typescript-eslint supports < 6.1; the TypeScript 7 native compiler is deferred), ESLint **9.39.5** (the React/import/a11y plugins used by `eslint-config-next` do not support ESLint 10 yet). Release-age exceptions are listed with reasons in `pnpm-workspace.yaml` |
| **Formatting/linting** | Prettier + ESLint (Next.js config, typescript-eslint strict, boundaries, security rules). Pre-commit via lint-staged |
| **Code review** | Every PR reviewed by one person. Two for migrations, authz, auth, integrations or money. Checklist: authz in command? scope predicate? audit? idempotent? PII in logs? tests? |
| **Pull requests** | Small (< 400 lines changed excluding generated). Conventional Commits titles. Linked to a requirement id (FR-xxx). Description includes screenshots for UI and EXPLAIN for new queries |
| **Branching** | Trunk-based: short-lived feature branches → `main` (protected). Release tags. Feature flags for incomplete features (org-level flags table) |
| **Documentation** | Module README (purpose, public API, events). ADR for architectural changes. Update the requirement/KPI docs in the same PR as behaviour changes |
| **Secrets** | Never committed (gitleaks pre-commit + CI). Rotated on staff departure. Integration secrets encrypted at app level |
| **Accessibility** | shadcn/Radix primitives; label every input; keyboard paths; axe in E2E |
