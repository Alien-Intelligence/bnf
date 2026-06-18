# BnF Corpus Research

A research workspace for Bibliothèque nationale de France librarians and scholars. Co-branded **Alien Intelligence × BnF**. Working language: **French**.

See `CLAUDE.md` for full project orientation, `AGENTS.md` for the Next.js 16 caveat, and `playbook/` for engineering rules.

## Quick start

### 1. Postgres

```bash
docker compose up -d
# Postgres 16 on localhost:5437 (avoids platform/data-cluster ports)
```

### 2. Environment

```bash
cp .env.example .env.local
# Edit .env.local:
#   BETTER_AUTH_SECRET — generate with `openssl rand -hex 32`
#   ANTHROPIC_API_KEY — your Anthropic key
#   BNF_MCP_TOKEN — request from the Alien platform team
# (DATABASE_URL, BETTER_AUTH_URL, BNF_MCP_URL ship with usable defaults.)
```

### 3. Install + migrate + seed

```bash
npm install
npx prisma migrate dev          # applies all migrations
npx prisma db seed              # fake-data seed (offline; default for first-time setup)
```

You should see two projects created and a dev user `leo@alien.club` (password `dev-local`).

### 4. Run

```bash
npm run dev                     # http://localhost:3000
```

Visit http://localhost:3000 — redirects to `/fr/sign-in`. Sign in with `leo@alien.club` / `dev-local`. Pick a project from the list.

## Scripts

| Command | Purpose |
|---|---|
| `npm run dev` | Next.js dev server (Turbopack) |
| `npm run build` | production build |
| `npm run lint` | ESLint |
| `npm run smoke` | tsx scripts/smoke-test.ts — exercises advisory lock, no-op delta, better-auth |
| `npx prisma db seed` | Fake-data seed (offline, fast) — default |
| `npm run seed:from-mcp` | Real-data seed via BnF MCP — requires BNF_MCP_TOKEN + network |

## Architecture in 60 seconds

- **Frontend + API**: Next.js 16 App Router, React 19, TypeScript 5, Tailwind 4.
- **UI**: shadcn primitives + named feature components per `playbook/componentization.md`.
- **Data**: Prisma 7 + Postgres (via `@prisma/adapter-pg`).
- **Auth**: better-auth (email+password in slice 1; Alien SSO in a later slice).
- **Agent runtime**: `@alien/chat-sdk` as the base streaming layer; BnF domain layer (tools, prompts, persistence) on top.
- **BnF integration**: direct HTTP client for the BnF MCP (`lib/mcp/bnf-client.ts`). chat-sdk also wires it via `mcpServers` in slice 3.

## Where to find what

- **Design intent** — `design/docs/01..09` (frozen handoff; do not edit).
- **Engineering rules** — `playbook/README.md`.
- **Slice plans** — sibling `ai-memories/tech/repos/bnf/<slice>/`.
- **Implementation logs** — sibling `ai-memories/tech/repos/bnf/<slice>/implement/`.
