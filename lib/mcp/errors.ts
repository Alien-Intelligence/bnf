// lib/mcp/errors.ts
// Typed error hierarchy for BnF MCP HTTP client failures.
// Callers handle each error class explicitly — no silent swallowing.

import type { BnfRateBucketName } from "./rate-limit"

/** Base class for all BnF MCP failures. */
export class BnfMcpError extends Error {
  constructor(message: string, public override cause?: unknown) {
    super(message)
    this.name = "BnfMcpError"
  }
}

/** HTTP 401 / 403 — bearer token missing, expired, or rejected. Terminal: no retry. */
export class BnfMcpAuthError extends BnfMcpError {
  constructor(m = "MCP auth failed") {
    super(m)
    this.name = "BnfMcpAuthError"
  }
}

/** HTTP 429 — MCP rate limit hit. Retryable after `retryAfterMs` (if provided). */
export class BnfMcpRateLimitError extends BnfMcpError {
  retryAfterMs?: number

  constructor(m = "MCP rate limited", retryAfterMs?: number) {
    super(m)
    this.name = "BnfMcpRateLimitError"
    this.retryAfterMs = retryAfterMs
  }
}

/**
 * The MCP refused to RUN the query — it was validated against what the endpoint
 * supports and never sent upstream.
 *
 * Distinct from every other failure here because nothing went wrong: the query
 * was simply not expressible, and `problems` says how to fix it. Terminal as a
 * transport concern (retrying the same string changes nothing) but recoverable
 * by the agent, which is why the problems travel with the error instead of
 * being flattened into the message.
 */
export class BnfMcpQueryRefusedError extends BnfMcpError {
  problems: string[]

  constructor(message: string, problems: string[]) {
    super(message)
    this.name = "BnfMcpQueryRefusedError"
    this.problems = problems
  }
}

/**
 * The APP's own BnF MCP rate limiter (lib/mcp/rate-limit.ts) could not grant a
 * token within its bounded wait: the call was NEVER sent. Distinct from
 * `BnfMcpRateLimitError` (BnF answered 429 — the quota was already blown).
 * `api` names the saturated bucket so the agent is told which quota it shares
 * with every other agent of the application; `waitedMs` is how long the caller
 * queued before being shed.
 */
export class BnfMcpQuotaSaturatedError extends BnfMcpError {
  constructor(
    public readonly api: BnfRateBucketName,
    public readonly waitedMs: number,
    m = `BnF MCP quota saturated (${api}) — call not sent`,
  ) {
    super(m)
    this.name = "BnfMcpQuotaSaturatedError"
  }
}

/** HTTP 404 on ARK resolve — document not found in BnF. Terminal: no retry. */
export class BnfMcpNotFoundError extends BnfMcpError {
  constructor(m = "ARK not found") {
    super(m)
    this.name = "BnfMcpNotFoundError"
  }
}
