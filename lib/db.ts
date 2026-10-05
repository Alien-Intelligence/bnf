import "server-only"
import { PrismaPg } from "@prisma/adapter-pg"
import { PrismaClient } from "@/lib/generated/prisma/client"
import { DB_CONNECTION_TIMEOUT_MS, DB_STATEMENT_TIMEOUT_MS } from "./constants"
import { env } from "./env"

// Prisma 7 uses the "client" engine type which requires a driver adapter.
// PrismaPg creates a connection pool to the Postgres database identified by
// DATABASE_URL. The singleton pattern prevents multiple pool instances during
// Next.js hot-reload in development. Both timeouts bound every query and every
// client checkout at once (lib/constants.ts DB_*_TIMEOUT_MS).
function makePrismaClient(): PrismaClient {
  const adapter = new PrismaPg({
    connectionString: env.DATABASE_URL,
    statement_timeout: DB_STATEMENT_TIMEOUT_MS,
    connectionTimeoutMillis: DB_CONNECTION_TIMEOUT_MS,
  })
  return new PrismaClient({ adapter })
}

const globalForPrisma = globalThis as unknown as { prisma?: PrismaClient }
export const prisma = globalForPrisma.prisma ?? makePrismaClient()
if (process.env.NODE_ENV !== "production") globalForPrisma.prisma = prisma
