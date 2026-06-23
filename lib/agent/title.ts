// lib/agent/title.ts
// One-shot, Haiku-class naming of a research/corpus session from its first user
// message. This is NOT part of the streaming agent loop — it's a single
// `messages.create` call with a tiny output, fired (best-effort) the first time
// a session receives a message. See SessionService.maybeAutoTitle for the gate.
import "server-only"

import Anthropic from "@anthropic-ai/sdk"
import { env } from "@/lib/env"
import { SESSION_TITLE_MODEL } from "@/lib/constants"

const TITLE_SYSTEM_PROMPT = `Tu nommes une session de recherche à partir de la première question d'un chercheur.
Réponds UNIQUEMENT par un titre court en français — 2 à 6 mots, sans guillemets, sans ponctuation finale, sans préfixe.
Le titre doit capturer le sujet de la question, pas la reformuler intégralement.`

/** A short title is a handful of tokens — cap tightly. */
const TITLE_MAX_TOKENS = 32
/** Hard wall-clock ceiling on the call (CLAUDE_ERROR_PATTERNS §14). */
const TITLE_TIMEOUT_MS = 15_000
/** Mirrors updateSessionSchema's max so a generated title is always renamable. */
const TITLE_MAX_LENGTH = 100
/** No point sending a whole essay to name it — the opening is enough. */
const FIRST_MESSAGE_MAX_CHARS = 2_000

/**
 * Generate a short French title for a session from its first user message.
 * Returns the trimmed title, or `null` when the message is empty or the model
 * returns nothing usable. Throws on a transport/API failure — callers decide
 * whether that's fatal (it isn't, for auto-naming).
 */
export async function generateSessionTitle(
  firstMessage: string,
): Promise<string | null> {
  const trimmed = firstMessage.trim()
  if (!trimmed) return null

  const client = new Anthropic({ apiKey: env.ANTHROPIC_API_KEY })
  const response = await client.messages.create(
    {
      model: SESSION_TITLE_MODEL,
      max_tokens: TITLE_MAX_TOKENS,
      system: TITLE_SYSTEM_PROMPT,
      messages: [{ role: "user", content: trimmed.slice(0, FIRST_MESSAGE_MAX_CHARS) }],
    },
    { timeout: TITLE_TIMEOUT_MS, maxRetries: 1 },
  )

  const text = response.content
    .filter((b): b is Anthropic.TextBlock => b.type === "text")
    .map((b) => b.text)
    .join("")

  // Strip wrapping quotes / guillemets and trailing punctuation the model may
  // add despite the instruction, then clamp to the schema's title length.
  const cleaned = text
    .replace(/^[\s"'«»]+/, "")
    .replace(/[\s"'«».]+$/, "")
    .slice(0, TITLE_MAX_LENGTH)
    .trim()

  return cleaned || null
}
