import "server-only"
import { headers } from "next/headers"
import { notFound } from "next/navigation"
import { auth } from "./auth"
import { prisma } from "./db"
import { redirect } from "@/i18n/navigation"
import type { User } from "@/lib/generated/prisma/client"

export async function requireSessionUser(nextPath?: string): Promise<User> {
  const session = await auth.api.getSession({ headers: await headers() })
  if (!session) {
    const next = nextPath ? `?next=${encodeURIComponent(nextPath)}` : ""
    return redirect({ href: `/sign-in${next}`, locale: "fr" })
  }

  const user = await prisma.user.findUnique({ where: { id: session.user.id } })
  if (!user) {
    return redirect({ href: "/sign-in", locale: "fr" })
  }

  return user
}

/**
 * Like requireSessionUser, but also asserts the user has the "admin" role.
 * Non-admins get a 404 — consistent with how projects/[id] hides resources
 * for non-members rather than serving a visible 403.
 */
export async function requireAdminUser(nextPath?: string): Promise<User> {
  const user = await requireSessionUser(nextPath)
  if (user.role !== "admin") {
    notFound()
  }
  return user
}
