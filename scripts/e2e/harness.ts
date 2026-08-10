/**
 * scripts/e2e/harness.ts — shared primitives for the REAL agent-driven e2es
 * (buffer, spawn, …). Not a unit-test helper: these drive an ACTUAL dev server
 * over SSE (real LLM via the configured gateway → real agent loop → real tool
 * registry → real BnF MCP → real Postgres) and read durable DB evidence.
 *
 * Each e2e script owns its own process, so module-level verdict state here is
 * per-run and safe. Every script must call `requireServer()` first and
 * `printVerdict()` last.
 */
import { auth } from "@/lib/auth"
import { prisma } from "@/lib/db"
import { LOCALE_HEADER } from "@/lib/constants"

export const BASE_URL = (process.env["E2E_BASE_URL"] ?? "http://localhost:3939").replace(/\/+$/, "")
/** Model id for the OpenRouter gateway. Defaults to the app's shipped default. */
export const MODEL = process.env["E2E_MODEL"] ?? "z-ai/glm-5.2"
/** Per-turn wall-clock ceiling — a paginated sweep / a sub-agent legitimately
 *  takes a while. */
export const TURN_TIMEOUT_MS = Number(process.env["E2E_TURN_TIMEOUT_MS"] ?? 300_000)
/** When set, the caller deletes its throwaway project after the run. */
export const CLEANUP = process.env["E2E_CLEANUP"] === "1" || process.env["E2E_CLEANUP"] === "true"

/** ARK shape the corpus contract mandates (models/corpus/types.ts arkSchema). */
export const ARK_RE = /^ark:\/\d+\/[A-Za-z0-9]+$/

// ---------------------------------------------------------------------------
// Verdict tracking
// ---------------------------------------------------------------------------
export type Verdict = { name: string; ok: boolean; detail: string }
export const verdicts: Verdict[] = []

export function check(name: string, ok: boolean, detail: string): void {
  verdicts.push({ name, ok, detail })
  console.log(`${ok ? "  PASS" : "  FAIL"}  ${name}\n        ${detail}`)
}

export function section(title: string): void {
  console.log(`\n${"=".repeat(72)}\n${title}\n${"=".repeat(72)}`)
}

/** Print the verdict table and set process.exitCode=1 if anything failed. */
export function printVerdict(context: Record<string, string> = {}): void {
  section("VERDICT")
  const failed = verdicts.filter((v) => !v.ok)
  for (const v of verdicts) console.log(`${v.ok ? "PASS" : "FAIL"}  ${v.name}`)
  const ctx = Object.entries(context)
    .map(([k, v]) => `${k}=${v}`)
    .join(" ")
  console.log(`\n${verdicts.length - failed.length}/${verdicts.length} passed${ctx ? `\n${ctx}` : ""}`)
  if (failed.length > 0) {
    console.error(`\n${failed.length} FAILING ASSERTION(S):`)
    for (const f of failed) console.error(`  - ${f.name}\n      ${f.detail}`)
    process.exitCode = 1
  }
}

/** Fail fast if the dev server isn't reachable — otherwise every turn error
 *  looks like a bug. Any HTTP status counts as "up" (the route is auth-gated). */
export async function requireServer(): Promise<void> {
  const health = await fetch(`${BASE_URL}/api/health`, { method: "GET" }).catch(() => null)
  if (health === null) {
    throw new Error(`dev server unreachable at ${BASE_URL} — start it with: PORT=3939 npm run dev`)
  }
}

// ---------------------------------------------------------------------------
// Auth — better-auth round trip, returns the Cookie header for the HTTP calls
// ---------------------------------------------------------------------------
function isEmailTaken(err: unknown): boolean {
  if (err === null || typeof err !== "object") return false
  const e = err as Record<string, unknown>
  const body = e["body"] as Record<string, unknown> | undefined
  return body?.["code"] === "USER_ALREADY_EXISTS_USE_ANOTHER_EMAIL" || e["status"] === "UNPROCESSABLE_ENTITY"
}

export async function signInCookie(email: string, password: string, name: string): Promise<string> {
  try {
    await auth.api.signUpEmail({ body: { email, password, name } })
  } catch (err) {
    if (!isEmailTaken(err)) throw err
  }
  const res = await auth.api.signInEmail({ body: { email, password }, asResponse: true })
  const setCookie = res.headers.getSetCookie?.() ?? []
  if (setCookie.length === 0) throw new Error("sign-in returned no Set-Cookie")
  return setCookie.map((c) => c.split(";")[0]).join("; ")
}

// ---------------------------------------------------------------------------
// One real agent turn over SSE
// ---------------------------------------------------------------------------
export interface ChatMessage {
  role: "user" | "assistant"
  content: string
}
export interface TurnResult {
  text: string
  frames: Record<string, unknown>[]
  domainEvents: { type: string; data: unknown }[]
  errors: string[]
  elapsedMs: number
}

export async function runTurn(
  sessionId: string,
  cookie: string,
  history: ChatMessage[],
): Promise<TurnResult> {
  const started = Date.now()
  const controller = new AbortController()
  const timer = setTimeout(() => controller.abort(), TURN_TIMEOUT_MS)

  const res = await fetch(`${BASE_URL}/api/sessions/${sessionId}/messages`, {
    method: "POST",
    headers: { "Content-Type": "application/json", Cookie: cookie, [LOCALE_HEADER]: "fr" },
    body: JSON.stringify({ sessionId, mode: "claude", messages: history, model: MODEL }),
    signal: controller.signal,
  }).catch((err: unknown) => {
    clearTimeout(timer)
    throw new Error(`turn POST failed: ${err instanceof Error ? err.message : String(err)}`)
  })

  if (!res.ok || !res.body) {
    clearTimeout(timer)
    const body = await res.text().catch(() => "")
    throw new Error(`turn POST ${res.status}: ${body.slice(0, 300)}`)
  }

  const frames: Record<string, unknown>[] = []
  const domainEvents: { type: string; data: unknown }[] = []
  const errors: string[] = []
  let text = ""
  let buf = ""

  const decoder = new TextDecoder()
  try {
    for await (const chunk of res.body as unknown as AsyncIterable<Uint8Array>) {
      buf += decoder.decode(chunk, { stream: true })
      let sep: number
      while ((sep = buf.indexOf("\n\n")) !== -1) {
        const block = buf.slice(0, sep)
        buf = buf.slice(sep + 2)
        for (const line of block.split("\n")) {
          if (!line.startsWith("data:")) continue
          const raw = line.slice(5).trim()
          if (!raw || raw === "[DONE]") continue
          let frame: Record<string, unknown>
          try {
            frame = JSON.parse(raw) as Record<string, unknown>
          } catch {
            continue
          }
          frames.push(frame)
          const type = String(frame["type"] ?? "")
          if (type === "text-delta" && typeof frame["text"] === "string") text += frame["text"]
          else if (type === "error") errors.push(String(frame["message"] ?? "unknown error"))
          else if (type.endsWith("_event")) domainEvents.push({ type, data: frame["data"] })
        }
      }
    }
  } finally {
    clearTimeout(timer)
  }

  return { text, frames, domainEvents, errors, elapsedMs: Date.now() - started }
}

// ---------------------------------------------------------------------------
// Evidence helpers — read what the agent ACTUALLY did from the DB
// ---------------------------------------------------------------------------
export interface CallRow {
  tool: string
  status: string
  input: unknown
  output: unknown
  error: string | null
}

export async function toolCalls(sessionId: string): Promise<CallRow[]> {
  const rows = await prisma.toolCall.findMany({
    where: { message: { appSessionId: sessionId } },
    orderBy: { createdAt: "asc" },
    select: { tool: true, status: true, input: true, output: true, error: true },
  })
  return rows as CallRow[]
}

export function named(calls: CallRow[], tool: string): CallRow[] {
  return calls.filter((c) => c.tool === tool)
}

/** Compact one-line trace of the tool sequence, for the report. */
export function trace(calls: CallRow[]): string {
  if (calls.length === 0) return "(no tool calls)"
  return calls.map((c) => `${c.tool}${c.status === "ok" ? "" : `!${c.status}`}`).join(" → ")
}

export function outputText(row: CallRow | undefined): string {
  if (!row) return ""
  return typeof row.output === "string" ? row.output : JSON.stringify(row.output ?? {})
}

/**
 * The real tool result as an object. The runtime persists tool output as
 * `{ content: "<stringified result>" }` — a JSON string nested inside a JSON
 * column — so a naive regex over the stringified row sees escaped quotes and
 * silently never matches. Unwrap both layers so assertions read actual fields.
 */
export function outputData(row: CallRow | undefined): Record<string, unknown> {
  if (!row) return {}
  const out = row.output
  const inner =
    out !== null && typeof out === "object" && "content" in out
      ? (out as { content?: unknown }).content
      : out
  if (typeof inner === "string") {
    try {
      return JSON.parse(inner) as Record<string, unknown>
    } catch {
      return {}
    }
  }
  return inner !== null && typeof inner === "object" ? (inner as Record<string, unknown>) : {}
}
