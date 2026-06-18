import "server-only"
import { prisma } from "@/lib/db"
import { renderCorpusPrompt } from "./corpus"
import { renderResearchPrompt } from "./research"
import type { AppSession } from "@/lib/generated/prisma/client"
import type { MemorySnapshot } from "./shared"

export class PromptBuilder {
  static async buildForSession(session: AppSession): Promise<string> {
    if (session.systemPrompt) return session.systemPrompt
    const built = await this.render(session)
    await prisma.appSession.update({
      where: { id: session.id },
      data: { systemPrompt: built },
    })
    return built
  }

  /**
   * Invalidate the cached system prompt for all sessions that belong to the
   * given project and scope. Called by `memory_write` when a fact is added —
   * the cached prompt now contains stale memory and must be rebuilt on the
   * next turn.
   *
   * Invalidates by project+scope rather than by session so that any session
   * opened on this project (e.g. a background worker resuming) picks up the
   * fresh memory too.
   */
  static async invalidate(projectId: string, scope: string): Promise<void> {
    await prisma.appSession.updateMany({
      where: { projectId, scope },
      data: { systemPrompt: null },
    })
  }

  private static async render(session: AppSession): Promise<string> {
    const project = await prisma.project.findUniqueOrThrow({
      where: { id: session.projectId },
    })
    const memory = await this.loadMemory(session.projectId, session.scope)
    if (session.scope === "corpus") {
      const snapshot = await this.loadCorpusSnapshot(session.projectId)
      return renderCorpusPrompt(project, memory, snapshot)
    }
    return renderResearchPrompt()
  }

  private static async loadMemory(
    projectId: string,
    scope: string,
  ): Promise<MemorySnapshot> {
    const items = await prisma.memoryItem.findMany({
      where: { projectId, scope },
      orderBy: [
        { section: "asc" },
        { position: "asc" },
        { createdAt: "asc" },
      ],
    })
    const sections = new Map<
      string,
      { title: string; items: { id: string; text: string; origin: string | null }[] }
    >()
    for (const it of items) {
      const s = sections.get(it.section) ?? { title: it.section, items: [] }
      s.items.push({ id: it.id, text: it.text, origin: it.origin ?? null })
      sections.set(it.section, s)
    }
    return { sections: [...sections.values()] }
  }

  private static async loadCorpusSnapshot(projectId: string) {
    const project = await prisma.project.findUniqueOrThrow({
      where: { id: projectId },
      select: { headVersionId: true },
    })
    if (!project.headVersionId) {
      return {
        versionSeq: 0,
        total: 0,
        facets: { type: {}, lang: {}, period: {} },
        sample: [],
      }
    }
    const [headVersion, membership] = await Promise.all([
      prisma.corpusVersion.findUniqueOrThrow({
        where: { id: project.headVersionId },
        select: { seq: true },
      }),
      prisma.corpusMembership.findMany({
        where: { versionId: project.headVersionId },
        select: {
          document: {
            select: {
              ark: true,
              title: true,
              docType: true,
              lang: true,
              year: true,
            },
          },
        },
      }),
    ])
    const docs = membership.map((m) => m.document)
    const sample = docs
      .slice(0, 25)
      .map((d) => ({ ark: d.ark, title: d.title }))
    const type: Record<string, number> = {}
    const lang: Record<string, number> = {}
    const period: Record<string, number> = {}
    for (const d of docs) {
      if (d.docType) type[d.docType] = (type[d.docType] ?? 0) + 1
      if (d.lang) lang[d.lang] = (lang[d.lang] ?? 0) + 1
      if (d.year) {
        const dec = `${Math.floor(d.year / 10) * 10}s`
        period[dec] = (period[dec] ?? 0) + 1
      }
    }
    return {
      versionSeq: headVersion.seq,
      total: docs.length,
      facets: { type, lang, period },
      sample,
    }
  }
}
