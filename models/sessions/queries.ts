import "server-only"
// models/sessions/queries.ts
// Pure database access for AppSession, including the ONE home of the system
// prompt cache: its compare-and-set write and every invalidation. Each
// invalidation takes the caller's transaction, so the change that makes a
// prompt stale and the invalidation commit together or not at all.
import { prisma } from "@/lib/db"
import type { Prisma } from "@/lib/generated/prisma/client"
import { SESSION_STATUS, type AppSession, type SessionScope } from "./schema"

/** The client a sessions query runs on: the app client or a transaction's. */
export type SessionDb = Pick<Prisma.TransactionClient, "appSession">

/** Whose cached prompts an invalidation drops. */
export type PromptTarget = {
  /** The project — and, with `withDerived`, every workspace deriving from it. */
  projectId: string
  /** Only this scope's sessions; both when absent. */
  scope?: SessionScope
  /** Also the workspaces reading this project's corpus (corpusSourceId). */
  withDerived?: boolean
}

/** What a spawn-run claim found. */
export const SPAWN_CLAIM = {
  CLAIMED: "claimed",
  CAP_REACHED: "cap_reached",
  /** The session row does not exist — a fault, never the quota refusal. */
  NO_SESSION: "no_session",
} as const
export type SpawnClaim = (typeof SPAWN_CLAIM)[keyof typeof SPAWN_CLAIM]

export class SessionQueries {
  /**
   * Drop the cached system prompt of the target's sessions: the prompt, the
   * revision it was rendered at, and a bump of `promptEpoch`, so a render
   * already in flight cannot cache itself (PromptBuilder.buildForSession's
   * compare-and-set). Run it on the transaction of the change that made the
   * prompt stale (`db`).
   */
  static invalidatePrompts(target: PromptTarget, db: SessionDb = prisma) {
    const project: Prisma.ProjectWhereInput = target.withDerived
      ? { OR: [{ id: target.projectId }, { corpusSourceId: target.projectId }] }
      : { id: target.projectId }
    return db.appSession.updateMany({
      where: { project, ...(target.scope !== undefined ? { scope: target.scope } : {}) },
      data: { systemPrompt: null, promptRevision: null, promptEpoch: { increment: 1 } },
    })
  }

  /** Drop the cached prompts of the sessions of the projects deriving from
   *  `shareIds` — a revoked grant changes what their research prompt says. */
  static invalidateDerivedThroughShares(shareIds: string[], db: SessionDb = prisma) {
    return db.appSession.updateMany({
      where: { project: { corpusSourceShareId: { in: shareIds } } },
      data: { systemPrompt: null, promptRevision: null, promptEpoch: { increment: 1 } },
    })
  }

  /**
   * Cache a rendered prompt — only if no invalidation happened since the row
   * was read at `epoch`. Returns false when it lost that race (the caller
   * re-renders).
   */
  static async cachePrompt(
    id: string,
    epoch: number,
    prompt: { systemPrompt: string; promptLocale: string; promptRevision: string },
  ): Promise<boolean> {
    const { count } = await prisma.appSession.updateMany({ where: { id, promptEpoch: epoch }, data: prompt })
    return count === 1
  }

  /**
   * Claim one spawn_research run for the session, atomically: the counter
   * moves only while it is below `max`, so concurrent launches cannot both
   * take the last slot, a refusal never counts, and the count survives a
   * reload. A missing session is reported as such, not as the cap.
   */
  static async claimSpawnRun(id: string, max: number): Promise<SpawnClaim> {
    const { count } = await prisma.appSession.updateMany({
      where: { id, spawnRuns: { lt: max } },
      data: { spawnRuns: { increment: 1 } },
    })
    if (count === 1) return SPAWN_CLAIM.CLAIMED
    const exists = await prisma.appSession.count({ where: { id } })
    return exists === 1 ? SPAWN_CLAIM.CAP_REACHED : SPAWN_CLAIM.NO_SESSION
  }

  /** Give back a claimed run that never started (the claim landed after the
   *  launch was abandoned). */
  static async releaseSpawnRun(id: string): Promise<void> {
    await prisma.appSession.updateMany({ where: { id, spawnRuns: { gt: 0 } }, data: { spawnRuns: { decrement: 1 } } })
  }

  static async listForProject(projectId: string, scope: SessionScope): Promise<AppSession[]> {
    return prisma.appSession.findMany({
      where: { projectId, scope, status: { not: SESSION_STATUS.ARCHIVED } },
      orderBy: { updatedAt: "desc" },
    })
  }

  static async get(id: string): Promise<AppSession | null> {
    return prisma.appSession.findUnique({ where: { id } })
  }

  /** The session row, or a throw — for callers holding a session id that must exist. */
  static async getOrThrow(id: string): Promise<AppSession> {
    return prisma.appSession.findUniqueOrThrow({ where: { id } })
  }
}

