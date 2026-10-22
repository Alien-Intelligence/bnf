import "server-only"

import { prisma } from "@/lib/db"
import { projectWithMessageUsage, type ProjectWithMessageUsage } from "./schema"

export class MessageQueries {
  /**
   * Every project in the instance with the usage of all its messages. Demo-scale
   * aggregation shared in shape with UserQueries.listWithAdminStats: one fetch,
   * the totals are computed by the service.
   */
  static async projectsWithUsage(): Promise<ProjectWithMessageUsage[]> {
    return prisma.project.findMany(projectWithMessageUsage)
  }
}
