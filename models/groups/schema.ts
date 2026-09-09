// models/groups/schema.ts
// Query shapes and payload types for groups. Domain enums live here, not in
// schema.prisma — see playbook/models.md.

import type { Prisma, Group as PrismaGroup } from "@/lib/generated/prisma/client"

export type Group = PrismaGroup

/** A group with its members' user rows — the members sheet payload. */
export const groupWithMembers = {
  include: {
    members: {
      include: { user: { select: { id: true, name: true, email: true, role: true } } },
      orderBy: { addedAt: "asc" },
    },
  },
} satisfies Prisma.GroupDefaultArgs

export type GroupWithMembers = Prisma.GroupGetPayload<typeof groupWithMembers>

/** A group plus its member count — the admin list payload. */
export const groupListItem = {
  include: { _count: { select: { members: true, shares: true } } },
} satisfies Prisma.GroupDefaultArgs

export type GroupListItem = Prisma.GroupGetPayload<typeof groupListItem>

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
