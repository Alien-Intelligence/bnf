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
import { SESSION_SCOPE } from "@/models/sessions/schema"

const scopeSchema = z.enum(SESSION_SCOPE)

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

/** A run's display status — shared by the reducer and the row component. */
export const SUBAGENT_RUN_STATUS = {
  RUNNING: "running",
  DONE: "done",
  ERROR: "error",
  TIMEOUT: "timeout",
  ABORTED: "aborted",
  /** The turn ended with no terminal event: the final state is unknown. */
  INTERRUPTED: "interrupted",
  /** A subagent_event the client could not read (contract mismatch). */
  UNREADABLE: "unreadable",
} as const

/** What a sub-agent row shows. `label` is "" for a run whose start never arrived. */
export type SubagentRunState =
  | { status: typeof SUBAGENT_RUN_STATUS.RUNNING; label: string }
  | { status: typeof SUBAGENT_RUN_STATUS.DONE; label: string; toolCalls: number; buffered?: number }
  | {
      status: typeof SUBAGENT_RUN_STATUS.ERROR | typeof SUBAGENT_RUN_STATUS.TIMEOUT | typeof SUBAGENT_RUN_STATUS.ABORTED
      label: string
      toolCalls: number
      buffered?: number
      error?: string
    }
  | { status: typeof SUBAGENT_RUN_STATUS.INTERRUPTED; label: string }
  | { status: typeof SUBAGENT_RUN_STATUS.UNREADABLE }

/** One turn's view for the reducer: its domain events, and whether it is live. */
export type SubagentTurnInput = {
  streaming: boolean
  events: ReadonlyArray<{ type: string; data: unknown }>
}

/** A folded run, and which of its events renders its one row. */
export type SubagentRun = {
  state: SubagentRunState
  /** `start` normally; `terminal` for a run whose start never arrived. */
  anchor: "start" | "terminal"
}

function terminalState(label: string, t: SubagentTerminalData): SubagentRunState {
  const buffered = t.buffered !== undefined ? { buffered: t.buffered } : {}
  if (t.kind === "done") return { status: SUBAGENT_RUN_STATUS.DONE, label, toolCalls: t.toolCalls, ...buffered }
  return { status: t.kind, label, toolCalls: t.toolCalls, ...buffered, ...(t.error !== undefined ? { error: t.error } : {}) }
}

/** Parse a subagent_event's data, logging one that breaks the contract. */
export function parseSubagentEvent(data: unknown): SubagentEventData | null {
  const parsed = subagentEventDataSchema.safeParse(data)
  if (parsed.success) return parsed.data
  console.warn(`[subagent] unreadable subagent_event: ${parsed.error.message}`)
  return null
}

/**
 * Fold every turn's subagent events into one run per runId:
 *   - the FIRST terminal event of a run wins; a duplicate (a stray `aborted`
 *     after `done`) is ignored;
 *   - a terminal closes its run whichever turn carries it;
 *   - a terminal whose start never arrived still makes a row (anchored at the
 *     terminal, with no label);
 *   - a run with no terminal is `running` while the turn that opened it
 *     streams, and `interrupted` once it has stopped — never a spinner after
 *     a reload or a dropped stream.
 * Unreadable events are logged; the row component renders a fallback for them
 * at their own position.
 */
export function reduceSubagentRuns(turns: ReadonlyArray<SubagentTurnInput>): Map<string, SubagentRun> {
  const starts = new Map<string, { label: string; streaming: boolean }>()
  const terminals = new Map<string, SubagentTerminalData>()
  for (const turn of turns) {
    for (const event of turn.events) {
      if (event.type !== "subagent_event") continue
      const data = parseSubagentEvent(event.data)
      if (data === null) continue
      if (data.kind === "start") {
        if (!starts.has(data.runId)) starts.set(data.runId, { label: data.label, streaming: turn.streaming })
      } else if (!terminals.has(data.runId)) {
        terminals.set(data.runId, data)
      }
    }
  }
  const runs = new Map<string, SubagentRun>()
  for (const [runId, start] of starts) {
    const t = terminals.get(runId)
    const state: SubagentRunState =
      t !== undefined
        ? terminalState(start.label, t)
        : start.streaming
          ? { status: SUBAGENT_RUN_STATUS.RUNNING, label: start.label }
          : { status: SUBAGENT_RUN_STATUS.INTERRUPTED, label: start.label }
    runs.set(runId, { state, anchor: "start" })
  }
  for (const [runId, t] of terminals) {
    if (!starts.has(runId)) runs.set(runId, { state: terminalState("", t), anchor: "terminal" })
  }
  return runs
}
