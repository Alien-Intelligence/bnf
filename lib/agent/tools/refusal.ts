// lib/agent/tools/refusal.ts
// The ONE shape an agent tool returns when it refuses a call it understood
// (nothing ingested, note not found, an entry outside the corpus, …).
//
// `success: false` is what lib/tools/display.ts `toolCallErrored` keys on, so
// a refusal is persisted as `tool_call.status = "error"` and drawn with the
// error chip — by the chat, the turn stream and the persistence adapter alike
// — while the model still receives the structured `error` text and can act on
// it within the turn (playbook/agent-streaming.md: validation failures and
// denials are returned, not thrown). A bare `{ error }` settles as "ok" with a
// ✓ chip, which is why it is not used.

/** A refused tool call: the model reads `error`; the app records a failure. */
export type ToolRefusal = { success: false; error: string }

export function refusal(error: string): ToolRefusal {
  return { success: false, error }
}
