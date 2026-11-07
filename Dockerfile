# CBR Property CRM — one image, three targets (ADR-0001/0005/0007):
#   web      Next.js standalone server       docker build --target web .
#   worker   outbox relay + BullMQ workers   docker build --target worker .
#   migrate  release step (crm_migrator)     docker build --target migrate .
# Runtime images run as the unprivileged `node` user and contain no dev dependencies.

ARG NODE_IMAGE=node:24.20.0-bookworm-slim

FROM ${NODE_IMAGE} AS base
ENV NEXT_TELEMETRY_DISABLED=1 \
    PNPM_HOME=/pnpm \
    PATH=/pnpm:$PATH
RUN npm install -g pnpm@12.12.1 && npm cache clean --force
WORKDIR /app

# ---- dependencies (all, for building) ----
FROM base AS deps
COPY package.json pnpm-lock.yaml pnpm-workspace.yaml prisma.config.ts ./
COPY prisma ./prisma
# prisma.config.ts reads this at generate time only; no database is contacted.
ENV DATABASE_MIGRATOR_URL=postgresql://build:build@localhost:5432/build
RUN pnpm install --frozen-lockfile

# ---- build ----
FROM deps AS build
COPY . .
RUN pnpm build && pnpm build:worker
# Next.js copies .env files into the standalone output. .dockerignore keeps them out of the
# build context; fail the build if one ever appears (secrets review 2026-10-20).
RUN if find .next/standalone -maxdepth 2 -name '.env*' | grep -q .; then echo 'env file in standalone output' >&2; exit 1; fi

# ---- production dependencies only (worker externals) ----
FROM base AS proddeps
COPY package.json pnpm-lock.yaml pnpm-workspace.yaml prisma.config.ts ./
COPY prisma ./prisma
ENV DATABASE_MIGRATOR_URL=postgresql://build:build@localhost:5432/build
RUN pnpm install --frozen-lockfile --prod --ignore-scripts
COPY --from=build /app/src/generated ./src/generated

# ---- web ----
FROM ${NODE_IMAGE} AS web
ENV NODE_ENV=production NEXT_TELEMETRY_DISABLED=1 PORT=3000 HOSTNAME=0.0.0.0
WORKDIR /app
COPY --from=build --chown=node:node /app/.next/standalone ./
COPY --from=build --chown=node:node /app/.next/static ./.next/static
USER node
EXPOSE 3000
HEALTHCHECK --interval=30s --timeout=5s --retries=3 CMD node -e "fetch('http://127.0.0.1:'+process.env.PORT+'/api/health').then(r=>process.exit(r.ok?0:1)).catch(()=>process.exit(1))"
CMD ["node", "server.js"]

# ---- worker ----
FROM ${NODE_IMAGE} AS worker
ENV NODE_ENV=production SERVICE_NAME=worker
WORKDIR /app
COPY --from=proddeps --chown=node:node /app/node_modules ./node_modules
COPY --from=proddeps --chown=node:node /app/package.json ./package.json
COPY --from=build --chown=node:node /app/dist ./dist
USER node
CMD ["node", "--enable-source-maps", "dist/worker.mjs"]

# ---- migrate (release step; runs as crm_migrator, never on app boot) ----
FROM deps AS migrate
ENV NODE_ENV=production
USER node
CMD ["pnpm", "exec", "prisma", "migrate", "deploy"]
