// lib/agent/tools/authorize.ts
// The policy gate every MUTATING agent tool runs first (playbook/agent-streaming.md,
// "Tool handlers re-run policy checks"; found bug project_bnf_buffer_policy_gap).
//
// The chat route authorizes the user to POST a turn on the session. That never
// authorized every tool the turn may call: until 0.19 no handler in
// lib/agent/tools/ consulted a Policy, and the corpus/buffer handlers loaded the
// project WITHOUT its shares and mutated it, so a read-only group member's turn
// could commit a corpus version. Every mutating handler now calls
// `authorizeProjectTool` with the matching Policy action before it touches
// anything, against the project loaded WITH its shares (ProjectQueries.get —
// the only loader policies accept, playbook/sharing.md).
//
// A denial is the one refusal shape of failure.ts (`success: false` makes the
// chip red, `refused: "forbidden"` names why the agent must stop), never a
// throw out of the tool loop (CLAUDE_ERROR_PATTERNS §15).
import "server-only"

import { ProjectQueries } from "@/models/projects/queries"
import type { ProjectWithShares } from "@/models/projects/schema"
import type { PolicyUser } from "@/models/users/schema"
import { FORBIDDEN_REFUSAL, toolFailure, toolRefusal, type ToolFailure, type ToolRefusal } from "./failure"
import type { TurnScopedCtx } from "./registry-factory"

/** The refusal of an action the turn's user may not perform. */
export type ToolForbidden = ToolRefusal<typeof FORBIDDEN_REFUSAL>

/** What the agent is told when its user may not perform the action. */
export const TOOL_FORBIDDEN_ERROR =
  "Action refusée : votre accès à ce projet ne permet pas de le modifier (lecture seule, " +
  "ou projet dérivé qui lit le corpus d'un autre projet). Explique-le au bibliothécaire ; " +
  "ne réessaie pas autrement."


/**
 * A policy whose `action` takes the project first (and, for a note, the note).
 * Typed structurally so a policy method that does not take a ProjectWithShares
 * — or a project loaded without its shares — is a compile error.
 */
type ProjectPolicyClass<A extends string, R extends unknown[]> = new (
  user: PolicyUser,
) => Record<A, (project: ProjectWithShares, ...rest: R) => boolean>

/** What a gate decides: the project to act on, or the refusal to return. */
export type ToolGate = { ok: true; project: ProjectWithShares } | { ok: false; result: ToolForbidden | ToolFailure }

/** What the agent is told when the session's project is gone (deleted mid-turn). */
export const TOOL_PROJECT_GONE_ERROR =
  "Action impossible : le projet de cette conversation est introuvable (supprimé ?). " +
  "Préviens le bibliothécaire ; ne réessaie pas."

/**
 * Authorize `action` on a project the handler already loaded WITH its shares —
 * for a check on a record found after the first gate (a note), so every
 * authorization goes through one helper and one refusal shape.
 */
export function authorizeOnProject<A extends string, R extends unknown[]>(
  ctx: TurnScopedCtx,
  project: ProjectWithShares,
  PolicyClass: ProjectPolicyClass<A, R>,
  action: A,
  ...rest: R
): ToolGate {
  const policy = new PolicyClass(ctx.user)
  if (policy[action](project, ...rest)) return { ok: true, project }
  return { ok: false, result: toolRefusal(FORBIDDEN_REFUSAL, TOOL_FORBIDDEN_ERROR) }
}

/**
 * Authorize `action` on the session's project for the turn's user. Resolves
 * the project with its shares for the handler to use, or the structured
 * refusal to return as the tool result.
 *
 * A project that no longer exists (deleted while the turn ran — the route
 * resolved `ctx.projectId` from the session row) is logged and returned as a
 * failure the agent reads, never thrown out of the tool loop (§15).
 */
export async function authorizeProjectTool<A extends string, R extends unknown[]>(
  ctx: TurnScopedCtx,
  PolicyClass: ProjectPolicyClass<A, R>,
  action: A,
  ...rest: R
): Promise<ToolGate> {
  const project = await ProjectQueries.get(ctx.projectId)
  if (!project) {
    console.error(`[agent-tools] project ${ctx.projectId} not found for session ${ctx.appSessionId}`)
    return { ok: false, result: toolFailure(TOOL_PROJECT_GONE_ERROR) }
  }
  return authorizeOnProject(ctx, project, PolicyClass, action, ...rest)
}
