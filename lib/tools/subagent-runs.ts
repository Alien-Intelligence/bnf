// lib/tools/subagent-runs.ts
// The sub-agent (spawn_research) run lifecycle, as the live stream sees it.
// Pure — no server-only — so the chat panel folds the same events the server
// emits (feedback #10e: on 0.18.1 a sub-agent's "start" row kept spinning
// after its "done" row appeared, because the two rows were never correlated).
//
// Each run carries a `runId`. spawn_research emits exactly one `start` and,
// on every path, exactly one terminal event (done / error / timeout / aborted)
// with the same runId. Domain events are live-only (not persisted), so a turn
// that ENDS with a run still open — a server restart, a dropped stream — shows
// that run as `interrupted`, never as a spinner.
import { z } from "zod"

const scopeSchema = z.enum(["corpus", "research"])

export const SUBAGENT_TERMINAL_KINDS = ["done", "error", "timeout", "aborted"] as const
export type SubagentTerminalKind = (typeof SUBAGENT_TERMINAL_KINDS)[number]

const startSchema = z.object({
  kind: z.literal("start"),
  runId: z.string().min(1),
  scope: scopeSchema,
  label: z.string(),
})

const terminalSchema = z.object({
  kind: z.enum(SUBAGENT_TERMINAL_KINDS),
  runId: z.string().min(1),
  scope: scopeSchema,
  toolCalls: z.number().int().nonnegative(),
  buffered: z.number().int().nonnegative().optional(),
  error: z.string().optional(),
})

/** The `data` of a `subagent_event`, as emitted by lib/agent/tools/spawn.ts. */
export const subagentEventDataSchema = z.discriminatedUnion("kind", [startSchema, terminalSchema])
export type SubagentEventData = z.infer<typeof subagentEventDataSchema>
export type SubagentStartData = z.infer<typeof startSchema>
export type SubagentTerminalData = z.infer<typeof terminalSchema>

/** What a sub-agent row shows. */
export type SubagentRunState =
  | { status: "running"; label: string }
  | { status: "done"; label: string; toolCalls: number; buffered?: number }
  | { status: "error" | "timeout" | "aborted"; label: string; toolCalls: number; error?: string }
  /** The turn ended with no terminal event: the final state is unknown. */
  | { status: "interrupted"; label: string }

/** One turn's view for the reducer: its domain events, and whether it is live. */
export type SubagentTurnInput = {
  streaming: boolean
  events: ReadonlyArray<{ type: string; data: unknown }>
}

function terminalState(label: string, t: SubagentTerminalData): SubagentRunState {
  if (t.kind === "done") {
    return { status: "done", label, toolCalls: t.toolCalls, ...(t.buffered !== undefined ? { buffered: t.buffered } : {}) }
  }
  return { status: t.kind, label, toolCalls: t.toolCalls, ...(t.error !== undefined ? { error: t.error } : {}) }
}

/**
 * Fold every turn's subagent events into one state per runId. A start opens a
 * run; the terminal event with the same runId closes it, in any order and with
 * parallel runs interleaved. An event without a runId (an older server) or a
 * terminal with no matching start is ignored. A run still open when its turn
 * has stopped streaming is `interrupted`.
 */
export function reduceSubagentRuns(turns: ReadonlyArray<SubagentTurnInput>): Map<string, SubagentRunState> {
  const runs = new Map<string, SubagentRunState>()
  for (const turn of turns) {
    const opened: string[] = []
    const terminals = new Map<string, SubagentTerminalData>()
    for (const event of turn.events) {
      if (event.type !== "subagent_event") continue
      const parsed = subagentEventDataSchema.safeParse(event.data)
      if (!parsed.success) continue
      if (parsed.data.kind === "start") {
        runs.set(parsed.data.runId, { status: "running", label: parsed.data.label })
        opened.push(parsed.data.runId)
      } else {
        terminals.set(parsed.data.runId, parsed.data)
      }
    }
    for (const runId of opened) {
      const open = runs.get(runId)
      if (open === undefined) continue
      const t = terminals.get(runId)
      if (t !== undefined) runs.set(runId, terminalState(open.label, t))
      else if (!turn.streaming) runs.set(runId, { status: "interrupted", label: open.label })
    }
  }
  return runs
}
