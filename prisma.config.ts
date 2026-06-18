import { config } from "dotenv"
import { defineConfig } from "prisma/config"

// Load .env.local (Next.js convention) so `DATABASE_URL` is available to
// `prisma migrate` and other Prisma CLI commands without manual env export.
// Falls back gracefully if the file is absent (CI provides vars directly).
config({ path: ".env.local" })

export default defineConfig({
  schema: "./prisma/schema.prisma",
  datasource: {
    url: process.env["DATABASE_URL"]!,
  },
  migrations: {
    // tsx --conditions react-server: makes `server-only` resolve to the empty
    // shim (react-server conditional export) so service modules that guard
    // against client-bundle inclusion can be imported from Node.js scripts.
    // --env-file .env.local: loads DATABASE_URL and other vars before any
    // module initialisation so lib/db.ts and lib/env.ts see them at import
    // time (ESM imports are hoisted; dotenv.config() called inside the module
    // body would be too late).
    // --conditions react-server: makes `server-only` resolve to the empty shim.
    seed: "tsx --env-file-if-exists .env.local --conditions react-server prisma/seed.ts",
  },
})
