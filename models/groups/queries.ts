import "server-only"

import { prisma } from "@/lib/db"
import {
  groupListItem,
  groupWithMembers,
  type Group,
  type GroupListItem,
  type GroupWithMembers,
} from "./schema"

export class GroupQueries {
  /** Every group, with member and share counts. Admin console listing. */
  static async list(): Promise<GroupListItem[]> {
    return prisma.group.findMany({ ...groupListItem, orderBy: { name: "asc" } })
  }

  /** The groups a user belongs to, with counts. Non-admin listing. */
  static async listForUser(userId: string): Promise<GroupListItem[]> {
    return prisma.group.findMany({
      ...groupListItem,
      where: { members: { some: { userId } } },
      orderBy: { name: "asc" },
    })
  }

  static async get(id: string): Promise<Group | null> {
    return prisma.group.findUnique({ where: { id } })
  }

  static async withMembers(id: string): Promise<GroupWithMembers | null> {
    return prisma.group.findUnique({ where: { id }, ...groupWithMembers })
  }

  /**
   * The hot path: resolved once per authenticated request to build the
   * PolicyUser. Served entirely from the (user_id) index on group_member.
   */
  static async groupIdsForUser(userId: string): Promise<string[]> {
    const rows = await prisma.groupMember.findMany({
      where: { userId },
      select: { groupId: true },
    })
    return rows.map((r) => r.groupId)
  }
}
