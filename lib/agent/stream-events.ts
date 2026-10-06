// lib/agent/stream-events.ts
// THE domain-event contract of the agent stream: one definition, emitted by
// the server (agent tools, through `emitDomainEvent`) and parsed by the client
// (hooks/api/turn-stream.ts, through `parseStreamDomainEvent`). Before this the
// client hand-typed its own copy, which had already drifted (memory_event had
// no `scope`; ingest_event still listed a "submitted-stub" nobody emits).
//
// Pure — no server-only import — so both sides import it.
import { z } from "zod"
import { subagentEventDataSchema } from "@/lib/tools/subagent-runs"
import { MEMORY_SCOPE } from "@/models/memory/schema"
import {
  BUFFER_EVENT_KIND,
  CORPUS_EVENT_KIND,
  INGEST_EVENT_KIND,
  MEMORY_EVENT_KIND,
  NOTE_EVENT_KIND,
  STREAM_DOMAIN_EVENT,
  type StreamDomainEventType,
} from "./stream-event-types"

export {
  BUFFER_EVENT_KIND,
  CORPUS_EVENT_KIND,
  INGEST_EVENT_KIND,
  MEMORY_EVENT_KIND,
  NOTE_EVENT_KIND,
  STREAM_DOMAIN_EVENT,
  type BufferEventKind,
  type CorpusEventKind,
  type MemoryEventKind,
  type NoteEventKind,
  type StreamDomainEventType,
} from "./stream-event-types"

const count = z.number().int().nonnegative()

const corpusEventSchema = z.object({
  type: z.literal(STREAM_DOMAIN_EVENT.CORPUS),
  data: z.object({ kind: z.enum(CORPUS_EVENT_KIND), count, versionSeq: z.number().int() }),
})

const memoryEventSchema = z.object({
  type: z.literal(STREAM_DOMAIN_EVENT.MEMORY),
  data: z.object({
    kind: z.literal(MEMORY_EVENT_KIND.WRITE),
    scope: z.enum(MEMORY_SCOPE),
    section: z.string(),
    itemId: z.string(),
  }),
})

const ingestEventSchema = z.object({
  type: z.literal(STREAM_DOMAIN_EVENT.INGEST),
  data: z.object({ kind: z.literal(INGEST_EVENT_KIND.SUBMITTED), jobId: z.string(), status: z.string() }),
})

const noteEventSchema = z.object({
  type: z.literal(STREAM_DOMAIN_EVENT.NOTE),
  data: z.object({ kind: z.enum(NOTE_EVENT_KIND), noteId: z.string(), title: z.string() }),
})

const bufferEventSchema = z.object({
  type: z.literal(STREAM_DOMAIN_EVENT.BUFFER),
  data: z.object({ kind: z.enum(BUFFER_EVENT_KIND), count, total: count }),
})

const subagentEventSchema = z.object({
  // A spawn_research run: one `start`, then exactly one terminal event (done /
  // error / timeout / aborted) with the same runId — folded into one row by
  // reduceSubagentRuns (lib/tools/subagent-runs.ts).
  type: z.literal(STREAM_DOMAIN_EVENT.SUBAGENT),
  data: subagentEventDataSchema,
})

const compactionEventSchema = z.object({
  type: z.literal(STREAM_DOMAIN_EVENT.COMPACTION),
  data: z.object({ coveredMessageCount: count, keptMessageCount: count, reused: z.boolean() }),
})

export const streamDomainEventSchema = z.discriminatedUnion("type", [
  corpusEventSchema,
  memoryEventSchema,
  ingestEventSchema,
  noteEventSchema,
  bufferEventSchema,
  subagentEventSchema,
  compactionEventSchema,
])
export type StreamDomainEvent = z.infer<typeof streamDomainEventSchema>

/** The events agent tools emit (compaction comes from the SDK runtime). */
export type ToolDomainEvent = Exclude<StreamDomainEvent, { type: typeof STREAM_DOMAIN_EVENT.COMPACTION }>

const DOMAIN_EVENT_TYPES: ReadonlySet<string> = new Set(Object.values(STREAM_DOMAIN_EVENT))

/** The SDK's `ToolContext.emit`, as a tool context carries it. */
type DomainEventSink = { emit?: (event: { type: string; data: unknown }) => void }

/** Publish a domain event from an agent tool: the ONE typed emit path. */
export function emitDomainEvent(ctx: DomainEventSink, event: ToolDomainEvent): void {
  ctx.emit?.(event)
}

/** What the client makes of one SDK domain event frame. */
export type ParsedDomainEvent =
  | { kind: "event"; event: StreamDomainEvent }
  /** Not one of ours (another consumer's event): ignored. */
  | { kind: "foreign" }
  /** One of our types, but its payload breaks the contract. */
  | { kind: "invalid"; type: StreamDomainEventType; issues: string }

export function parseStreamDomainEvent(frame: { type: string; data: unknown }): ParsedDomainEvent {
  if (!DOMAIN_EVENT_TYPES.has(frame.type)) return { kind: "foreign" }
  const parsed = streamDomainEventSchema.safeParse(frame)
  if (parsed.success) return { kind: "event", event: parsed.data }
  const type = Object.values(STREAM_DOMAIN_EVENT).find((t) => t === frame.type)
  if (type === undefined) return { kind: "foreign" }
  return { kind: "invalid", type, issues: parsed.error.message }
}
