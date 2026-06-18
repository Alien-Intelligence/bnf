// lib/mcp/errors.ts
// Typed error hierarchy for BnF MCP HTTP client failures.
// Callers handle each error class explicitly — no silent swallowing.

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

/** HTTP 404 on ARK resolve — document not found in BnF. Terminal: no retry. */
export class BnfMcpNotFoundError extends BnfMcpError {
  constructor(m = "ARK not found") {
    super(m)
    this.name = "BnfMcpNotFoundError"
  }
}
