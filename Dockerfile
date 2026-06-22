# syntax=docker/dockerfile:1.7
#
# BnF Corpus Research — Next.js app image.
#
# Build context is just this repo — all deps (including @alien/chat-sdk, which
# resolves to the published @alien_intelligence/chat-sdk via the npm alias in
# package.json) come from the npm registry, so CI needs no access to the
# monorepo's tooling/ directory.
#
#   docker build -t rg.fr-par.scw.cloud/ns-data-streaming/bnf-demo:<tag> .
#
# See helm/DEPLOY.md for the full release loop.

# ---------------------------------------------------------------------------
# Stage 1: install dependencies
# ---------------------------------------------------------------------------
FROM node:24-slim AS deps
WORKDIR /app
COPY package.json package-lock.json ./
RUN npm ci

# ---------------------------------------------------------------------------
# Stage 2: build
# ---------------------------------------------------------------------------
FROM node:24-slim AS builder
WORKDIR /app

COPY --from=deps /app/node_modules ./node_modules
COPY . .

ENV NODE_ENV=production
# Build-time placeholders so `next build` clears lib/env.ts validation
# (bootEnvSchema.parse runs at import time). Real values come from the
# ConfigMap / Secrets at runtime — none of these are baked into the bundle.
ENV DATABASE_URL=postgresql://build:build@localhost:5432/build
ENV BETTER_AUTH_SECRET=build-time-placeholder-build-time-placeholder
ENV BETTER_AUTH_URL=http://localhost:3000
ENV ANTHROPIC_API_KEY=build-time-placeholder
ENV APP_URL=http://localhost:3000

# Generate the Prisma client (output: lib/generated/prisma/client, gitignored
# so it is absent from the COPY . . layer and must be produced here).
RUN npx prisma generate
RUN npm run build

# ---------------------------------------------------------------------------
# Stage 3: production runtime
# ---------------------------------------------------------------------------
FROM node:24-slim AS runner
WORKDIR /app

# postgresql-client → pg_isready for the entrypoint's Postgres wait.
RUN apt-get update && apt-get install -y --no-install-recommends postgresql-client \
  && rm -rf /var/lib/apt/lists/*

ENV NODE_ENV=production

# Next.js standalone output traces only what it imports; copy full node_modules
# first so the Prisma CLI + engines (used by `prisma migrate deploy` at startup)
# are present, then layer the standalone build on top.
COPY --from=builder --chown=node:node /app/node_modules ./node_modules
COPY --from=builder --chown=node:node /app/.next/standalone ./
COPY --from=builder --chown=node:node /app/.next/static ./.next/static
COPY --from=builder --chown=node:node /app/public ./public

# Prisma schema + migrations + config — needed by `prisma migrate deploy`.
COPY --from=builder --chown=node:node /app/prisma ./prisma
COPY --from=builder --chown=node:node /app/prisma.config.ts ./prisma.config.ts
COPY --from=builder --chown=node:node /app/tsconfig.json ./tsconfig.json
# lib/ carries the generated Prisma client (lib/generated) + any runtime imports.
COPY --from=builder --chown=node:node /app/lib ./lib
COPY --from=builder --chown=node:node /app/package.json ./package.json

COPY --chown=node:node --chmod=0755 docker/entrypoint.sh /app/entrypoint.sh

USER node

EXPOSE 3000

ENTRYPOINT ["/app/entrypoint.sh"]
