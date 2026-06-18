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
})
