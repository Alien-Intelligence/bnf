/**
 * Note tool definitions for the BnF research agent.
 *
 * Five tools covering the research note lifecycle:
 *   - note_list   — list all notes for the project (most-recent first)
 *   - note_get    — fetch a single note by id (with citations)
 *   - note_create — create a new Markdown research note
 *   - note_update — replace an existing note's title/body (snapshots prior body)
 *   - note_append — append Markdown to a note without resending the whole body
 *                   (cheaper than note_update for adding findings)
 *
 * note_create / note_update / note_append publish a `note_event` via `ctx.emit`
 * so connected SSE clients receive real-time feedback without polling.
 *
 * Citation syntax: [[<ark>|<short label>|<folio>]] — the folio is mandatory
 * for deep-linking into the BnF IIIF viewer. The agent must not fabricate one.
 *
 * Note-link syntax: [[note:<note_id>|<label>]] — an INTERNAL cross-reference to
 * another note in this project. Renders as a clickable pill that opens the
 * target note. The <note_id> is a real note UUID from note_list / note_get; the
 * agent must not invent one. Use it to weave a complex project's notes together
 * (e.g. a master/index note linking its per-topic notes).
 */
import "server-only"

import { z } from "zod"
import { defineTool } from "@alien/chat-sdk/claude"
import { NoteService } from "@/models/notes/service"
import { NoteQueries } from "@/models/notes/queries"
import { parseCitations } from "@/lib/citations/syntax"
import { folioOcrKey, folioOcrState, type OcrIndex } from "@/lib/ocr/quality"
import type { Citation } from "@/models/notes/schema"
import type { TurnScopedCtx } from "./registry-factory"
import {
  AGENT_TOOLS,
  NOTE_LOW_OCR_NOTICE,
  NOTE_OCR_CHECK_FAILED_NOTICE,
  NOTE_OCR_UNKNOWN_NOTICE,
} from "./constants"
import {
  loadOcrIndex,
  noteCitationRefs,
  noteOcrReport,
  type NoteOcrReport,
} from "./rag-ocr"
import { NOTE_NOT_INGESTED_ERROR, resolveIngestedCorpus } from "./ingestion-guard"

/**
 * Returned when the id names no note *in this project*. A note belonging to
 * another project is reported the same way — the agent has no business learning
 * that it exists. Structured output, never a throw: the model can recover by
 * calling note_list, which only ever returns ids it may use
 * (CLAUDE_ERROR_PATTERNS.md §15).
 */
export const NOTE_NOT_FOUND_ERROR = "note_not_found"

/**
 * What is known of a note's citations' OCR quality (feedback 2026-09-29 #7):
 * the report, or — for a write, where the note is ALREADY committed — the fact
 * that the check itself failed. A failed check never turns a committed write
 * into an error the model would retry (CLAUDE_ERROR_PATTERNS §15).
 */
export type NoteOcrOutcome = { kind: "checked"; report: NoteOcrReport } | { kind: "check_failed" }

/** The OCR fields of a note tool result; none at all when nothing is to be said. */
export function noteOcrFields(outcome: NoteOcrOutcome) {
  if (outcome.kind === "check_failed") {
    return { ocr_check: { status: "failed" as const, message: NOTE_OCR_CHECK_FAILED_NOTICE } }
  }
  const { low, unknown } = outcome.report
  return {
    ...(low.length > 0
      ? { low_ocr_citations: { citations: low, message: NOTE_LOW_OCR_NOTICE } }
      : {}),
    ...(unknown.length > 0
      ? { ocr_unknown_citations: { citations: unknown, message: NOTE_OCR_UNKNOWN_NOTICE } }
      : {}),
  }
}

/**
 * The tool result for a write, naming any citation the corpus could not vouch
 * for. A rejected ARK is not a failure — the note was written, and its body
 * still contains the text — but the agent must be told, or it will believe it
 * cited a source it actually invented (playbook/citations.md).
 *
 * It also names the citations of low-OCR folios and those whose quality is not
 * available yet, so the agent knows the BnF disclaimer is added BY CODE (and
 * does not write its own) and never presents an unknown quality as verified.
 * With nothing to say, the result is unchanged. Exported for the tests.
 */
export function noteResult(
  note: { id: string; title: string; citationCount: number },
  rejected: string[],
  ocr: NoteOcrOutcome,
) {
  const base = {
    note_id: note.id,
    title: note.title,
    citation_count: note.citationCount,
    ...noteOcrFields(ocr),
  }
  if (rejected.length === 0) return base
  return {
    ...base,
    invalid_citation: {
      arks: rejected,
      message:
        "Ces ARK ne figurent dans aucune version du corpus : la citation a été " +
        "conservée dans le texte mais n'a pas été indexée. Vérifie l'ARK avec " +
        "rag_query ou retire la citation.",
    },
  }
}

/**
 * The OCR check of a COMMITTED write: the written body's corpus-vouched
 * citations against the stored quality. Its failure is logged and reported in
 * the result (`ocr_check: failed`), never thrown — the note exists.
 */
async function checkWrittenNoteOcr(
  body: string,
  rejected: string[],
  ctx: TurnScopedCtx,
): Promise<NoteOcrOutcome> {
  try {
    const index = await loadOcrIndex(ctx.corpusProjectId, noteCitationRefs(body, rejected), ctx.signal)
    return { kind: "checked", report: noteOcrReport(body, index, rejected) }
  } catch (err) {
    console.error("[note] OCR-quality check after a committed write failed:", err)
    return { kind: "check_failed" }
  }
}

/**
 * The body ARKs a note's Citation rows do NOT hold — the ones the corpus
 * refused when the note was written. They are never looked up.
 */
function uncitedArks(body: string, citations: Array<Pick<Citation, "ark">>): string[] {
  const vouched = new Set(citations.map((c) => c.ark))
  return [...new Set(parseCitations(body).map((c) => c.ark))].filter((a) => !vouched.has(a))
}

/** Pinned first, then most recently updated — the order of NoteQueries.listForProject. */
function sortLikeNoteList<T extends { pinned: boolean; updatedAt: Date }>(notes: T[]): T[] {
  return [...notes].sort(
    (a, b) => Number(b.pinned) - Number(a.pinned) || b.updatedAt.getTime() - a.updatedAt.getTime(),
  )
}

/** Low / unknown counts of some Citation rows against an index, one per (ark, folio). */
export function citationOcrCounts(
  citations: Array<Pick<Citation, "ark" | "folio">>,
  index: OcrIndex,
): { low: number; unknown: number } {
  const seen = new Set<string>()
  let low = 0
  let unknown = 0
  for (const c of citations) {
    if (c.folio === null) continue
    const key = folioOcrKey(c.ark, c.folio)
    if (seen.has(key)) continue
    seen.add(key)
    const state = folioOcrState(index, c.ark, c.folio)
    if (state.kind === "recorded") {
      if (state.view.low) low += 1
    } else {
      unknown += 1
    }
  }
  return { low, unknown }
}

// ---------------------------------------------------------------------------
// note_list
// ---------------------------------------------------------------------------

export const noteListTool = defineTool<z.ZodObject<Record<never, never>>, TurnScopedCtx>({
  name: AGENT_TOOLS.noteList,
  description:
    "List all research notes for this project, ordered most-recently-updated first. " +
    "Call this before note_create to check whether a closely related note already exists — " +
    "prefer note_update over creating a near-duplicate. " +
    "Each note's id is the value to use when linking to it with [[note:<id>|<label>]]. " +
    "Each note also carries low_ocr_citation_count (citations of poorly recognised " +
    "folios — the note shows the BnF disclaimer) and ocr_unknown_citation_count " +
    "(citations whose OCR quality is not available yet — unknown, not 'good').",
  inputSchema: z.object({}),
  handler: async (_input, ctx) => {
    // One read (notes + their Citation rows), ordered as NoteQueries.listForProject.
    const notes = sortLikeNoteList(await NoteQueries.listWithCitationsForProject(ctx.projectId))
    const index = await loadOcrIndex(
      ctx.corpusProjectId,
      notes.flatMap((n) =>
        n.citations.flatMap((c) => (c.folio === null ? [] : [{ ark: c.ark, folio: c.folio }])),
      ),
      ctx.signal,
    )
    return {
      notes: notes.map((n) => {
        const counts = citationOcrCounts(n.citations, index)
        return {
          id: n.id,
          title: n.title,
          updatedAt: n.updatedAt,
          citationCount: n.citationCount,
          pinned: n.pinned,
          createdAt: n.createdAt,
          low_ocr_citation_count: counts.low,
          ocr_unknown_citation_count: counts.unknown,
        }
      }),
    }
  },
})

// ---------------------------------------------------------------------------
// note_get
// ---------------------------------------------------------------------------

export const noteGetTool = defineTool<
  z.ZodObject<{ id: z.ZodString }>,
  TurnScopedCtx
>({
  name: AGENT_TOOLS.noteGet,
  description:
    "Fetch the full body and citations of a single note by its id. " +
    "Use this to read a note before deciding whether to update it. " +
    "The result also names its low_ocr_citations (poorly recognised folios — the " +
    "note shows the BnF disclaimer) and ocr_unknown_citations (quality not " +
    "available yet — unknown, not 'good').",
  inputSchema: z.object({
    id: z.string().uuid().describe("The note's UUID."),
  }),
  handler: async (input, ctx) => {
    const note = await NoteQueries.getForProject(input.id, ctx.projectId)
    if (!note) return { error: NOTE_NOT_FOUND_ERROR }
    const refused = uncitedArks(note.body_md, note.citations)
    const index = await loadOcrIndex(
      ctx.corpusProjectId,
      noteCitationRefs(note.body_md, refused),
      ctx.signal,
    )
    return {
      note,
      ...noteOcrFields({ kind: "checked", report: noteOcrReport(note.body_md, index, refused) }),
    }
  },
})

// ---------------------------------------------------------------------------
// note_create
// ---------------------------------------------------------------------------

export const noteCreateTool = defineTool<
  z.ZodObject<{
    title: z.ZodString
    body_md: z.ZodString
  }>,
  TurnScopedCtx
>({
  name: AGENT_TOOLS.noteCreate,
  description:
    "Create a new Markdown research note. " +
    "Structure the body with ## / ### sections, bullet lists, and inline citations. " +
    "Citation syntax: [[<ark>|<short label>|<folio>]] — folio is mandatory; " +
    "if you do not have a folio from rag_query, cite in prose only. " +
    "Embed a folio image with ![[<ark>|<caption>|<folio>]] (the same syntax with a leading !) " +
    "to show a page — the image is fetched from Gallica by ark+folio, no link needed. " +
    "Link to another note with [[note:<note_id>|<label>]] (ids from note_list/note_get) — " +
    "the pill opens that note. " +
    "Call note_list first to avoid near-duplicates.",
  inputSchema: z.object({
    title: z
      .string()
      .trim()
      .min(1)
      .max(200)
      .describe("A clear, specific note title (max 200 chars)."),
    body_md: z
      .string()
      .min(1)
      .max(200_000)
      .describe(
        "The note body in Markdown. Use [[ark|label|folio]] for inline citations, " +
          "![[ark|caption|folio]] to embed a folio image, and [[note:<id>|<label>]] to link " +
          "another note.",
      ),
  }),
  handler: async (input, ctx) => {
    // Structural guard: a note must rest on the ingested corpus, never on
    // general knowledge before any retrieval exists (design item 4).
    const corpus = await resolveIngestedCorpus(ctx, NOTE_NOT_INGESTED_ERROR)
    if ("error" in corpus) return { error: corpus.error }

    // The note is the project's own; its citations belong to the corpus it
    // reads, which is the source's when this is a derived workspace.
    const { note, rejected } = await NoteService.create({
      projectId: ctx.projectId,
      corpusProjectId: ctx.corpusProjectId,
      appSessionId: ctx.appSessionId,
      title: input.title,
      bodyMd: input.body_md,
    })

    ctx.emit?.({
      type: "note_event",
      data: { kind: "created", noteId: note.id, title: note.title },
    })

    return noteResult(note, rejected, await checkWrittenNoteOcr(note.body_md, rejected, ctx))
  },
})

// ---------------------------------------------------------------------------
// note_update
// ---------------------------------------------------------------------------

export const noteUpdateTool = defineTool<
  z.ZodObject<{
    id: z.ZodString
    title: z.ZodOptional<z.ZodString>
    body_md: z.ZodOptional<z.ZodString>
  }>,
  TurnScopedCtx
>({
  name: AGENT_TOOLS.noteUpdate,
  description:
    "Update an existing note's title and/or body. " +
    "The previous body is automatically snapshotted to NoteVersion before mutation. " +
    "Omit a field to leave it unchanged. " +
    "Use this to extend a note with new findings rather than creating a near-duplicate. " +
    "Body supports [[ark|label|folio]] citations, ![[ark|caption|folio]] image embeds, and " +
    "[[note:<id>|<label>]] links to other notes.",
  inputSchema: z.object({
    id: z.string().uuid().describe("The note's UUID."),
    title: z
      .string()
      .trim()
      .min(1)
      .max(200)
      .optional()
      .describe("New title, if changing it."),
    body_md: z
      .string()
      .max(200_000)
      .optional()
      .describe(
        "New body in Markdown, if replacing it. Use [[ark|label|folio]] citations and " +
          "![[ark|caption|folio]] image embeds.",
      ),
  }),
  handler: async (input, ctx) => {
    const corpus = await resolveIngestedCorpus(ctx, NOTE_NOT_INGESTED_ERROR)
    if ("error" in corpus) return { error: corpus.error }

    // Scope before mutating. `input.id` came from the model and names any note
    // in the database, not necessarily one this project owns.
    const target = await NoteQueries.getForProject(input.id, ctx.projectId)
    if (!target) return { error: NOTE_NOT_FOUND_ERROR }

    const written = await NoteService.update(input.id, ctx.corpusProjectId, {
      title: input.title,
      bodyMd: input.body_md,
    })
    // Deleted between the scope check and the write — rare, but the honest
    // answer is the same one the scope check gives.
    if (!written) return { error: NOTE_NOT_FOUND_ERROR }

    ctx.emit?.({
      type: "note_event",
      data: { kind: "updated", noteId: written.note.id, title: written.note.title },
    })

    return noteResult(
      written.note,
      written.rejected,
      await checkWrittenNoteOcr(written.note.body_md, written.rejected, ctx),
    )
  },
})

// ---------------------------------------------------------------------------
// note_append
// ---------------------------------------------------------------------------

export const noteAppendTool = defineTool<
  z.ZodObject<{
    id: z.ZodString
    body_md: z.ZodString
  }>,
  TurnScopedCtx
>({
  name: AGENT_TOOLS.noteAppend,
  description:
    "Append Markdown to the END of an existing note WITHOUT resending the whole body. " +
    "PREFER THIS over note_update to add new findings to a note: you emit only the new " +
    "passage, so it is much faster and far cheaper than rewriting the entire note. " +
    "The new text is placed after a blank line; the prior body is snapshotted to " +
    "NoteVersion and citations are re-parsed over the whole note. " +
    "Use [[<ark>|<short label>|<folio>]] citations, ![[<ark>|<caption>|<folio>]] image embeds, " +
    "and [[note:<id>|<label>]] links to other notes. " +
    "Use note_update only for surgical edits to existing text (fixing or removing).",
  inputSchema: z.object({
    id: z.string().uuid().describe("The note's UUID."),
    body_md: z
      .string()
      .trim()
      .min(1)
      .max(200_000)
      .describe(
        "Markdown to append at the end of the note. Include your own ## / ### headings; " +
          "it is added after a blank line. Use [[ark|label|folio]] citations, " +
          "![[ark|caption|folio]] image embeds, and [[note:<id>|<label>]] note links.",
      ),
  }),
  handler: async (input, ctx) => {
    const corpus = await resolveIngestedCorpus(ctx, NOTE_NOT_INGESTED_ERROR)
    if ("error" in corpus) return { error: corpus.error }

    // Scope before mutating — see note_update.
    const target = await NoteQueries.getForProject(input.id, ctx.projectId)
    if (!target) return { error: NOTE_NOT_FOUND_ERROR }

    const written = await NoteService.append(input.id, ctx.corpusProjectId, {
      bodyMd: input.body_md,
    })
    if (!written) return { error: NOTE_NOT_FOUND_ERROR }

    ctx.emit?.({
      type: "note_event",
      data: { kind: "updated", noteId: written.note.id, title: written.note.title },
    })

    return noteResult(
      written.note,
      written.rejected,
      await checkWrittenNoteOcr(written.note.body_md, written.rejected, ctx),
    )
  },
})

// Convenience array for the registry builder.
export const noteTools = [
  noteListTool,
  noteGetTool,
  noteCreateTool,
  noteUpdateTool,
  noteAppendTool,
] as const
