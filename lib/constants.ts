// lib/constants.ts
// Cross-cutting string/number constants for the BnF Corpus Research app.
// Rule: no magic numbers in routes, services, or components — import from here.
// See playbook/constants.md.

// ---------------------------------------------------------------------------
// Routes — single source of truth for in-app navigation paths.
// Locale prefix is handled by next-intl's <Link>; these are locale-agnostic.
// ---------------------------------------------------------------------------

export const ROUTES = {
  projects: "/projects",
  constituer: (projectId: string) => `/projects/${projectId}/constituer`,
  ingerer: (projectId: string) => `/projects/${projectId}/ingerer`,
  rechercher: (projectId: string) => `/projects/${projectId}/rechercher`,
  carnet: (projectId: string) => `/projects/${projectId}/rechercher/carnet`,
  adminUsage: "/admin/usage",
  signIn: "/sign-in",
  signUp: "/sign-up",
} as const

/**
 * The three workspace steps, in order. The header step-nav and any progress
 * affordance derive their sequence from this list. `key` matches the route
 * segment and the `nav.*` i18n key.
 */
export const WORKSPACE_STEPS = ["constituer", "ingerer", "rechercher"] as const
export type WorkspaceStep = (typeof WORKSPACE_STEPS)[number]

// ---------------------------------------------------------------------------
// Authentication — Alien Auth (Authentik) SSO.
// ---------------------------------------------------------------------------

/**
 * Better Auth genericOAuth provider id for Alien Auth (Authentik). Shared
 * verbatim with the alien-agents demo so the OAuth callback path
 * (`/api/auth/oauth2/callback/authentik`) matches the redirect URI registered
 * on the shared Authentik application. Used server-side (lib/auth.ts) and
 * client-side (the sign-in button).
 */
export const OAUTH_PROVIDER_ID = "authentik"

// ---------------------------------------------------------------------------
// Layout geometry — prototype proportions (BnF Corpus Research.dc.html).
// Kept here so no screen hard-codes a magic width/ratio in JSX.
// ---------------------------------------------------------------------------

/** Sessions / picker rail width (prototype: 262px aside). */
export const SESSIONS_RAIL_WIDTH = "16.375rem" // 262px
/** Chat / workspace split on Step 1 — chat 40%, comprehension 60% (doc 01). */
export const CHAT_WORKSPACE_SPLIT = "40% 60%"
/** Document-detail / citation source side panel width (prototype: 380px). */
export const SIDE_PANEL_WIDTH = "23.75rem" // 380px
/** Research chat / reader split on Step 3 — chat 40%, reader 60% (prototype). */
export const RESEARCH_CHAT_SPLIT = "40% 60%"

// ---------------------------------------------------------------------------
// RAG cluster — the data-cluster the corpus is indexed into. Single-cluster
// for now; shown in the research espace sub-header beside the doc count.
// (Prototype label: "cluster-bnf-rag-01 · N docs".)
// ---------------------------------------------------------------------------

export const RAG_CLUSTER_ID = "cluster-bnf-rag-01"

// ---------------------------------------------------------------------------
// Facet bar colors — the 7-hue dataset palette as CSS custom properties.
// Used by the corpus comprehension panel to color-code document types and
// distribution bars (dark-first; the pastel badge classes are light-mode only).
// Mapping mirrors design/BnF Corpus Research.dc.html TYPES (lines 917-925).
// ---------------------------------------------------------------------------

export const DATASET_COLOR_CYCLE = [
  "var(--dataset-1)",
  "var(--dataset-2)",
  "var(--dataset-3)",
  "var(--dataset-4)",
  "var(--dataset-5)",
  "var(--dataset-6)",
  "var(--dataset-7)",
] as const

/** Fixed type → dataset hue mapping from the prototype. */
export const TYPE_DATASET_COLOR: Record<string, string> = {
  press: "var(--dataset-3)",
  image: "var(--dataset-1)",
  estampe: "var(--dataset-6)",
  book: "var(--dataset-2)",
  map: "var(--dataset-4)",
  manuscript: "var(--dataset-7)",
  enlum: "var(--dataset-1)",
  charte: "var(--dataset-4)",
}

/**
 * Number of documents per page in a CorpusSnapshot.
 * Also used as the initial sample size when no pagination cursor is provided.
 * Applies to both the slice-1 "first 25" preview and the slice-2 paginated
 * list (cursor-based pagination uses the same page size).
 */
export const CORPUS_SAMPLE_SIZE = 25

/**
 * The seq assigned to the first (empty) CorpusVersion created by
 * ProjectService.create(). Invariant 1: every project always has a head.
 */
export const PROJECTS_INITIAL_VERSION_SEQ = 1

// ---------------------------------------------------------------------------
// BnF MCP concurrency + retry tuning
// ---------------------------------------------------------------------------

// ---------------------------------------------------------------------------
// Chat streaming presentation
// ---------------------------------------------------------------------------

/**
 * Cadence (ms) of the client-side reveal that smooths chunky model deltas into
 * a steady word-by-word "typewriter" cadence — mirrors the @alien/chat-sdk
 * smoother default (25ms / word). See components/layouts/corpus/streaming-markdown.tsx.
 */
export const CHAT_STREAM_REVEAL_MS = 25

/**
 * MCP protocol version sent in the `initialize` handshake. The BnF MCP
 * (mcp-base) is a *stateful* Streamable-HTTP server: it issues an
 * `Mcp-Session-Id` on initialize that every subsequent request must echo, or
 * it replies `400 Missing session ID`. See lib/mcp/session.ts.
 */
export const MCP_PROTOCOL_VERSION = "2025-06-18"

/** clientInfo sent in the MCP `initialize` handshake. */
export const MCP_CLIENT_NAME = "bnf-corpus-research"
export const MCP_CLIENT_VERSION = "0.1.0"

/** Maximum number of in-flight MCP calls when resolving a batch of ARKs. */
export const BNF_MCP_CONCURRENCY = 8

/** Max in-flight DIRECT HTTP calls when resolving a batch of ARKs.
 * Lower than BNF_MCP_CONCURRENCY: the direct path hits the public
 * gallica.bnf.fr / catalogue.bnf.fr endpoints, and catalogue.bnf.fr's SRU
 * rate-limits (HTTP 429) aggressive bursts. Keep it gentle. */
export const BNF_DIRECT_CONCURRENCY = 4

/** Total call attempts (1 initial + N-1 retries) per MCP request. */
export const BNF_MCP_RETRY_ATTEMPTS = 3

/** Base retry delay in ms (before jitter). Doubles on each attempt. */
export const BNF_MCP_RETRY_BASE_MS = 500

/** Maximum retry delay cap in ms (before jitter). */
export const BNF_MCP_RETRY_CAP_MS = 8_000

/**
 * Per-attempt wall-clock ceiling for a single MCP HTTP call (handshake or
 * tools/call). Bounds every MCP `await` so a stalled transport cannot hang the
 * agent turn or the seed indefinitely (CLAUDE_ERROR_PATTERNS §14). Applied per
 * retry attempt, combined with the caller's turn AbortSignal.
 */
export const BNF_MCP_TIMEOUT_MS = 30_000

// ---------------------------------------------------------------------------
// Data-cluster MCP (real RAG) — see lib/cluster/datacluster-mcp-client.ts
// Same Streamable-HTTP / JSON-RPC contract as the BnF MCP (shared session +
// retry helpers in lib/mcp/), so the protocol/client constants above are
// reused; only the retry/timeout tuning is restated for clarity.
// ---------------------------------------------------------------------------

/** Total call attempts (1 initial + N-1 retries) per data-cluster MCP request. */
export const DATACLUSTER_MCP_RETRY_ATTEMPTS = 3

/** Base retry delay in ms (before jitter). Doubles on each attempt. */
export const DATACLUSTER_MCP_RETRY_BASE_MS = 500

/** Maximum retry delay cap in ms (before jitter). */
export const DATACLUSTER_MCP_RETRY_CAP_MS = 8_000

/**
 * Per-attempt wall-clock ceiling for a single data-cluster MCP HTTP call.
 * Bounds every await so a stalled transport cannot hang the research turn
 * (CLAUDE_ERROR_PATTERNS §14). Vector search is typically < 100ms server-side.
 */
export const DATACLUSTER_MCP_TIMEOUT_MS = 30_000

/** Slug prefix of a project's data-cluster dataset: `bnf-<projectId>`. */
export const DATACLUSTER_DATASET_SLUG_PREFIX = "bnf-"

/** Page size used when listing datasets to resolve a project's dataset id. */
export const DATACLUSTER_LIST_PAGE_SIZE = 100

/** Default number of passages requested per RAG query when the agent omits k. */
export const RAG_DEFAULT_K = 12

// ---------------------------------------------------------------------------
// Background document metadata resolution (the Document table is the queue)
// ---------------------------------------------------------------------------

/**
 * How many times the resolver retries a single ARK before flipping it to
 * `failed`. A transient MCP outage increments the attempt count but leaves the
 * row `pending` until this ceiling is reached, so it is retried on the next
 * kick / boot resume.
 */
export const RESOLVE_MAX_ATTEMPTS = 5

/** ARKs resolved per drainer batch (one MCP fan-out; ≤ MCP 50-hit cap). */
export const RESOLVE_BATCH_SIZE = 30

/**
 * Safety bound on the drain loop: at most this many batches per drain run, so a
 * single invocation can never spin unboundedly (CLAUDE_ERROR_PATTERNS §14).
 * Anything still pending after this is picked up by the next kick / boot.
 */
export const RESOLVE_DRAIN_MAX_BATCHES = 50

/**
 * Cadence of the background resolve sweep. `corpus_add` kicks a drain and boot
 * resumes one, but a transient BnF outage (e.g. a 429 burst on catalogue.bnf.fr)
 * leaves rows `pending` with no further trigger — they would never recover
 * without a new add or a restart. This periodic sweep re-drains any project with
 * pending stubs so resolution is self-healing. Each pass increments
 * resolveAttempts, so a genuinely-unresolvable ARK still terminates at
 * RESOLVE_MAX_ATTEMPTS. 3 min: prompt recovery without hammering BnF.
 */
export const RESOLVE_SWEEP_INTERVAL_MS = 3 * 60 * 1_000

/**
 * How often the comprehension panel re-fetches the corpus snapshot while
 * documents are still resolving in the background, so newly-resolved titles /
 * facets appear without a manual refresh. Polling stops once pendingCount is 0.
 */
export const CORPUS_RESOLVE_POLL_MS = 4_000

// ---------------------------------------------------------------------------
// Direct BnF HTTP client (lib/bnf/direct.ts)
// ---------------------------------------------------------------------------
// Metadata resolution fetches gallica.bnf.fr / catalogue.bnf.fr DIRECTLY rather
// than through the BnF MCP, whose Gallica path routes via the platform
// External-API Gateway connector (a flaky extra hop that returns "Connection
// failed" when the connector is down). gallica.bnf.fr sits behind Cloudflare,
// which 403s default clients and rejects the IPv6 TLS handshake here — so the
// direct client pins IPv4 and sends a browser User-Agent.

/** Browser-like UA so Cloudflare does not 403 direct gallica.bnf.fr requests. */
export const BNF_USER_AGENT =
  "Mozilla/5.0 (X11; Linux x86_64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/124.0.0.0 Safari/537.36"

/** Per-attempt wall-clock ceiling for a single direct BnF HTTP call. */
export const BNF_HTTP_TIMEOUT_MS = 30_000

/**
 * Overall wall-clock budget for canonicalizing a batch of catalogue (`cb…`)
 * ARKs to their digitized Gallica equivalent at corpus-add time
 * (BnfDirectClient.canonicalizeArks). This runs SYNCHRONOUSLY in the add path
 * (it changes which ARK becomes the corpus member, so it cannot be deferred to
 * the background resolver), and it is strictly best-effort: when the budget
 * elapses, every still-in-flight lookup aborts and those notices are added
 * as-is. Kept short so a slow/stalled data.bnf.fr can never hang an add
 * (CLAUDE_ERROR_PATTERNS §14). Only `cb…` ARKs incur this; Gallica adds skip it.
 */
export const BNF_CANONICALIZE_BUDGET_MS = 12_000

// ---------------------------------------------------------------------------
// Agent runtime
// ---------------------------------------------------------------------------

/** Claude model id used for both the corpus and research agent loops.
 * Must be a Sonnet-class model per the design spec (design/docs/08-prompting).
 * A bare Claude id is auto-namespaced to `anthropic/claude-sonnet-4-6` under the
 * OpenRouter provider (@alien/chat-sdk), so this constant serves both providers. */
export const AGENT_MODEL = "claude-sonnet-4-6"

/** App-attribution name sent to OpenRouter as the `X-Title` header (shown on the
 * OpenRouter dashboard). Only used when AGENT_PROVIDER=openrouter; ignored under
 * the direct-Anthropic provider. The companion `HTTP-Referer` (site URL) is
 * derived from `env.APP_URL` in the chat handler — it is NOT a constant here
 * because constants.ts is client-safe and must never import the server-only env. */
export const OPENROUTER_APP_NAME = "Alien × BnF"

/**
 * The curated allow-list of models the UI selector may pick from — ONLY meaningful
 * under AGENT_PROVIDER=openrouter (the selector is hidden under the anthropic
 * provider). An explicit allow-list, not free text, so a tester can never route
 * to an arbitrary / mistyped model (uncontrolled spend, hard 4xx). Every `id` is
 * an OpenRouter `vendor/model` slug verified live against the gateway's model
 * list. `labelKey` is an i18n key under the `models` namespace (NOT the raw id —
 * ids carry dots/slashes that collide with next-intl's key nesting); the display
 * name lives in messages/{fr,en}.json. The first entry is the default.
 */
export const AGENT_AVAILABLE_MODELS = [
  { id: "anthropic/claude-sonnet-4.6", labelKey: "claudeSonnet46" },
  { id: "z-ai/glm-5.2", labelKey: "glm52" },
  { id: "google/gemini-3.5-flash", labelKey: "gemini35Flash" },
  { id: "mistralai/mistral-medium-3-5", labelKey: "mistralMedium35" },
  { id: "qwen/qwen3.7-max", labelKey: "qwen37Max" },
  { id: "deepseek/deepseek-v4-pro", labelKey: "deepseekV4Pro" },
] as const

export type AgentModelId = (typeof AGENT_AVAILABLE_MODELS)[number]["id"]

/** Which gateway drives the agent — mirrors the `AGENT_PROVIDER` env enum, but
 * declared here (client-safe) so client components can be typed by it without
 * importing the server-only `env`. The page reads `env.AGENT_PROVIDER` and
 * passes it down as a prop. */
export type AgentProvider = "anthropic" | "openrouter"

/** Default selected model under the openrouter provider — the first allow-list
 * entry (Claude Sonnet 4.6, OpenRouter's canonical id). The set of valid ids is
 * AGENT_AVAILABLE_MODELS; this is the one pre-selected in the dropdown. Distinct
 * from AGENT_MODEL (the bare `claude-sonnet-4-6` the direct-Anthropic path uses):
 * here the id is already vendor-namespaced for the gateway. */
export const AGENT_DEFAULT_MODEL: AgentModelId = AGENT_AVAILABLE_MODELS[0].id

/** Hard cap on tool-loop iterations per turn — a runaway-loop backstop, NOT a
 * working limit. Set well above any legitimate research/corpus turn (which
 * chains search → resolve → add → memory → note, realistically well under 20)
 * so normal work never trips it, while a stuck/looping agent still gets stopped
 * (CLAUDE_ERROR_PATTERNS §14: no unbounded loops). The chat-sdk default is 12;
 * passed to the runner as `maxToolTurns`. */
export const AGENT_MAX_ITERATIONS = 100

// ---------------------------------------------------------------------------
// Session auto-naming
// ---------------------------------------------------------------------------

/** Claude model used to name a session from its first user message. Haiku-class
 * because this is a cheap, one-shot summarization — not an agent loop. See
 * lib/agent/title.ts. */
export const SESSION_TITLE_MODEL = "claude-haiku-4-5"

/** Title a session opened from the rail's "+" is born with, until its first
 * message auto-names it. French-first, matching the default locale. */
export const DEFAULT_SESSION_TITLE = "Nouvelle session"

/** Title the very first session of a project's scope is seeded with on first
 * render (SessionService.ensureDefaultForScope). */
export const FIRST_SESSION_TITLE = "Première session"

/** The placeholder titles auto-naming is allowed to overwrite. A session whose
 * title is none of these has been named (by the user, or by a prior auto-title)
 * and is left untouched. */
export const AUTO_TITLE_PLACEHOLDERS: readonly string[] = [
  DEFAULT_SESSION_TITLE,
  FIRST_SESSION_TITLE,
]

// ---------------------------------------------------------------------------
// Reaper tuning
// ---------------------------------------------------------------------------

/** Maximum age (ms) of a running turn before the reaper aborts it.
 * 30 minutes: generous enough for a large corpus ingestion MCP call but
 * short enough to catch runaway turns before they exhaust memory. */
export const TURN_REAP_TTL_MS = 30 * 60 * 1_000

/** How often the reaper runs its cycle (ms).
 * 5 minutes: frequent enough to catch orphaned DB rows promptly. */
export const REAPER_INTERVAL_MS = 5 * 60 * 1_000

// ---------------------------------------------------------------------------
// Corpus live-refresh
// ---------------------------------------------------------------------------

/**
 * Debounce window (ms) before invalidating corpus queries after a
 * `corpus_event` arrives from the agent stream.
 * Prevents a rapid sequence of add/remove calls from triggering multiple
 * refetches — only the trailing edge fires.
 */
export const CORPUS_REFRESH_DEBOUNCE_MS = 500

// ---------------------------------------------------------------------------
// Ingest polling
// ---------------------------------------------------------------------------

/**
 * How often the client polls GET /api/ingest/:job_id while the job is in a
 * non-terminal state (queued | running). Stops automatically on done/failed/
 * canceled via TanStack Query's refetchInterval stop condition.
 * Prefer the SSE stream (/api/ingest/:job_id/stream) for real-time progress;
 * polling is the fallback for environments where long-lived connections drop.
 */
export const INGEST_POLL_INTERVAL_MS = 2_000

/**
 * Maximum number of recent jobs to return from IngestQueries.listForProject
 * for the Ingérer page job history panel.
 */
export const INGEST_RECENT_JOBS_LIMIT = 20

// ---------------------------------------------------------------------------
// BnF IIIF / Gallica URL templates
// ---------------------------------------------------------------------------
// These are the single source of truth for all external BnF links.
// Never construct these URLs inline — always use the functions below.
// See playbook/citations.md § "External URLs — derived only".

// `ark` is the full canonical form "ark:/12148/<id>" throughout.
//
// NOTE: the BARE document URL `https://gallica.bnf.fr/<ark>` is NOT reliable —
// Gallica returns 403 "Accès interdit" for it on some documents. Link to the
// page-level viewer URL instead (GALLICA_ITEM_URL → `…/<ark>/f1.item`), which is
// stable. The `.r=<q>?rk=<rank>` form you see in the address bar carries a
// search-result rank cursor that cannot be reconstructed, so don't build it.

/** Gallica IIIF (Universal) viewer for a document. */
export function GALLICA_IIIF_VIEWER_URL(ark: string): string {
  return `https://gallica.bnf.fr/view3if/ga/${ark}`
}

/** OAI-PMH Dublin Core record for a Gallica document. */
export function GALLICA_OAI_URL(ark: string): string {
  return `http://oai.bnf.fr/oai2/OAIHandler?verb=GetRecord&metadataPrefix=oai_dc&identifier=oai:bnf.fr:gallica/${ark}`
}

/** BnF Catalogue général notice page (for non-digitized `cb…` records). */
export function CATALOGUE_RECORD_URL(ark: string): string {
  return `https://catalogue.bnf.fr/${ark}`
}

/** Gallica classic item page deep-linked to a folio (vue). */
export function GALLICA_ITEM_URL(ark: string, folio: number): string {
  return `https://gallica.bnf.fr/${ark}/f${folio}.item`
}

/** IIIF Image API URL for a given ARK + folio. Path is
 *  `/iiif/<ark>/f<N>/<region>/<size>/<rotation>/<quality>.<format>` — region
 *  and size both default to "full". */
export function IIIF_IMAGE_URL(ark: string, folio: number, size = "full"): string {
  return `https://gallica.bnf.fr/iiif/${ark}/f${folio}/full/${size}/0/native.jpg`
}

/** IIIF size (`{width},` syntax) for a folio image embedded in a note figure.
 * Constrained so a full press-page scan isn't fetched at native resolution;
 * the source panel uses a smaller `200,` thumbnail. */
export const NOTE_IMAGE_IIIF_SIZE = "843,"

/** IIIF manifest URL for a given ARK. */
export function IIIF_MANIFEST_URL(ark: string): string {
  return `https://gallica.bnf.fr/iiif/${ark}/manifest.json`
}
