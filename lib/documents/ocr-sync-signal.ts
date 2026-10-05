// lib/documents/ocr-sync-signal.ts
// The "pull OCR quality now" signal (feedback 2026-09-29 #7, Track B).
//
// IngestService persists its resync requests in the commit's own transaction
// (DocumentService.ocrResyncOp) and then calls requestOcrSync(). This module
// imports nothing from models/: the drainer (lib/documents/ocr-sync.ts)
// subscribes to it, so the dependency points from the drainer to the signal and
// never from a service to the drainer (no service → lib → service cycle). The
// signal is only a nudge — the work itself is in the database, so a signal
// raised before the drainer subscribed (or in a process without one) costs
// nothing: the next periodic sweep picks the requests up.
//
// The channel is PROCESS-wide (globalThis, under a registered symbol), not
// module-wide: Next.js bundles instrumentation.ts (where the drainer
// subscribes) and the route handlers (where a commit signals) separately, so a
// module-level emitter is two emitters and the signal never reaches the
// drainer — found in the pass-2 manual kick.
import "server-only"

import { EventEmitter } from "node:events"

const OCR_SYNC_REQUESTED = "ocr-sync-requested"
const CHANNEL_KEY = Symbol.for("bnf.documents.ocr-sync-signal")

/** The one channel of this process, whichever bundle asks first. */
function channel(): EventEmitter {
  const existing: unknown = Reflect.get(globalThis, CHANNEL_KEY)
  if (existing instanceof EventEmitter) return existing
  const created = new EventEmitter()
  Reflect.set(globalThis, CHANNEL_KEY, created)
  return created
}

/** Ask the drainer for a pull now. Never throws, never waits. */
export function requestOcrSync(): void {
  channel().emit(OCR_SYNC_REQUESTED)
}

/** Subscribe the drainer; returns the unsubscribe function. */
export function onOcrSyncRequested(listener: () => void): () => void {
  const ch = channel()
  ch.on(OCR_SYNC_REQUESTED, listener)
  return () => {
    ch.off(OCR_SYNC_REQUESTED, listener)
  }
}
