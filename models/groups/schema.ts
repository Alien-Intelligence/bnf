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
