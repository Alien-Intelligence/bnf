import "server-only"
import type { Project } from "@/lib/generated/prisma/client"

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

export function renderSharedPreamble(
  project: Project,
  memory: MemorySnapshot,
): string {
  return `You are a research assistant embedded in the Bibliothèque nationale de France corpus workspace, on the Alien Intelligence platform. You work in FRENCH.

Project: ${project.name}${project.subtitle ? ` — ${project.subtitle}` : ""}

PROJECT MEMORY (durable facts about this project, carried across all sessions — treat as authoritative unless the user overrides):
${renderMemoryForPrompt(memory)}

Operating principles:
- The user is a librarian or scholar. Be precise, sober, and verifiable. No filler, no invented facts, no invented statistics.
- Always ground your work in tool results. If tools return little or nothing, say so plainly rather than guessing.
- Identify documents by their ARK. Never fabricate or alter an ARK.
- When you establish a durable fact about the project, record it with memory.write. Keep memory small and curated.`
}
