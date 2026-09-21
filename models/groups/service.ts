import "server-only"

import { prisma } from "@/lib/db"
import { UserQueries } from "@/models/users/queries"
import type { Group } from "./schema"

/**
 * Slugifies a group name for the unique `slug` column. Lowercase ASCII,
 * diacritics stripped (« Département Recherche » → "departement-recherche"),
 * runs of non-alphanumerics collapsed to a single hyphen.
 *
 * Throws rather than returning "" when a name slugifies to nothing (a name of
 * only punctuation): an empty slug would collide with every other empty slug
 * and is never what the caller meant.
 */
export function slugifyGroupName(name: string): string {
  const slug = name
    .normalize("NFD")
    .replace(/[\u0300-\u036f]/g, "")
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, "-")
    .replace(/^-+|-+$/g, "")

  if (slug.length === 0) {
    throw new InvalidGroupNameError(name)
  }
  return slug
}

export class InvalidGroupNameError extends Error {
  constructor(readonly name_: string) {
    super(`Le nom « ${name_} » ne produit aucun identifiant utilisable.`)
    this.name = "InvalidGroupNameError"
  }
}

/** Thrown by GroupService.addMemberByEmail when the email matches no account. */
export class UserNotFoundError extends Error {
  constructor(readonly email: string) {
    super(`Aucun compte ne correspond à l'adresse ${email}.`)
    this.name = "UserNotFoundError"
  }
}

/** Thrown when a group name/slug is already taken. */
export class GroupSlugTakenError extends Error {
  constructor(readonly slug: string) {
    super(`Un groupe portant l'identifiant « ${slug} » existe déjà.`)
    this.name = "GroupSlugTakenError"
  }
}

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
