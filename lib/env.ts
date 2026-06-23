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
  APP_URL: z.string().url(),
  JOB_CALLBACK_SECRET: z.string().min(32).optional(),
  // Langfuse observability — OPTIONAL. When all three are set, @alien/chat-sdk
  // traces every agent turn to Langfuse automatically (the SDK reads these from
  // process.env itself). Absent → tracing is simply off. `LANGFUSE_BASE_URL` is
  // also the base for any future "view trace in Langfuse" deep-link.
  LANGFUSE_PUBLIC_KEY: z.string().min(1).optional(),
  LANGFUSE_SECRET_KEY: z.string().min(1).optional(),
  LANGFUSE_BASE_URL: z.string().url().optional(),
  // Alien Auth (Authentik OIDC) SSO — OPTIONAL. When the base URL + client
  // id + secret are all set, the Better Auth genericOAuth plugin is wired up
  // and a "Se connecter avec Alien" button appears on the sign-in page.
  // Absent → the app boots in email/password-only mode. This is genuine
  // optionality (a feature toggle), not an empty default — CLAUDE_ERROR_PATTERNS
  // §10 forbids defaulting secrets, not declaring a feature optional.
  // The Authentik application (`AUTHENTIK_APP_SLUG`) is shared with the
  // alien-agents demo; the client id/secret are the same credentials.
  AUTHENTIK_BASE_URL: z.string().url().optional(),
  AUTHENTIK_APP_SLUG: z.string().min(1).default("datastreaming"),
  AUTHENTIK_CLIENT_ID: z.string().min(1).optional(),
  AUTHENTIK_CLIENT_SECRET: z.string().min(1).optional(),
})

// Throws immediately on process start if any required var is absent / invalid.
// NO defaults — see platform-wide CLAUDE_ERROR_PATTERNS.md §10.
export const env = bootEnvSchema.parse(process.env)

// True only when all three SSO credentials are present. Gates both the
// server-side genericOAuth plugin (lib/auth.ts) and the sign-in button
// (app/[locale]/sign-in). A partial config (e.g. id without secret) is
// treated as "off" rather than silently half-configured.
export const ssoEnabled: boolean = Boolean(
  env.AUTHENTIK_BASE_URL && env.AUTHENTIK_CLIENT_ID && env.AUTHENTIK_CLIENT_SECRET,
)

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

// ---------------------------------------------------------------------------
// Lazy data-cluster MCP env — only required when real RAG (CLUSTER_MODE=real)
// queries the datacluster MCP. Same throw-on-missing contract as requireMcpEnv:
// the dev server boots without these; the first real RAG call throws naming the
// offending key(s). NO defaults (CLAUDE_ERROR_PATTERNS §10).
// ---------------------------------------------------------------------------

const clusterEnvSchema = z.object({
  DATACLUSTER_MCP_URL: z.string().url(),
  CLUSTER_BEARER_TOKEN: z.string().min(1),
})

let _clusterEnv: z.infer<typeof clusterEnvSchema> | null = null

/**
 * Returns the validated data-cluster MCP env object.
 * Throws on first call if DATACLUSTER_MCP_URL or CLUSTER_BEARER_TOKEN are
 * absent / invalid. Subsequent calls return the cached object (no re-parsing).
 */
export function requireClusterEnv(): z.infer<typeof clusterEnvSchema> {
  if (_clusterEnv !== null) return _clusterEnv

  const parsed = clusterEnvSchema.safeParse(process.env)
  if (!parsed.success) {
    const missing = parsed.error.issues.map((i) => i.path.join(".")).join(", ")
    throw new Error(
      `Data-cluster MCP env not configured: ${missing}. ` +
        `Set DATACLUSTER_MCP_URL and CLUSTER_BEARER_TOKEN in .env.local ` +
        `(required when CLUSTER_MODE=real). See .env.example.`,
    )
  }

  _clusterEnv = parsed.data
  return _clusterEnv
}
