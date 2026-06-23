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
  // Gallica browser-handshake relay — OPTIONAL, DEMO STOPGAP. Cloudflare
  // bot-fight-mode on gallica.bnf.fr 403s our server's TLS/HTTP2 fingerprint
  // (a real browser from the same IP passes; the cf_clearance cookie is
  // IP-bound, so injecting a captured cookie does NOT work from the server).
  // When set, the direct metadata resolver (lib/bnf/direct.ts) routes its
  // gallica.bnf.fr calls through this sidecar (curl_cffi Firefox handshake) —
  // the SAME relay the ingest worker uses (worker/gallica-relay.py). Absent →
  // resolver talks to Gallica directly (prod / once the BnF IP-allowlist lands).
  GALLICA_RELAY_URL: z.string().url().optional(),
  // BnF broker — OPTIONAL. The single egress chokepoint for BnF traffic: it
  // owns the OAuth token + the shared 300/min global / 12-per-IP manifest /
  // politeness rate caps + 429 backoff (broker/ service). When set, the
  // metadata resolver (lib/bnf/direct.ts) routes ALL its BnF calls through it
  // (replacing the curl_cffi relay and the IPv4-direct path). Absent → the
  // resolver falls back to its direct/relay transport. The BnF KEY/SECRET live
  // in the broker, NOT here — this is just the broker's URL.
  BNF_BROKER_URL: z.string().url().optional(),
  // Agent provider — which gateway drives the `claude` agent mode (@alien/chat-sdk
  // v0.7+). `anthropic` (default) calls Anthropic directly with ANTHROPIC_API_KEY;
  // `openrouter` routes the same turns + tools + MCP through the OpenRouter gateway
  // (one key for every vendor, access to non-Anthropic models). This is a genuine
  // feature toggle with a safe default — like AUTHENTIK_APP_SLUG — NOT a defaulted
  // secret (CLAUDE_ERROR_PATTERNS §10 forbids defaulting secrets, not toggles).
  // Rollback is a flip back to `anthropic`. The key itself is NOT defaulted; see
  // the superRefine below.
  AGENT_PROVIDER: z.enum(["anthropic", "openrouter"]).default("anthropic"),
  // OpenRouter API key (`sk-or-…`). OPTIONAL at the schema level, but REQUIRED
  // when AGENT_PROVIDER=openrouter — enforced by the superRefine below so the
  // server throws at boot rather than silently defaulting (CLAUDE_ERROR_PATTERNS
  // §10). Ignored under the default `anthropic` provider.
  OPENROUTER_API_KEY: z.string().min(1).optional(),
})
  .superRefine((cfg, ctx) => {
    // No silent default for the OpenRouter key: if the operator selects the
    // openrouter provider, the key MUST be present, or the server refuses to
    // boot. (CLAUDE_ERROR_PATTERNS §10 — secrets are never defaulted/empty.)
    if (cfg.AGENT_PROVIDER === "openrouter" && !cfg.OPENROUTER_API_KEY) {
      ctx.addIssue({
        code: z.ZodIssueCode.custom,
        path: ["OPENROUTER_API_KEY"],
        message:
          "OPENROUTER_API_KEY is required when AGENT_PROVIDER=openrouter " +
          "(set it in .env.local, sk-or-…).",
      })
    }
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
