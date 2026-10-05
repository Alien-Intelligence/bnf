import "server-only"
import { PROMPT_REVISION } from "@/lib/constants"
import { prisma } from "@/lib/db"
import { MemoryQueries } from "@/models/memory/queries"
import { SESSION_SCOPE } from "@/models/sessions/schema"
import {
  CORPUS_SOURCE_STATE,
  corpusProjectId,
  corpusSourceState,
  isDerived,
} from "@/lib/authz/corpus-source"
import type { AppLocale } from "@/i18n/routing"
import { renderCorpusPrompt } from "./corpus"
import { renderResearchPrompt } from "./research"
import type { AppSession } from "@/lib/generated/prisma/client"
import { SessionQueries } from "@/models/sessions/queries"

/**
 * How many times `buildForSession` renders before giving up on caching. Each
 * lost compare-and-set means a memory change landed mid-render; three in a row
 * means memory is being written continuously, and the last render is served
 * without being cached (the next turn rebuilds).
 */
export const PROMPT_CACHE_MAX_RENDERS = 3

export class PromptBuilder {
  /**
   * The cached prompt is only valid for the locale it was rendered in
   * (`promptLocale`) AND the prompt revision it was rendered at
   * (`promptRevision`): a turn made under the other UI locale rebuilds it, so a
   * session follows the user when they switch FR ⇄ EN mid-project, and a
   * prompt-text change (a new PROMPT_REVISION) reaches existing sessions on
   * their next turn — without the revision check a cached prompt was served
   * forever (found bug B5).
   *
   * The write is a compare-and-set on `promptEpoch` (SessionQueries.cachePrompt),
   * which every invalidation bumps: a change that lands between the render and
   * the write makes the write miss, and the prompt is re-rendered instead of a
   * stale prompt being stamped as valid. `render` is injectable so a test can
   * land a change mid-render; production uses PromptBuilder.render.
   */
  static async buildForSession(
    session: AppSession,
    locale: AppLocale,
    render: (session: AppSession, locale: AppLocale) => Promise<string> = (s, l) => PromptBuilder.render(s, l),
  ): Promise<string> {
    let current = session
    let built = ""
    for (let attempt = 1; attempt <= PROMPT_CACHE_MAX_RENDERS; attempt++) {
      if (
        current.systemPrompt &&
        current.promptLocale === locale &&
        current.promptRevision === PROMPT_REVISION
      ) {
        return current.systemPrompt
      }
      built = await render(current, locale)
      const cached = await SessionQueries.cachePrompt(current.id, current.promptEpoch, {
        systemPrompt: built,
        promptLocale: locale,
        promptRevision: PROMPT_REVISION,
      })
      if (cached) return built
      // Lost the race to an invalidation (or another turn cached first):
      // re-read the row and either serve its fresh cache or render again.
      current = await SessionQueries.getOrThrow(session.id)
    }
    console.warn(
      `[prompt] session ${session.id}: memory changed during ${PROMPT_CACHE_MAX_RENDERS} ` +
        "consecutive renders — serving the last render uncached",
    )
    return built
  }

  /** TEST SEAM: the default render, exposed so a test can wrap it. */
  static renderForTests(session: AppSession, locale: AppLocale): Promise<string> {
    return PromptBuilder.render(session, locale)
  }

  private static async render(
    session: AppSession,
    locale: AppLocale,
  ): Promise<string> {
    const project = await prisma.project.findUniqueOrThrow({
      where: { id: session.projectId },
    })
    // Memory is the project's own; the corpus belongs to the source when this
    // project is derived. Conflating the two is the modelling error this whole
    // feature is built to avoid — see lib/authz/corpus-source.ts.
    // Both scopes' memory: the session's own, and the other step's, rendered
    // read-only (a research "source à risque" must reach the corpus agent).
    const otherScope = session.scope === SESSION_SCOPE.CORPUS ? SESSION_SCOPE.RESEARCH : SESSION_SCOPE.CORPUS
    const [memory, otherMemory] = await Promise.all([
      MemoryQueries.snapshot(session.projectId, session.scope),
      MemoryQueries.snapshot(session.projectId, otherScope),
    ])
    const crossScope = { scope: otherScope, snapshot: otherMemory }
    const corpusId = corpusProjectId(project)

    if (session.scope === SESSION_SCOPE.CORPUS) {
      const snapshot = await this.loadCorpusSnapshot(corpusId)
      return renderCorpusPrompt(project, memory, crossScope, snapshot, locale)
    }

    const source = isDerived(project)
      ? {
          // The source cannot be missing: the FK is onDelete: Restrict.
          name: (await prisma.project.findUniqueOrThrow({ where: { id: corpusId }, select: { name: true } })).name,
          state: corpusSourceState(project),
        }
      : null

    // A revoked grant is not "an empty corpus": the agent is told the access is
    // gone so it explains rather than inviting an ingestion it cannot run.
    const ingestStatus =
      source?.state === CORPUS_SOURCE_STATE.REVOKED
        ? ({ ingested: false } as const)
        : await this.loadIngestStatus(corpusId)

    return renderResearchPrompt(project, memory, crossScope, ingestStatus, locale, source)
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
