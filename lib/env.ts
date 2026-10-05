import "server-only"
import { z } from "zod"

// ---------------------------------------------------------------------------
// Boot-time env — required for the server to start.
// ---------------------------------------------------------------------------

/**
 * The boot env schema. Exported for lib/env.test.ts ONLY — the app reads the
 * parsed `env` below, never this schema.
 */
export const bootEnvSchema = z.object({
  DATABASE_URL: z.string().url(),
  BETTER_AUTH_SECRET: z.string().min(32),
  BETTER_AUTH_URL: z.string().url(),
  ANTHROPIC_API_KEY: z.string().min(1),
  APP_URL: z.string().url(),
  // Not read by the app: ingest callbacks are signed with a per-job secret
  // generated at submit time and stored on ingest_job.callback_secret
  // (IngestService.submit, app/api/internal/ingest/[job_id]/progress). The
  // chart still provisions it (secret-app.yaml, kept across upgrades by
  // `lookup`), so it is declared, validated when present, and optional.
  JOB_CALLBACK_SECRET: z.string().min(32).optional(),
  // Langfuse observability — OPTIONAL. When all three are set, @alien/chat-sdk
  // traces every agent turn to Langfuse automatically (the SDK reads these from
  // process.env itself). Absent → tracing is simply off. `LANGFUSE_BASE_URL` is
  // also the base for any future "view trace in Langfuse" deep-link.
  LANGFUSE_PUBLIC_KEY: z.string().min(1).optional(),
  LANGFUSE_SECRET_KEY: z.string().min(1).optional(),
  LANGFUSE_BASE_URL: z.string().url().optional(),
  // Langfuse project id (the cuid in dashboard URLs: /project/<id>/…). Needed to
  // build "view in Langfuse" deep-links (e.g. the admin feedback tab). It is 1:1
  // with the public key; absent → deep-links are simply omitted. Non-secret.
  LANGFUSE_PROJECT_ID: z.string().min(1).optional(),
  // Alien Auth (Authentik OIDC) SSO — OPTIONAL, all or nothing. With the base
  // URL, app slug, client id and secret all set, the Better Auth genericOAuth
  // plugin is wired up, a "Se connecter avec Alien" button appears on the
  // sign-in page and sign-out ends the Authentik session too. With none set
  // the app boots in email/password-only mode. Any other combination refuses
  // to boot (superRefine below): a half-configured SSO used to read as "off"
  // and hide the typo. The Authentik application (`datastreaming`) is shared
  // with the alien-agents demo; the client id/secret are the same credentials.
  AUTHENTIK_BASE_URL: z.string().url().optional(),
  AUTHENTIK_APP_SLUG: z.string().min(1).optional(),
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
  // owns the OAuth token + the ingestion subscription's per-API rate buckets +
  // 429 backoff (broker/ service, broker/README.md). When set, the
  // metadata resolver (lib/bnf/direct.ts) routes ALL its BnF calls through it
  // (replacing the curl_cffi relay and the IPv4-direct path). Absent → the
  // resolver falls back to its direct/relay transport. The BnF KEY/SECRET live
  // in the broker, NOT here — this is just the broker's URL.
  BNF_BROKER_URL: z.string().url().optional(),
  // BnF authenticated partner gateway (proext). Base URL for the OAuth-gated
  // partner API — catalogue SRU, Gallica SRU, SPARQL, IIIF. The metadata resolver
  // (lib/bnf/direct.ts) targets it whenever the broker is configured (the broker
  // mints the bearer + counts quota for this host; see broker isPartnerApi).
  // REQUIRED, no default: it must be the host the broker holds a token for
  // (helm: the app ConfigMap reuses broker.config.apiBaseUrl), and a default
  // pointing at prod would hide a dev or staging misconfiguration.
  BNF_API_BASE_URL: z.string().url(),
  // BnF Presentation API (PRESENTATION_IIIF_GALLICA, its own quota since the
  // Gallica-IIIF split of 2026-09-30) — the base the resolver fetches manifests
  // from, version included (…/presentation/iiif/gallica/1.0.0). Optional at the
  // schema level, REQUIRED whenever BNF_BROKER_URL is set (superRefine below):
  // only the broker path fetches manifests. Helm: bnfIiif.presentationBaseUrl.
  BNF_IIIF_PRESENTATION_BASE_URL: z.string().url().optional(),
  // Agent provider — which gateway drives the `claude` agent mode (@alien/chat-sdk
  // v0.7+). `anthropic` (default) calls Anthropic directly with ANTHROPIC_API_KEY;
  // `openrouter` routes the same turns + tools + MCP through the OpenRouter gateway
  // (one key for every vendor, access to non-Anthropic models). This is a genuine
  // feature toggle with a safe default — NOT a defaulted
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
    // SSO is all or nothing: the four AUTHENTIK_* together, or none of them.
    const authentikVars = {
      AUTHENTIK_BASE_URL: cfg.AUTHENTIK_BASE_URL,
      AUTHENTIK_APP_SLUG: cfg.AUTHENTIK_APP_SLUG,
      AUTHENTIK_CLIENT_ID: cfg.AUTHENTIK_CLIENT_ID,
      AUTHENTIK_CLIENT_SECRET: cfg.AUTHENTIK_CLIENT_SECRET,
    }
    const missing = Object.entries(authentikVars).filter(([, v]) => v === undefined)
    if (missing.length > 0 && missing.length < Object.keys(authentikVars).length) {
      for (const [name] of missing) {
        ctx.addIssue({
          code: z.ZodIssueCode.custom,
          path: [name],
          message:
            `${name} is missing while other AUTHENTIK_* are set: Alien Auth SSO ` +
            "needs all four (or none, for email/password only).",
        })
      }
    }
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
    // The broker path resolves Gallica documents from their manifest, which
    // lives on the Presentation API: a broker without that base would fail
    // every resolution at runtime instead of at boot.
    if (cfg.BNF_BROKER_URL !== undefined && cfg.BNF_IIIF_PRESENTATION_BASE_URL === undefined) {
      ctx.addIssue({
        code: z.ZodIssueCode.custom,
        path: ["BNF_IIIF_PRESENTATION_BASE_URL"],
        message:
          "BNF_IIIF_PRESENTATION_BASE_URL is required when BNF_BROKER_URL is set " +
          "(the resolver fetches manifests from the BnF Presentation API)",
      })
    }
  })

// Throws immediately on process start if any required var is absent / invalid.
// No defaults for secrets, endpoints or identifiers (CLAUDE_ERROR_PATTERNS.md
// §9/§10). The one default is AGENT_PROVIDER, a feature toggle whose default
// is the direct Anthropic gateway; its key is never defaulted (superRefine).
export const env = bootEnvSchema.parse(process.env)

/** The Alien Auth (Authentik) application this deployment signs in against. */
export type AuthentikConfig = {
  baseUrl: string
  appSlug: string
  clientId: string
  clientSecret: string
}

const {
  AUTHENTIK_BASE_URL,
  AUTHENTIK_APP_SLUG,
  AUTHENTIK_CLIENT_ID,
  AUTHENTIK_CLIENT_SECRET,
} = env

/**
 * The Authentik configuration as one typed object, present exactly when SSO
 * is configured (boot already refused a partial set). The narrowing is on the
 * values themselves (no `!`), so nothing can hold an undefined credential.
 * lib/auth.ts (the OAuth plugin) and lib/auth-sso.ts (RP-initiated logout)
 * read this and never touch `env.AUTHENTIK_*` directly.
 */
export const authentik: AuthentikConfig | null =
  AUTHENTIK_BASE_URL && AUTHENTIK_APP_SLUG && AUTHENTIK_CLIENT_ID && AUTHENTIK_CLIENT_SECRET
    ? {
        baseUrl: AUTHENTIK_BASE_URL,
        appSlug: AUTHENTIK_APP_SLUG,
        clientId: AUTHENTIK_CLIENT_ID,
        clientSecret: AUTHENTIK_CLIENT_SECRET,
      }
    : null

// Gates both the server-side genericOAuth plugin (lib/auth.ts) and the sign-in
// button (app/[locale]/sign-in). Derived from `authentik`, so the two cannot
// disagree.
export const ssoEnabled: boolean = authentik !== null

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

/** Whether the BnF MCP is configured at all, configured correctly, or misconfigured. */
export type McpEnvState =
  | { kind: "unconfigured" }
  | { kind: "configured"; env: z.infer<typeof mcpEnvSchema> }
  | { kind: "invalid"; reason: string }

/**
 * The BnF MCP env as a health probe needs to see it: NEITHER variable set is
 * a deployment without the BnF MCP (local dev) — "unconfigured", nothing to
 * probe; anything else that does not validate (one of the two missing, a
 * malformed URL, an empty token) is a broken deployment — "invalid", with
 * the reason; otherwise the validated env.
 */
export function mcpEnvState(): McpEnvState {
  const blank = (v: string | undefined) => v === undefined || v.trim() === ""
  if (blank(process.env.BNF_MCP_URL) && blank(process.env.BNF_MCP_TOKEN)) return { kind: "unconfigured" }
  try {
    return { kind: "configured", env: requireMcpEnv() }
  } catch (err) {
    if (!(err instanceof Error)) throw err
    return { kind: "invalid", reason: err.message }
  }
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

// ---------------------------------------------------------------------------
// BnF MCP rate-limit env — per-minute token-bucket rates for each BnF API
// behind mcp-bnf, plus the bounded wait before a call is shed
// (lib/mcp/rate-limit.ts). NO defaults (CLAUDE_ERROR_PATTERNS §10): the helm
// chart renders every value from `config.bnfMcpRate`, divided by the replica
// count; locally they come from .env.local (see .env.example).
//
// Validated at BOOT whenever BNF_MCP_URL is set (bottom of this file): a
// process that can reach BnF refuses to start unthrottled (incident
// 2026-09-30), rather than discovering the gap on the first agent turn.
// ---------------------------------------------------------------------------

/**
 * Upper bound on BNF_MCP_RATE_MAX_WAIT_MS. A call queued for longer than this
 * holds its tool loop (and its HTTP stream) hostage; one minute is a full BnF
 * quota window, past which waiting cannot buy a token the next window would
 * not.
 */
export const BNF_MCP_RATE_MAX_WAIT_MS_CEILING = 60_000

const bnfRateEnvSchema = z.object({
  BNF_MCP_RATE_GLOBAL_RPM: z.coerce.number().int().positive(),
  BNF_MCP_RATE_CATALOGUE_RPM: z.coerce.number().int().positive(),
  BNF_MCP_RATE_GALLICA_SRU_RPM: z.coerce.number().int().positive(),
  BNF_MCP_RATE_IIIF_RPM: z.coerce.number().int().positive(),
  BNF_MCP_RATE_ISSUES_RPM: z.coerce.number().int().positive(),
  BNF_MCP_RATE_GRAPHE_RPM: z.coerce.number().int().positive(),
  BNF_MCP_RATE_MAX_WAIT_MS: z.coerce.number().int().positive().max(BNF_MCP_RATE_MAX_WAIT_MS_CEILING),
})

export type BnfRateEnv = z.infer<typeof bnfRateEnvSchema>

/**
 * Parse the BNF_MCP_RATE_* values out of `source`. Pure: throws, naming every
 * offending key, when one is absent or invalid.
 */
export function parseBnfRateEnv(source: Record<string, string | undefined>): BnfRateEnv {
  const parsed = bnfRateEnvSchema.safeParse(source)
  if (!parsed.success) {
    const problems = parsed.error.issues.map((i) => `${i.path.join(".")} (${i.message})`).join(", ")
    throw new Error(
      `BnF MCP rate-limit env not configured: ${problems}. ` +
        `Set the seven BNF_MCP_RATE_* variables in .env.local (see .env.example) — ` +
        `in the chart they come from config.bnfMcpRate. The app refuses to call ` +
        `BnF unthrottled.`,
    )
  }
  return parsed.data
}

/** True when this process is configured to reach the BnF MCP at all. */
export function bnfMcpUrlConfigured(source: Record<string, string | undefined> = process.env): boolean {
  const url = source.BNF_MCP_URL
  return typeof url === "string" && url.length > 0
}

/**
 * The boot rule: when `source` sets BNF_MCP_URL, the BNF_MCP_RATE_* values
 * must parse. Pure, so the rule is testable without reloading this module.
 */
export function assertBootBnfRateEnv(source: Record<string, string | undefined>): void {
  if (bnfMcpUrlConfigured(source)) parseBnfRateEnv(source)
}

let _bnfRateEnv: BnfRateEnv | null = null

/**
 * Returns the validated BnF MCP rate-limit env object. Throws on first call if
 * any BNF_MCP_RATE_* value is absent / invalid, naming the offending key(s).
 * Subsequent calls return the cached object.
 */
export function requireBnfRateEnv(): BnfRateEnv {
  if (_bnfRateEnv === null) _bnfRateEnv = parseBnfRateEnv(process.env)
  return _bnfRateEnv
}

// Boot check — see the section comment above.
assertBootBnfRateEnv(process.env)
