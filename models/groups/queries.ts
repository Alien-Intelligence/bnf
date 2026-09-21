import "server-only"

import { prisma } from "@/lib/db"
import type { VisibilityScope } from "@/lib/authz/project-access"
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

  /**
   * The groups this user may see: all of them for an admin, and only their own
   * otherwise — a project owner needs the list to know what they can share
   * into, but must not learn the full org chart.
   *
   * The scope arrives pre-decided from `visibilityScopeFor` — one query, so a
   * caller cannot pick the wrong one, and no role check in a file the policy
   * layer never sees.
   */
  static async listVisible(scope: VisibilityScope): Promise<GroupListItem[]> {
    return prisma.group.findMany({
      ...groupListItem,
      where: scope.unrestricted
        ? {}
        : { members: { some: { userId: scope.userId } } },
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
