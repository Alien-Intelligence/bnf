import "server-only"
import { z } from "zod"

// ---------------------------------------------------------------------------
// Boot-time env — required for the server to start.
// ---------------------------------------------------------------------------

const bootEnvSchema = z.object({
  DATABASE_URL: z.string().url(),
  BETTER_AUTH_SECRET: z.string().min(32),
  BETTER_AUTH_URL: z.string().url(),
  ANTHROPIC_API_KEY: z.string().min(1),
})

// Throws immediately on process start if any required var is absent / invalid.
// NO defaults — see platform-wide CLAUDE_ERROR_PATTERNS.md §10.
export const env = bootEnvSchema.parse(process.env)

// ---------------------------------------------------------------------------
// Lazy MCP env — only required when the BnF MCP layer is invoked.
// The dev server starts without these; the first MCP call throws with a clear
// "missing env var" message naming the offending key(s).
// ---------------------------------------------------------------------------

const mcpEnvSchema = z.object({
  BNF_MCP_URL: z.string().url(),
  BNF_MCP_TOKEN: z.string().min(1),
})

let _mcpEnv: z.infer<typeof mcpEnvSchema> | null = null

/**
 * Returns the validated MCP env object.
 * Throws on first call if BNF_MCP_URL or BNF_MCP_TOKEN are absent / invalid.
 * Subsequent calls return the cached object (no re-parsing).
 */
export function requireMcpEnv(): z.infer<typeof mcpEnvSchema> {
  if (_mcpEnv !== null) return _mcpEnv

  const parsed = mcpEnvSchema.safeParse(process.env)
  if (!parsed.success) {
    const missing = parsed.error.issues.map((i) => i.path.join(".")).join(", ")
    throw new Error(
      `MCP env not configured: ${missing}. ` +
        `Set BNF_MCP_URL and BNF_MCP_TOKEN in .env.local (see .env.example).`,
    )
  }

  _mcpEnv = parsed.data
  return _mcpEnv
}
