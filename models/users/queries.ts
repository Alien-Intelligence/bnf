import "server-only"

import { prisma } from "@/lib/db"
import type { User } from "./schema"

export class UserQueries {
  static async get(id: string): Promise<User | null> {
    return prisma.user.findUnique({ where: { id } })
  }

  static async getByEmail(email: string): Promise<User | null> {
    return prisma.user.findUnique({ where: { email } })
  }
}
