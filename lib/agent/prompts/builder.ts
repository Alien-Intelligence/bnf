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
    const ingestStatus = await this.loadIngestStatus(session.projectId)
    return renderResearchPrompt(project, memory, ingestStatus)
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

  private static async loadIngestStatus(projectId: string) {
    const project = await prisma.project.findUniqueOrThrow({
      where: { id: projectId },
      select: { ingestedVersionId: true },
    })

    if (!project.ingestedVersionId) {
      return { ingested: false as const }
    }

    const [ingestedVersion, total] = await Promise.all([
      prisma.corpusVersion.findUniqueOrThrow({
        where: { id: project.ingestedVersionId },
        select: { seq: true },
      }),
      prisma.corpusMembership.count({
        where: { versionId: project.ingestedVersionId },
      }),
    ])

    return {
      ingested: true as const,
      seq: ingestedVersion.seq,
      total,
    }
  }

  // Aggregate-only corpus snapshot for the system prompt: total + facet counts,
  // NO per-document list. The agent inspects specific documents on demand via the
  // corpus.get_state tool, so the prompt stays a fixed small size regardless of
  // corpus size (a 5k-doc corpus produces the same prompt as a 50-doc one).
  // Computed with groupBy aggregates — never loads the full membership.
  private static async loadCorpusSnapshot(projectId: string) {
    const project = await prisma.project.findUniqueOrThrow({
      where: { id: projectId },
      select: { headVersionId: true },
    })
    if (!project.headVersionId) {
      return { versionSeq: 0, total: 0, facets: { type: {}, lang: {}, period: {} } }
    }
    const versionId = project.headVersionId
    const memberOf = { membership: { some: { versionId } } }

    const [headVersion, total, typeRows, langRows, yearRows] = await Promise.all([
      prisma.corpusVersion.findUniqueOrThrow({
        where: { id: versionId },
        select: { seq: true },
      }),
      prisma.corpusMembership.count({ where: { versionId } }),
      prisma.document.groupBy({
        by: ["docType"],
        where: { ...memberOf, docType: { not: null } },
        _count: { ark: true },
      }),
      prisma.document.groupBy({
        by: ["lang"],
        where: { ...memberOf, lang: { not: null } },
        _count: { ark: true },
      }),
      prisma.document.groupBy({
        by: ["year"],
        where: { ...memberOf, year: { not: null } },
        _count: { ark: true },
      }),
    ])

    const type: Record<string, number> = {}
    for (const r of typeRows) if (r.docType) type[r.docType] = r._count.ark
    const lang: Record<string, number> = {}
    for (const r of langRows) if (r.lang) lang[r.lang] = r._count.ark
    const period: Record<string, number> = {}
    for (const r of yearRows) {
      if (r.year === null) continue
      const dec = `${Math.floor(r.year / 10) * 10}s`
      period[dec] = (period[dec] ?? 0) + r._count.ark
    }

    return { versionSeq: headVersion.seq, total, facets: { type, lang, period } }
  }
}
