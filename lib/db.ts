import "server-only"
import { PrismaPg } from "@prisma/adapter-pg"
import { PrismaClient } from "@/lib/generated/prisma/client"
import { env } from "./env"

// Prisma 7 uses the "client" engine type which requires a driver adapter.
// PrismaPg creates a connection pool to the Postgres database identified by
// DATABASE_URL. The singleton pattern prevents multiple pool instances during
// Next.js hot-reload in development.
function makePrismaClient(): PrismaClient {
  const adapter = new PrismaPg({ connectionString: env.DATABASE_URL })
  return new PrismaClient({ adapter })
}

const globalForPrisma = globalThis as unknown as { prisma?: PrismaClient }
export const prisma = globalForPrisma.prisma ?? makePrismaClient()
if (process.env.NODE_ENV !== "production") globalForPrisma.prisma = prisma
