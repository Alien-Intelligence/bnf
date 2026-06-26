# Worker V2 container — the staged-bucket ingest pipeline + the app↔worker HTTP
# ingress. Build context = this directory (bnf/worker-v2/).
#
# One process runs everything: every stage's pg-boss consumer loop, the HTTP
# ingress (POST /ingest, GET /progress/:runId, cancel, health) on WORKER_HTTP_PORT,
# and the terminal commit callback. It exits only on SIGTERM (graceful drain);
# Docker's `restart: unless-stopped` supervises it — no pm2, no systemd inside.
#
# This REPLACES the V1 worker (bnf/worker). The two share no code; V1 is retired.

FROM node:24-alpine AS deps
WORKDIR /app
COPY package.json package-lock.json* ./
# tsx is a devDependency and the runtime loader, so we keep dev deps.
RUN npm ci --omit=dev=false

FROM node:24-alpine AS runtime
WORKDIR /app

# Drop privileges. The official node images ship a `node` user (uid 1000).
RUN apk add --no-cache tini && \
    mkdir -p /app && \
    chown -R node:node /app

COPY --from=deps --chown=node:node /app/node_modules ./node_modules
COPY --chown=node:node package.json tsconfig.json ./
COPY --chown=node:node src ./src

USER node

# tini reaps zombies and forwards SIGTERM cleanly — main.ts's graceful-drain
# handler relies on receiving SIGTERM, not SIGKILL.
ENTRYPOINT ["/sbin/tini", "--"]

# The HTTP ingress port (the app's WORKER_RUNNER_URL targets this). Overridable
# via WORKER_HTTP_PORT. .env is NOT baked in — it's supplied via compose/k8s.
EXPOSE 7777
CMD ["npm", "start"]
