#!/bin/bash
set -euo pipefail

# BnF Corpus Research — app container entrypoint.
#
# 1. Wait for Postgres (the bundled StatefulSet may still be starting).
# 2. Apply Prisma migrations. better-auth's tables (User/Session/Account/
#    Verification) live in the same Prisma schema, so a single
#    `prisma migrate deploy` covers the entire schema — no separate
#    better-auth migration step.
# 3. Start the Next.js standalone server.

if [[ -z "${DATABASE_URL:-}" ]]; then
  echo "[entrypoint] ERROR: DATABASE_URL is not set" >&2
  exit 1
fi

# Parse host + port out of DATABASE_URL for pg_isready.
# Expected: postgres://user:pass@host:port/db  (postgresql:// also accepted)
pg_host=$(echo "$DATABASE_URL" | sed -E 's|.*@([^:/]+).*|\1|')
pg_port=$(echo "$DATABASE_URL" | sed -nE 's|.*@[^:/]+:([0-9]+).*|\1|p')
pg_port=${pg_port:-5432}

echo "[entrypoint] Waiting for Postgres at ${pg_host}:${pg_port}..."
attempts=0
until pg_isready -h "$pg_host" -p "$pg_port" -q; do
  attempts=$((attempts + 1))
  if [[ $attempts -ge 60 ]]; then
    echo "[entrypoint] ERROR: Postgres not ready after ${attempts} attempts" >&2
    exit 1
  fi
  sleep 2
done
echo "[entrypoint] Postgres is ready."

echo "[entrypoint] Applying Prisma migrations..."
node /app/node_modules/.bin/prisma migrate deploy

echo "[entrypoint] Starting Next.js server..."
exec node /app/server.js
