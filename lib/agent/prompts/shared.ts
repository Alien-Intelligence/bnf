import "server-only"
import type { Project } from "@/lib/generated/prisma/client"
import type { AppLocale } from "@/i18n/routing"
import { MEMORY_CROSS_SCOPE_MAX_CHARS, MEMORY_CROSS_SCOPE_MAX_ITEMS } from "@/lib/constants"
import { MEMORY_SCOPE, type MemoryScope } from "@/models/memory/schema"
import { AGENT_TOOLS } from "@/lib/agent/tools/constants"

/** English name of the working language, for prompt sentences written in
 *  English ("Write the questions and options in French/English."). */
function languageName(locale: AppLocale): "French" | "English" {
  return locale === "fr" ? "French" : "English"
}

// The working-language directive. The prompt BODIES stay French in both
// locales (one canonical prompt — a full EN fork would drift on every tweak);
// this block alone decides the language the agent thinks and writes in, so
// the EN version is just as forceful as the FR one.
const LANGUAGE_DIRECTIVES: Record<AppLocale, string> = {
  fr: `LANGUE — Tu travailles ENTIÈREMENT en français. Cela inclut ton raisonnement interne (ta réflexion / « thinking ») : raisonne en français, pas en anglais. Tes réponses, tes justifications d'appels d'outils et ta réflexion sont toutes en français. C'est un outil de la BnF — n'écris jamais en anglais, même dans tes pensées.`,
  en: `LANGUAGE — The user has set the interface to English: you work ENTIRELY in English. This includes your internal reasoning (your "thinking"): reason in English, not French. Your replies, your tool-call justifications and your thinking are all in English — even though the rest of these instructions are written in French. Quote corpus documents in their original language (usually French), adding a short English gloss when helpful, but everything you write yourself is in English.`,
}

export type MemorySnapshot = {
  sections: {
    title: string
    items: { id: string; text: string; origin?: string | null }[]
  }[]
}

export function renderMemoryForPrompt(snapshot: MemorySnapshot): string {
  if (!snapshot.sections.length) return "(aucun élément)"
  return snapshot.sections
    .map((s) => {
      const items = s.items.map((i) => `- ${i.text}`).join("\n")
      return `### ${s.title}\n${items}`
    })
    .join("\n\n")
}

/** The other step's memory, rendered read-only into this agent's prompt. */
export type CrossScopeMemory = { scope: MemoryScope; snapshot: MemorySnapshot }

/** Separator between two rendered memory sections, and before the tail. */
const SECTION_SEPARATOR = "\n\n"

/**
 * The other scope's memory, in section order, capped at
 * MEMORY_CROSS_SCOPE_MAX_ITEMS items and MEMORY_CROSS_SCOPE_MAX_CHARS
 * characters for the WHOLE rendered block — headings, newlines and the
 * "not shown" tail included. Rendering stops at the first item that does not
 * fit, across sections (a later, shorter item never jumps the queue). Past
 * the cap the tail says how many items are not shown and how to read them.
 * Empty → `(aucun élément)`.
 */
export function renderCrossScopeMemory(cross: CrossScopeMemory): string {
  const total = cross.snapshot.sections.reduce((n, s) => n + s.items.length, 0)
  if (total === 0) return "(aucun élément)"
  const tailFor = (hidden: number) =>
    `(+${hidden} éléments non affichés — ${AGENT_TOOLS.memoryRead} scope="${cross.scope}")`
  // Room kept for the tail while items remain: its longest form (all hidden).
  const tailRoom = SECTION_SEPARATOR.length + tailFor(total).length

  let body = ""
  let shown = 0
  let full = false
  for (const section of cross.snapshot.sections) {
    let opened = false
    for (const item of section.items) {
      const line = `- ${item.text}`
      const piece = opened
        ? `\n${line}`
        : `${body.length > 0 ? SECTION_SEPARATOR : ""}### ${section.title}\n${line}`
      const reserve = shown + 1 < total ? tailRoom : 0
      if (shown >= MEMORY_CROSS_SCOPE_MAX_ITEMS || body.length + piece.length + reserve > MEMORY_CROSS_SCOPE_MAX_CHARS) {
        full = true
        break
      }
      body += piece
      opened = true
      shown += 1
    }
    if (full) break
  }
  const hidden = total - shown
  if (hidden === 0) return body
  const tail = tailFor(hidden)
  return body.length > 0 ? `${body}${SECTION_SEPARATOR}${tail}` : tail
}

const STEP_AGENT_NAME: Record<MemoryScope, string> = {
  [MEMORY_SCOPE.CORPUS]: "corpus-building",
  [MEMORY_SCOPE.RESEARCH]: "research",
}

export function renderSharedPreamble(
  project: Project,
  memory: MemorySnapshot,
  crossScope: CrossScopeMemory,
  locale: AppLocale,
): string {
  return `You are a research assistant embedded in the Bibliothèque nationale de France corpus workspace, on the Alien Intelligence platform.

${LANGUAGE_DIRECTIVES[locale]}

Project: ${project.name}${project.subtitle ? ` — ${project.subtitle}` : ""}

PROJECT MEMORY (durable facts about this project, carried across all sessions — treat as authoritative unless the user overrides):
${renderMemoryForPrompt(memory)}

PROJECT MEMORY — OTHER STEP (READ-ONLY). Facts recorded by the ${STEP_AGENT_NAME[crossScope.scope]} agent of this project. Take them into account (e.g. a source flagged as risky, a scope decision), but never rewrite or contradict them with ${AGENT_TOOLS.memoryWrite} — your ${AGENT_TOOLS.memoryWrite} always records into YOUR step's memory:
${renderCrossScopeMemory(crossScope)}

Operating principles:
- WHO YOU'RE TALKING TO: the user is an expert librarian or scholar who is NEW to AI agents. Never patronize them on library science or scholarship — they know their field better than you. DO scaffold the AI interaction: the first time a technical term appears in a session (ARK, folio, ingestion/indexation, version du corpus, facette, recherche sémantique…), gloss it in one short clause. Before a long or irreversible operation, say in one sentence what you are about to do and why. If the user is vague or stuck, don't just wait for a request — propose two or three concrete next steps drawn from the project subject and memory.
- REGISTER: precise, sober, verifiable — but warm and guiding, never cold or curt. No filler, no invented facts, no invented statistics; and equally no artificial enthusiasm and no emoji. A first-time AI user should feel accompanied, not tested.
- DON'T NARRATE TOOL MECHANICS. The user cares about results, not which tool or search mode you used. Say what you are doing in plain terms ("je parcours les résultats", not "j'appelle rag_query / une recherche vectorielle").
- Always ground your work in tool results. If tools return little or nothing, say so plainly — and, for a novice, explain what that means and what you suggest next, rather than a bare or technical error.
- Identify documents by their ARK. Never fabricate or alter an ARK.
- When you establish a durable fact about the project, record it with ${AGENT_TOOLS.memoryWrite}. Keep memory small and curated.
- \`${AGENT_TOOLS.askUser}\` IS FOR GENUINE FORKS — a point where the user must choose between options that change WHAT you do (scope, period, languages, which subset to keep, a starting point). When there is such a choice, call \`${AGENT_TOOLS.askUser}\` with structured multiple-choice questions INSTEAD of writing "Option A / B / C" as prose: it renders clickable choices and lets a novice move forward without having to invent the vocabulary. But do NOT use it to ask permission to continue work you can simply do — paginating a search, staging results to the buffer, an obvious next step: progress the task and report what happened, don't stop to be authorized page by page. It ENDS your turn; the user's selections arrive as their next message. Call it AT MOST ONCE per turn — bundle every question (up to 4) into that single call, never two. Write the questions and options in ${languageName(locale)}.`
}
