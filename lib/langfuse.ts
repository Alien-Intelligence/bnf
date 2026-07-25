import "server-only"

import { env } from "@/lib/env"

// lib/langfuse.ts
// Server-side helpers to build "view in Langfuse" deep-links. Langfuse dashboard
// URLs are /project/<projectId>/… so both LANGFUSE_BASE_URL and
// LANGFUSE_PROJECT_ID must be configured; otherwise these return null and the
// caller omits the link. The app tags every agent turn with its durable session
// id (= AppSession.id), so the session view groups all of a session's traces.

/** Langfuse session view for an AppSession id, or null if Langfuse isn't wired. */
export function langfuseSessionUrl(sessionId: string | null): string | null {
  if (!sessionId || !env.LANGFUSE_BASE_URL || !env.LANGFUSE_PROJECT_ID) {
    return null
  }
  const base = env.LANGFUSE_BASE_URL.replace(/\/+$/, "")
  return `${base}/project/${env.LANGFUSE_PROJECT_ID}/sessions/${encodeURIComponent(sessionId)}`
}
