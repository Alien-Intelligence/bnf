// lib/agent/compaction-summarizer.ts
// The consumer-supplied `summarize()` callback for the chat-sdk auto-compaction
// stage (agent-context-survival Slice 2). When a long conversation crosses the
// budget, the runtime hands us the OLDEST messages (with any prior synopsis
// folded in as the leading message) and we return a synopsis that stands in for
// them. Same discipline as lib/agent/title.ts: a single, cheap, Haiku-class
// `messages.create` — NOT part of the streaming agent loop.
//
// The synopsis is injected verbatim as one leading user message on every later
// turn, so it MUST preserve what downstream steps depend on: ARKs, folios,
// note-ids, decisions taken, and still-open threads. Citation repair and the
// research agent break if those identifiers are summarised away — hence the
// explicit instruction below. French, to match the working language.
import "server-only"

import Anthropic from "@anthropic-ai/sdk"
import type { ChatMessage } from "@alien/chat-sdk"
import { env } from "@/lib/env"
import { SESSION_TITLE_MODEL, COMPACTION_SUMMARY_MAX_TOKENS } from "@/lib/constants"

const SUMMARY_SYSTEM_PROMPT = `Tu condenses le DÉBUT d'une conversation de recherche (bibliothèque) pour libérer du contexte, sans perdre l'information dont la suite dépend.
Rédige un RÉSUMÉ en français, à la troisième personne, structuré en puces courtes, qui préserve IMPÉRATIVEMENT :
- les décisions prises et le périmètre convenu (sujet, période, langues, sources) ;
- TOUS les identifiants cités : ARK (ark:/12148/...), folios, et identifiants de notes — ne les invente jamais, ne les tronque jamais ;
- les recherches déjà menées et leur résultat en une ligne (pour ne pas les relancer) ;
- les fils encore ouverts / la prochaine étape attendue.
N'ajoute aucune information nouvelle. Ne commente pas la tâche de résumé. Réponds UNIQUEMENT par le résumé.`

/** Cap on how much transcript we feed the summariser — the older region can be
 *  large; the opening + identifiers are what matter, and Haiku is cheap but not
 *  free. Older messages beyond this are truncated (their content is already
 *  low-signal history). */
const TRANSCRIPT_MAX_CHARS = 60_000
/** Hard wall-clock ceiling (CLAUDE_ERROR_PATTERNS §14). */
const SUMMARY_TIMEOUT_MS = 30_000

/** Flatten the messages into a plain transcript for the summariser. */
function toTranscript(messages: ChatMessage[]): string {
  const lines: string[] = []
  for (const m of messages) {
    const role = m.role === "user" ? "UTILISATEUR" : "ASSISTANT"
    if (m.content) lines.push(`### ${role}\n${m.content}`)
    for (const tc of m.toolCalls ?? []) {
      // Tool calls often carry the ARKs/folios we must preserve — include a
      // compact record of name + input so identifiers survive into the synopsis.
      lines.push(`### OUTIL ${tc.toolName}\n${JSON.stringify(tc.input ?? {})}`)
    }
  }
  return lines.join("\n\n")
}

/**
 * Summarise the older region of a conversation into a synopsis string. Mirrors
 * generateSessionTitle: direct Anthropic Haiku call, bounded, gateway-independent
 * (uses ANTHROPIC_API_KEY even when the agent itself runs on OpenRouter — this
 * is a cheap side call, not an agent turn). Throws on transport failure; the SDK
 * compaction stage catches it and falls back to the full history.
 */
export async function summarizeForCompaction(messages: ChatMessage[]): Promise<string> {
  const transcript = toTranscript(messages).slice(0, TRANSCRIPT_MAX_CHARS)
  if (!transcript.trim()) return ""

  const client = new Anthropic({ apiKey: env.ANTHROPIC_API_KEY })
  const response = await client.messages.create(
    {
      model: SESSION_TITLE_MODEL,
      max_tokens: COMPACTION_SUMMARY_MAX_TOKENS,
      system: SUMMARY_SYSTEM_PROMPT,
      messages: [{ role: "user", content: transcript }],
    },
    { timeout: SUMMARY_TIMEOUT_MS, maxRetries: 1 },
  )

  const text = response.content
    .filter((b): b is Anthropic.TextBlock => b.type === "text")
    .map((b) => b.text)
    .join("")
    .trim()

  // A leading marker makes the injected synopsis legible to the model as
  // condensed history rather than a fresh user request.
  return text ? `[RÉSUMÉ DES ÉCHANGES PRÉCÉDENTS]\n\n${text}` : ""
}
