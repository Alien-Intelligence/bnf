// lib/agent/stream-event-types.ts
// The domain-event TYPE names, alone, with no dependency — so a module the
// stream contract itself imports (lib/tools/subagent-runs.ts) can name them
// without an import cycle. The contract is lib/agent/stream-events.ts, which
// re-exports these.

/** Every domain event type the stream carries. */
export const STREAM_DOMAIN_EVENT = {
  CORPUS: "corpus_event",
  MEMORY: "memory_event",
  INGEST: "ingest_event",
  NOTE: "note_event",
  BUFFER: "buffer_event",
  SUBAGENT: "subagent_event",
  /** Emitted by the chat-sdk runtime when it compacts the history. */
  COMPACTION: "compaction_event",
} as const
export type StreamDomainEventType = (typeof STREAM_DOMAIN_EVENT)[keyof typeof STREAM_DOMAIN_EVENT]

