/**
 * scripts/e2e/harness.ts — shared primitives for the REAL agent-driven e2es
 * (buffer, spawn, …). Not a unit-test helper: these drive an ACTUAL dev server
 * over SSE (real LLM via the configured gateway → real agent loop → real tool
 * registry → real BnF MCP → real Postgres) and read durable DB evidence.
 *
 * Each e2e script owns its own process, so module-level verdict state here is
 * per-run and safe. Every script must call `requireServer()` first and
 * `printVerdict()` last.
 *
 * Required environment (no silent defaults — which server and which model a
 * paid run targets is the caller's call): E2E_BASE_URL (e.g.
 * http://localhost:3939) and E2E_MODEL (e.g. z-ai/glm-5.2, the app's shipped
 * default). Optional: E2E_TURN_TIMEOUT_MS (positive, default 300 000).
 */
import { z } from "zod"
import { auth } from "@/lib/auth"
import { prisma } from "@/lib/db"
import { LOCALE_HEADER } from "@/lib/constants"
import { routing, type AppLocale } from "@/i18n/routing"

/**
 * A required setting. The harness drives a real server with a real model and
 * spends real money: which server and which model are the caller's decision,
 * stated explicitly, never a silent default.
 */
function requiredEnv(name: string, example: string): string {
  const value = process.env[name]
  if (value === undefined || value.trim() === "") {
    throw new Error(`${name} is not set — e.g. ${name}=${example}`)
  }
  return value.trim()
}

/** Default per-turn wall-clock ceiling: a paginated sweep or a sub-agent legitimately takes a while. */
const DEFAULT_TURN_TIMEOUT_MS = 300_000

function turnTimeoutMs(): number {
  const raw = process.env["E2E_TURN_TIMEOUT_MS"]
  if (raw === undefined) return DEFAULT_TURN_TIMEOUT_MS
  const n = Number(raw)
  if (!Number.isFinite(n) || n <= 0) {
    throw new Error(`E2E_TURN_TIMEOUT_MS must be a positive number of milliseconds, got "${raw}"`)
  }
  return n
}

/** The dev server under test, e.g. `E2E_BASE_URL=http://localhost:3939`. */
export const BASE_URL = requiredEnv("E2E_BASE_URL", "http://localhost:3939").replace(/\/+$/, "")
/** Model id for the OpenRouter gateway, e.g. `E2E_MODEL=z-ai/glm-5.2` (the app's shipped default). */
export const MODEL = requiredEnv("E2E_MODEL", "z-ai/glm-5.2")
/** Per-turn wall-clock ceiling (E2E_TURN_TIMEOUT_MS, validated). */
export const TURN_TIMEOUT_MS = turnTimeoutMs()
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
/** better-auth's error for a sign-up on an existing email, and nothing else. */
const emailTakenErrorSchema = z.object({
  body: z.object({ code: z.literal("USER_ALREADY_EXISTS_USE_ANOTHER_EMAIL") }),
})

function isEmailTaken(err: unknown): boolean {
  return emailTakenErrorSchema.safeParse(err).success
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

/** The frame that ends every turn's stream (chat-sdk server). */
const MESSAGE_END_FRAME = "message-end"

/** An SSE frame: a JSON object with a string `type`. */
const frameSchema = z.object({ type: z.string() }).loose()
type Frame = z.infer<typeof frameSchema>

/** Parse one `data:` payload; anything but a typed JSON object is a protocol failure. */
function parseFrame(raw: string): Frame {
  let json: unknown
  try {
    json = JSON.parse(raw)
  } catch (err) {
    throw new Error(`SSE frame is not JSON: ${raw.slice(0, 200)}`, { cause: err })
  }
  const frame = frameSchema.safeParse(json)
  if (!frame.success) throw new Error(`SSE frame is not a typed object: ${raw.slice(0, 200)}`)
  return frame.data
}

/**
 * One real agent turn over SSE. `locale` is the UI locale the turn is sent
 * under (the research prompt's language). Throws on a transport or protocol
 * failure — a non-JSON or untyped frame, or a stream that does not end with
 * the `message-end` frame — so a broken turn is never scored as a quiet one.
 * An `error` frame is a turn-level failure the caller asserts on.
 */
export async function runTurn(
  sessionId: string,
  cookie: string,
  history: ChatMessage[],
  locale: AppLocale = routing.defaultLocale,
): Promise<TurnResult> {
  const started = Date.now()
  const controller = new AbortController()
  const timer = setTimeout(() => controller.abort(), TURN_TIMEOUT_MS)

  try {
    const res = await fetch(`${BASE_URL}/api/sessions/${sessionId}/messages`, {
      method: "POST",
      headers: { "Content-Type": "application/json", Cookie: cookie, [LOCALE_HEADER]: locale },
      body: JSON.stringify({ sessionId, mode: "claude", messages: history, model: MODEL }),
      signal: controller.signal,
    }).catch((err: unknown) => {
      throw new Error(`turn POST failed: ${err instanceof Error ? err.message : String(err)}`, { cause: err })
    })

    if (!res.ok || !res.body) {
      const body = await res.text()
      throw new Error(`turn POST ${res.status}: ${body.slice(0, 300)}`)
    }

    const frames: Frame[] = []
    const domainEvents: { type: string; data: unknown }[] = []
    const errors: string[] = []
    let text = ""
    let buf = ""

    const decoder = new TextDecoder()
    const reader = res.body.getReader()
    for (;;) {
      const { done, value } = await reader.read()
      if (done) break
      buf += decoder.decode(value, { stream: true })
      let sep: number
      while ((sep = buf.indexOf("\n\n")) !== -1) {
        const block = buf.slice(0, sep)
        buf = buf.slice(sep + 2)
        for (const line of block.split("\n")) {
          if (!line.startsWith("data:")) continue
          const raw = line.slice(5).trim()
          if (!raw || raw === "[DONE]") continue
          const frame = parseFrame(raw)
          frames.push(frame)
          if (frame.type === "text-delta") {
            if (typeof frame["text"] !== "string") throw new Error(`text-delta frame without text: ${raw.slice(0, 200)}`)
            text += frame["text"]
          } else if (frame.type === "error") {
            const message = frame["message"]
            errors.push(typeof message === "string" ? message : `error frame without a message: ${raw.slice(0, 200)}`)
          } else if (frame.type.endsWith("_event")) {
            domainEvents.push({ type: frame.type, data: frame["data"] })
          }
        }
      }
    }

    if (frames.at(-1)?.type !== MESSAGE_END_FRAME) {
      throw new Error(
        `turn stream ended without a ${MESSAGE_END_FRAME} frame (last: ${frames.at(-1)?.type ?? "no frame at all"})`,
      )
    }
    return { text, frames, domainEvents, errors, elapsedMs: Date.now() - started }
  } finally {
    clearTimeout(timer)
  }
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
  return prisma.toolCall.findMany({
    where: { message: { appSessionId: sessionId } },
    orderBy: { createdAt: "asc" },
    select: { tool: true, status: true, input: true, output: true, error: true },
  })
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

/** How the runtime persists a tool result: the stringified result under `content`. */
const storedOutputSchema = z.object({ content: z.string() })
const toolResultObjectSchema = z.record(z.string(), z.unknown())

/**
 * The real tool result as an object. The runtime persists tool output as
 * `{ content: "<stringified result>" }` — a JSON string nested inside a JSON
 * column — so a naive regex over the stringified row sees escaped quotes and
 * silently never matches. Unwrap both layers so assertions read actual fields.
 *
 * Throws when the row has no output, when the content is not JSON, or when it
 * is not an object (a failed tool's text, say): an empty object would make a
 * missing or unreadable result look like a result with no fields. Callers read
 * successful calls, or say what they expect of a failed one.
 */
export function outputData(row: CallRow): Record<string, unknown> {
  if (row.output === null || row.output === undefined) {
    throw new Error(`${row.tool} (${row.status}) has no stored output`)
  }
  const stored = storedOutputSchema.safeParse(row.output)
  let inner: unknown = row.output
  if (stored.success) {
    try {
      inner = JSON.parse(stored.data.content)
    } catch (err) {
      throw new Error(`${row.tool} (${row.status}) output is not JSON: ${stored.data.content.slice(0, 200)}`, {
        cause: err,
      })
    }
  }
  const data = toolResultObjectSchema.safeParse(inner)
  if (!data.success) {
    throw new Error(`${row.tool} (${row.status}) output is not a JSON object: ${JSON.stringify(inner).slice(0, 200)}`)
  }
  return data.data
}
