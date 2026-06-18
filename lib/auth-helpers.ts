import "server-only"
import { headers } from "next/headers"
import { redirect } from "next/navigation"
import { auth } from "./auth"

export async function requireSessionUser() {
  const session = await auth.api.getSession({ headers: await headers() })
  if (!session) {
    // No request URL available here; redirect to plain /sign-in.
    // Sign-in pages land in commit #12.
    redirect("/sign-in")
  }
  return session.user
}
