// models/projects/schema.ts
// Re-exports the Prisma-generated Project type so business code never
// imports directly from @/lib/generated/prisma/client.

import { type Project as PrismaProject } from "@/lib/generated/prisma/client"

export type Project = PrismaProject
