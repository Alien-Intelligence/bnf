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
import { NotePolicy } from "@/models/notes/policy"
import { withDeadline } from "@/lib/async/deadline"
import { classifyFolioRefs } from "@/lib/citations/ocr"
import { TOOL_DB_TIMEOUT_MS } from "@/lib/constants"
import { noteOcrIndex, type OcrReader } from "@/lib/ocr/quality"
import { OCR_ACCESS } from "@/models/documents/schema"
import { NoteService } from "@/models/notes/service"
import { NoteQueries } from "@/models/notes/queries"
import type { NoteDetail, NoteWithCitations } from "@/models/notes/schema"
import type { TurnScopedCtx } from "./registry-factory"
import { authorizeOnProject, authorizeProjectTool } from "./authorize"
import { emitDomainEvent, NOTE_EVENT_KIND, STREAM_DOMAIN_EVENT } from "@/lib/agent/stream-events"
import {
  AGENT_TOOLS,
  FOLIO_OCR_STATE_LEGEND,
  NOTE_INVALID_CITATION_MESSAGE,
  NOTE_LOW_OCR_NOTICE,
  NOTE_OCR_CHECK_FAILED_NOTICE,
  NOTE_OCR_CORPUS_REVOKED_NOTICE,
  NOTE_OCR_READ_FAILED_NOTICE,
  NOTE_OCR_UNKNOWN_NOTICE,
} from "./constants"
import { toolFailure } from "./failure"
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
 * the report; or that the source corpus's grant was revoked (nothing is
 * read); or that the check itself failed. A failed check never turns a
 * committed write — or a note read — into an error the model would retry
 * (CLAUDE_ERROR_PATTERNS §15).
 */
export type NoteOcrOutcome =
  | { kind: typeof OCR_ACCESS.OK; report: NoteOcrReport }
  | { kind: typeof OCR_ACCESS.CORPUS_REVOKED }
  | { kind: typeof OCR_ACCESS.CHECK_FAILED }

/**
 * The OCR fields of a note tool result; none at all when nothing is to be
 * said. `failedNotice` is what a failed check means where it happened: after
 * a committed write (do not retry it) or on a read (the quality is unknown).
 */
export function noteOcrFields(outcome: NoteOcrOutcome, failedNotice: string) {
  if (outcome.kind === OCR_ACCESS.CHECK_FAILED) {
    return { ocr_check: { status: outcome.kind, message: failedNotice } }
  }
  if (outcome.kind === OCR_ACCESS.CORPUS_REVOKED) {
    return { ocr_check: { status: outcome.kind, message: NOTE_OCR_CORPUS_REVOKED_NOTICE } }
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
 * It also names the citations of low-OCR folios and those whose quality is
 * unknown, so the agent knows the BnF disclaimer is added BY CODE (and does
 * not write its own) and never presents an unknown quality as verified.
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
    ...noteOcrFields(ocr, NOTE_OCR_CHECK_FAILED_NOTICE),
  }
  if (rejected.length === 0) return base
  return {
    ...base,
    invalid_citation: { arks: rejected, message: NOTE_INVALID_CITATION_MESSAGE },
  }
}

/**
 * The OCR check of a COMMITTED write: the written body's corpus-vouched
 * citations against the stored quality. Its failure is logged and reported in
 * the result (`ocr_check: check_failed`), never thrown — the note exists.
 */
async function checkWrittenNoteOcr(
  body: string,
  rejected: string[],
  reader: OcrReader,
): Promise<NoteOcrOutcome> {
  try {
    const index = await loadOcrIndex(reader, noteCitationRefs(body, rejected))
    if (index.access !== OCR_ACCESS.OK) return { kind: index.access }
    return { kind: OCR_ACCESS.OK, report: noteOcrReport(noteCitationRefs(body, rejected), index) }
  } catch (err) {
    console.error("[note] OCR-quality check after a committed write failed:", err)
    return { kind: OCR_ACCESS.CHECK_FAILED }
  }
}

/** A loaded note's OCR outcome, from its NoteDetail (NoteService.details). */
function noteDetailOcr(note: NoteDetail): NoteOcrOutcome {
  if (note.ocr.access !== OCR_ACCESS.OK) return { kind: note.ocr.access }
  return { kind: OCR_ACCESS.OK, report: noteOcrReport(note.citations, noteOcrIndex(note.ocr)) }
}

/** A note read of a note tool, scoped to the turn's project and bounded. */
function readNote(id: string, ctx: TurnScopedCtx): Promise<NoteWithCitations | null> {
  return withDeadline(NoteQueries.getForProject(id, ctx.projectId), {
    label: "note read",
    ms: TOOL_DB_TIMEOUT_MS,
    signal: ctx.signal,
  })
}

// ---------------------------------------------------------------------------
// note_list
// ---------------------------------------------------------------------------

/** Low / unknown citation counts of a listed note; null when its OCR was not read. */
function noteListOcrCounts(note: NoteDetail): { low: number | null; unknown: number | null } {
  if (note.ocr.access !== OCR_ACCESS.OK) return { low: null, unknown: null }
  const { low, unknown } = classifyFolioRefs(note.citations, noteOcrIndex(note.ocr))
  return { low: low.length, unknown: unknown.length }
}

/**
 * The note_list OCR status line: present only when the counts could not be
 * computed (one OCR read serves every note, so one note says it for all).
 */
function noteListOcrCheck(notes: NoteDetail[]) {
  for (const n of notes) {
    if (n.ocr.access !== OCR_ACCESS.OK) {
      return noteOcrFields({ kind: n.ocr.access }, NOTE_OCR_READ_FAILED_NOTICE)
    }
  }
  return {}
}

export const noteListTool = defineTool<z.ZodObject<Record<never, never>>, TurnScopedCtx>({
  name: AGENT_TOOLS.noteList,
  description:
    "List all research notes for this project, pinned first, then most-recently-updated first. " +
    "Call this before note_create to check whether a closely related note already exists — " +
    "prefer note_update over creating a near-duplicate. " +
    "Each note's id is the value to use when linking to it with [[note:<id>|<label>]]. " +
    "Each note also carries low_ocr_citation_count (citations of poorly recognised " +
    "folios — the note shows the BnF disclaimer) and ocr_unknown_citation_count " +
    "(citations whose OCR quality is unknown — never 'good'). Both are null, and " +
    "ocr_check says why, when the OCR quality could not be read " +
    `(${OCR_ACCESS.CORPUS_REVOKED}, ${OCR_ACCESS.CHECK_FAILED}).`,
  inputSchema: z.object({}),
  handler: async (_input, ctx) => {
    // One read (notes + their Citation rows, in the note-list order), then ONE
    // OCR read for all of them (NoteService.details: gated, bounded, non-fatal).
    const notes = await withDeadline(
      NoteQueries.listWithCitationsForProject(ctx.projectId),
      { label: "note list read", ms: TOOL_DB_TIMEOUT_MS, signal: ctx.signal },
    )
    const details = await NoteService.details(notes, ctx)
    return {
      notes: details.map((n) => {
        const counts = noteListOcrCounts(n)
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
      ...noteListOcrCheck(details),
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
    "note shows the BnF disclaimer) and ocr_unknown_citations (quality unknown — " +
    "never 'good'; each carries its ocr_state). When the OCR quality could not be " +
    `read, ocr_check says why (${OCR_ACCESS.CORPUS_REVOKED}, ${OCR_ACCESS.CHECK_FAILED}) instead. ` +
    `ocr_state : ${FOLIO_OCR_STATE_LEGEND}.`,
  inputSchema: z.object({
    id: z.string().uuid().describe("The note's UUID."),
  }),
  handler: async (input, ctx) => {
    const note = await readNote(input.id, ctx)
    if (!note) return toolFailure(NOTE_NOT_FOUND_ERROR)
    // The note is the project's own and is always returned; its OCR is read on
    // the corpus — never when the grant was revoked, and non-fatally.
    const detail = await NoteService.detail(note, ctx)
    return { note, ...noteOcrFields(noteDetailOcr(detail), NOTE_OCR_READ_FAILED_NOTICE) }
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
    const gate = await authorizeProjectTool(ctx, NotePolicy, "create")
    if (!gate.ok) return gate.result

    // Structural guard: a note must rest on the ingested corpus, never on
    // general knowledge before any retrieval exists (design item 4).
    const corpus = await resolveIngestedCorpus(ctx, NOTE_NOT_INGESTED_ERROR)
    if ("error" in corpus) return toolFailure(corpus.error)

    // The note is the project's own; its citations belong to the corpus it
    // reads, which is the source's when this is a derived workspace.
    const { note, rejected } = await NoteService.create({
      projectId: ctx.projectId,
      corpusProjectId: ctx.corpusProjectId,
      appSessionId: ctx.appSessionId,
      title: input.title,
      bodyMd: input.body_md,
    })

    emitDomainEvent(ctx, {
      type: STREAM_DOMAIN_EVENT.NOTE,
      data: { kind: NOTE_EVENT_KIND.CREATED, noteId: note.id, title: note.title },
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
    // The policy gate FIRST, as in note_create: a read-only member is refused
    // before any lookup, so it can neither write nor learn which ids exist.
    const gate = await authorizeProjectTool(ctx, NotePolicy, "write")
    if (!gate.ok) return gate.result

    const corpus = await resolveIngestedCorpus(ctx, NOTE_NOT_INGESTED_ERROR)
    if ("error" in corpus) return toolFailure(corpus.error)

    // Scope before mutating. `input.id` came from the model and names any note
    // in the database, not necessarily one this project owns.
    const target = await readNote(input.id, ctx)
    if (!target) return toolFailure(NOTE_NOT_FOUND_ERROR)
    const noteGate = authorizeOnProject(ctx, gate.project, NotePolicy, "update", target)
    if (!noteGate.ok) return noteGate.result

    const written = await NoteService.update(input.id, ctx.corpusProjectId, {
      title: input.title,
      bodyMd: input.body_md,
    })
    // Deleted between the scope check and the write — rare, but the honest
    // answer is the same one the scope check gives.
    if (!written) return toolFailure(NOTE_NOT_FOUND_ERROR)

    emitDomainEvent(ctx, {
      type: STREAM_DOMAIN_EVENT.NOTE,
      data: { kind: NOTE_EVENT_KIND.UPDATED, noteId: written.note.id, title: written.note.title },
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
    // The policy gate first — see note_update.
    const gate = await authorizeProjectTool(ctx, NotePolicy, "write")
    if (!gate.ok) return gate.result

    const corpus = await resolveIngestedCorpus(ctx, NOTE_NOT_INGESTED_ERROR)
    if ("error" in corpus) return toolFailure(corpus.error)

    // Scope before mutating — see note_update.
    const target = await readNote(input.id, ctx)
    if (!target) return toolFailure(NOTE_NOT_FOUND_ERROR)
    const noteGate = authorizeOnProject(ctx, gate.project, NotePolicy, "update", target)
    if (!noteGate.ok) return noteGate.result

    const written = await NoteService.append(input.id, ctx.corpusProjectId, {
      bodyMd: input.body_md,
    })
    if (!written) return toolFailure(NOTE_NOT_FOUND_ERROR)

    emitDomainEvent(ctx, {
      type: STREAM_DOMAIN_EVENT.NOTE,
      data: { kind: NOTE_EVENT_KIND.UPDATED, noteId: written.note.id, title: written.note.title },
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
