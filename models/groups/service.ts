import "server-only"

import { prisma } from "@/lib/db"
import { UserQueries } from "@/models/users/queries"
import {
  GroupSlugTakenError,
  UserNotFoundError,
  slugifyGroupName,
  type Group,
} from "./schema"

export class GroupService {
  static async create(name: string): Promise<Group> {
    const slug = slugifyGroupName(name)

    const existing = await prisma.group.findUnique({ where: { slug } })
    if (existing) throw new GroupSlugTakenError(slug)

    return prisma.group.create({ data: { name, slug } })
  }

  /**
   * Renaming re-derives the slug: the slug is an identifier for humans, not a
   * permalink — nothing outside the app references it, and a stale slug after a
   * rename is a bug report waiting to happen.
   */
  static async rename(id: string, name: string): Promise<Group> {
    const slug = slugifyGroupName(name)

    const clash = await prisma.group.findUnique({ where: { slug } })
    if (clash && clash.id !== id) throw new GroupSlugTakenError(slug)

    return prisma.group.update({ where: { id }, data: { name, slug } })
  }

  /** Cascades to group_member and project_share (both onDelete: Cascade). */
  static async delete(id: string): Promise<void> {
    await prisma.group.delete({ where: { id } })
  }

  /**
   * Adds by email so an admin never has to look up a user id. An address that
   * matches no account throws — never a silent no-op that leaves the admin
   * believing the member was added (CLAUDE_ERROR_PATTERNS.md §9).
   *
   * Re-adding an existing member is idempotent: the composite primary key
   * (groupId, userId) makes the upsert a no-op update.
   */
  static async addMemberByEmail(groupId: string, email: string): Promise<void> {
    const user = await UserQueries.getByEmail(email)
    if (!user) throw new UserNotFoundError(email)

    await prisma.groupMember.upsert({
      where: { groupId_userId: { groupId, userId: user.id } },
      create: { groupId, userId: user.id },
      update: {},
    })
  }

  /**
   * Removing a non-member is a no-op rather than an error: the caller's intent
   * ("this user is not in this group") is satisfied either way, and the members
   * sheet can race a second admin's removal.
   */
  static async removeMember(groupId: string, userId: string): Promise<void> {
    await prisma.groupMember.deleteMany({ where: { groupId, userId } })
  }
}
