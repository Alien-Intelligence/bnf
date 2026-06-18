// lib/agent/runtime/detached-signal.ts
// Pure factory — no server-only import, no external dependencies.
//
// Purpose: produce an AbortController whose signal is NOT wired to the
// incoming HTTP request.  The agent turn MUST survive a client disconnect,
// so we never pass request.signal to runClaudeSdk.  The caller stores the
// controller in TurnRegistry and calls controller.abort() only when the
// user explicitly cancels the turn or the reaper fires.

export function createDetachedController(): AbortController {
  return new AbortController()
}
