---
name: run-local
description: Run the full BnF Corpus Research stack on the local dev machine — Postgres, the ingest worker (in real mode), Prisma migrations, and the Next.js dev server via docker-compose + npm run dev. Use when the user wants to "run locally", "spin up the stack", "start the app", "get it running on my machine", or test end-to-end with the worker locally. NOT for deploying to the cluster — that's the `deploy` skill. Handles both CLUSTER_MODE=fake (app + Postgres only) and CLUSTER_MODE=real (adds the dockerized ingest worker), derives the port and mode from .env.local, and verifies health.
---

# Local deploy — BnF Corpus Research

Bring up the whole stack on the dev machine. The thing that makes this project
different from the other demos is the **ingest worker** — this skill wires it in
when `CLUSTER_MODE=real`.

## Topology (local)

```
npm run dev (host, port from BETTER_AUTH_URL — 3001 here)
   ├─ Postgres        docker compose: localhost:5437
   └─ ingest worker   docker compose --profile worker: localhost:7777   (real mode only)
        └─ posts progress callbacks → host.docker.internal:<port>
```

`fake` mode skips the worker entirely (in-process fake runner). `real` mode runs
the dockerized worker; locally it uses `BLOB_STORE=local` (./worker/data), so no
S3 is needed, but the cloud vision/embed/cluster creds in `worker/.env` must be
filled for ingestion to actually complete.

## Procedure

Run from the repo root (`bnf/`). Do the steps in order; stop and report if a
precondition fails rather than guessing.

### 1. Preconditions

```bash
# Docker daemon up?
docker info >/dev/null 2>&1 || echo "START DOCKER FIRST"

# .env.local must exist (never create it blindly — it holds secrets).
test -f .env.local || echo "MISSING .env.local — cp .env.example .env.local and fill ANTHROPIC_API_KEY / BNF_MCP_TOKEN / BETTER_AUTH_SECRET"
```

If `.env.local` is missing, stop and tell the user to create it (per README §2);
do not fabricate credentials.

### 2. Derive mode + port from .env.local

```bash
MODE=$(grep -E '^CLUSTER_MODE=' .env.local | cut -d= -f2 | tr -d '"' | tr -d ' '); MODE=${MODE:-fake}
PORT=$(grep -E '^BETTER_AUTH_URL=' .env.local | sed -E 's|.*:([0-9]+).*|\1|'); PORT=${PORT:-3000}
echo "CLUSTER_MODE=$MODE  PORT=$PORT"
```

In `real` mode also require `worker/.env`:

```bash
[ "$MODE" = "real" ] && { test -f worker/.env || echo "MISSING worker/.env — cp worker/.env.example worker/.env and fill SCW_*/RUNPOD_*/GOOGLE_AI_*/CLUSTER_* (BLOB_STORE=local is fine locally)"; }
```

### 3. Bring up containers

```bash
if [ "$MODE" = "real" ]; then
  # Postgres + worker (worker depends_on postgres healthy). Add --build if the
  # worker source changed since the last run.
  docker compose --profile worker up -d
else
  # Postgres only.
  docker compose up -d postgres
fi
```

Wait for Postgres to be healthy before migrating:

```bash
until docker compose ps postgres | grep -q healthy; do sleep 2; done; echo "postgres healthy"
```

### 4. Dependencies + schema

```bash
test -d node_modules || npm install
npx prisma generate
npx prisma migrate dev          # applies all migrations; safe to re-run
```

First-time only (offline fake-data seed → creates dev user `leo@alien.club` /
`dev-local` and two projects). Ask before seeding an already-populated DB:

```bash
npx prisma db seed
```

### 5. Start the dev server

Run it in the background and confirm it's ready (use `-p $PORT` so it matches
`BETTER_AUTH_URL`, otherwise auth redirects break):

```bash
npm run dev -- -p "$PORT"
```

Launch it with `run_in_background: true`, then poll the log for `Ready` /
`Local:`. Don't block the session waiting on the long-running process.

### 6. Verify

```bash
curl -sS -o /dev/null -w "app: HTTP %{http_code}\n" "http://localhost:$PORT/"          # expect 307 → /fr/sign-in
[ "$MODE" = "real" ] && curl -sS "http://localhost:7777/health"; echo                    # expect {"ok":true}
```

Then report to the user:
- URL: `http://localhost:<PORT>` (sign in with `leo@alien.club` / `dev-local` if seeded)
- Mode: fake or real (worker running or not)
- Worker health (real mode)

## Teardown

```bash
docker compose --profile worker down        # stop Postgres + worker (keeps the bnf_postgres_data volume)
docker compose --profile worker down -v     # also wipe the Postgres volume (fresh DB next time)
```

## Gotchas

- **Port must match `BETTER_AUTH_URL`.** This machine uses **3001**, not the
  Next.js default 3000 — because the worker posts callbacks to
  `host.docker.internal:3001` and the worker's `APP_BASE_URL` allow-list must
  match. Always start with `-p $PORT` derived from `.env.local`.
- **Worker callback host.** On native Linux the worker reaches the host via
  `host.docker.internal`, which `docker-compose.yml` maps to `host-gateway`.
  If callbacks fail, confirm `WORKER_CALLBACK_BASE_URL` (app) and `APP_BASE_URL`
  (worker) share the same host:port.
- **Worker is opt-in.** Plain `docker compose up -d` does NOT start the worker
  (it's behind the `worker` profile). Use `--profile worker` in real mode.
- **Ingestion needs real creds.** `BLOB_STORE=local` avoids S3, but Holo2 /
  Gemini / RunPod / data-cluster creds in `worker/.env` are still required for a
  job to finish. Watch `docker compose logs -f ingest-worker`.
- **fake mode** needs none of the worker creds — good for UI work.
