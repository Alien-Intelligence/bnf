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

/** What a corpus_event reports happened to the corpus head. */
export const CORPUS_EVENT_KIND = { ADD: "add", REMOVE: "remove" } as const
export type CorpusEventKind = (typeof CORPUS_EVENT_KIND)[keyof typeof CORPUS_EVENT_KIND]

/** What a memory_event reports (the agent has no forget tool). */
export const MEMORY_EVENT_KIND = { WRITE: "write" } as const
export type MemoryEventKind = (typeof MEMORY_EVENT_KIND)[keyof typeof MEMORY_EVENT_KIND]

/** What an ingest_event reports. */
export const INGEST_EVENT_KIND = { SUBMITTED: "submitted" } as const

/** What a note_event reports. */
export const NOTE_EVENT_KIND = { CREATED: "created", UPDATED: "updated" } as const
export type NoteEventKind = (typeof NOTE_EVENT_KIND)[keyof typeof NOTE_EVENT_KIND]

/** What a buffer_event reports happened to the buffer. */
export const BUFFER_EVENT_KIND = {
  ADDED: "added",
  REMOVED: "removed",
  COMMITTED: "committed",
  CLEARED: "cleared",
} as const
export type BufferEventKind = (typeof BUFFER_EVENT_KIND)[keyof typeof BUFFER_EVENT_KIND]

