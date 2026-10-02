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
import { checkNoteQuotes } from "@/lib/citations/quote-check"
import { QUOTE_CHECK_BUDGET_MS } from "@/lib/constants"
import { findInvalidFolioCitations, type InvalidFolioCitation } from "@/lib/citations/syntax"
import {
  NOTE_BODY_MAX_CHARS,
  NOTE_TITLE_MAX_CHARS,
  QUOTE_CHECK_STATUS,
  type NoteToolResult,
  type QuoteCheckResult,
} from "@/models/notes/schema"
import type { TurnScopedCtx } from "./registry-factory"
import { AGENT_TOOLS } from "./constants"
import { refusal, type ToolRefusal } from "./refusal"
import { NOTE_NOT_INGESTED_ERROR, resolveIngestedCorpus } from "./ingestion-guard"

/**
 * Returned when the id names no note *in this project*. A note belonging to
 * another project is reported the same way — the agent has no business learning
 * that it exists. Structured output, never a throw: the model can recover by
 * calling note_list, which only ever returns ids it may use
 * (CLAUDE_ERROR_PATTERNS.md §15).
 */
export const NOTE_NOT_FOUND_ERROR = "note_not_found"

/** What a note write tool returns: the written note, or a structured refusal. */
export type NoteWriteOutcome = NoteToolResult | ToolRefusal

const UNKNOWN_ARK_MESSAGE =
  "Ces ARK ne figurent dans aucune version du corpus : la citation a été conservée dans " +
  "le texte mais n'a pas été indexée. Vérifie l'ARK avec rag_query ou retire la citation."
const INVALID_FOLIO_MESSAGE =
  "Ces citations ont un folio invalide (0, ou trop long pour une page) : elles restent du " +
  "texte, sans lien vers la page. Corrige le folio avec celui que la recherche a donné."

/**
 * The tool result for a write (NoteToolResult, models/notes/schema.ts), naming
 * any citation the corpus could not vouch for — unknown ARK or invalid folio —
 * and any quotation the cited folio does not bear out. Neither is a failure —
 * the note was written, and its body still contains the text — but the agent
 * must be told, or it will believe it cited a source it actually invented
 * (playbook/citations.md) or quoted text the document never says.
 */
function noteResult(
  note: { id: string; title: string; citationCount: number },
  rejected: string[],
  invalidFolios: InvalidFolioCitation[],
  quoteCheck?: QuoteCheckResult,
): NoteToolResult {
  const base: NoteToolResult = {
    note_id: note.id,
    title: note.title,
    citation_count: note.citationCount,
  }
  if (rejected.length > 0 || invalidFolios.length > 0) {
    base.invalid_citation = {
      arks: rejected,
      folios: invalidFolios.map((c) => ({ ark: c.ark, folio: c.folio })),
      message: [rejected.length > 0 ? UNKNOWN_ARK_MESSAGE : null, invalidFolios.length > 0 ? INVALID_FOLIO_MESSAGE : null]
        .filter((m): m is string => m !== null)
        .join(" "),
    }
  }
  if (
    quoteCheck &&
    (quoteCheck.checked > 0 ||
      quoteCheck.warnings.length > 0 ||
      quoteCheck.status === QUOTE_CHECK_STATUS.FAILED)
  ) {
    base.quote_check = { status: quoteCheck.status, checked: quoteCheck.checked }
    if (quoteCheck.unevaluated_rules.length > 0) {
      base.quote_check.unevaluated_rules = quoteCheck.unevaluated_rules
    }
    if (quoteCheck.warnings.length > 0) base.quote_warnings = quoteCheck.warnings
  }
  return base
}

/**
 * The quote check runs AFTER the write, against the corpus the note's
 * citations point into. It must not decide whether the note exists: an
 * unexpected failure here is logged and reported as `status: "failed"` rather
 * than thrown, because a throw after a successful write would make the agent
 * retry the create and duplicate the note (plan D5; CLAUDE_ERROR_PATTERNS §15).
 * Expected cluster failures are already coerced per ARK inside the checker.
 */
async function runQuoteCheck(
  ctx: TurnScopedCtx,
  bodyMd: string,
  priorBodyMd: string | null,
): Promise<QuoteCheckResult> {
  try {
    return await checkNoteQuotes({
      corpusProjectId: ctx.corpusProjectId,
      bodyMd,
      priorBodyMd,
      signal: ctx.signal,
      // Track B's per-folio quality index is not in this build: the check
      // reports `correction_on_low_ocr` as unevaluated rather than pretending.
      lowOcrFolios: null,
      budgetMs: QUOTE_CHECK_BUDGET_MS,
    })
  } catch (err) {
    console.error("[note quote check]", err)
    return { status: QUOTE_CHECK_STATUS.FAILED, checked: 0, warnings: [], unevaluated_rules: [] }
  }
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
    "Each note's id is the value to use when linking to it with [[note:<id>|<label>]].",
  inputSchema: z.object({}),
  handler: async (_input, ctx) => {
    const notes = await NoteQueries.listForProject(ctx.projectId)
    return { notes }
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
    "Use this to read a note before deciding whether to update it.",
  inputSchema: z.object({
    id: z.string().uuid().describe("The note's UUID."),
  }),
  handler: async (input, ctx) => {
    const note = await NoteQueries.getForProject(input.id, ctx.projectId)
    if (!note) return refusal(NOTE_NOT_FOUND_ERROR)
    return { note }
  },
})

// ---------------------------------------------------------------------------
// note_create
// ---------------------------------------------------------------------------

const noteCreateInputSchema = z.object({
  title: z
    .string()
    .trim()
    .min(1)
    .max(NOTE_TITLE_MAX_CHARS)
    .describe(`A clear, specific note title (max ${NOTE_TITLE_MAX_CHARS} chars).`),
  body_md: z
    .string()
    .min(1)
    .max(NOTE_BODY_MAX_CHARS)
    .describe(
      "The note body in Markdown. Use [[ark|label|folio]] for inline citations, " +
        "![[ark|caption|folio]] to embed a folio image, and [[note:<id>|<label>]] to link " +
        "another note.",
    ),
})
export type NoteCreateInput = z.infer<typeof noteCreateInputSchema>

export async function handleNoteCreate(input: NoteCreateInput, ctx: TurnScopedCtx): Promise<NoteWriteOutcome> {
  // Structural guard: a note must rest on the ingested corpus, never on
  // general knowledge before any retrieval exists (design item 4).
  const corpus = await resolveIngestedCorpus(ctx, NOTE_NOT_INGESTED_ERROR)
  if ("error" in corpus) return refusal(corpus.error)

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

  return noteResult(
    note,
    rejected,
    findInvalidFolioCitations(input.body_md),
    await runQuoteCheck(ctx, input.body_md, null),
  )
}

export const noteCreateTool = defineTool<typeof noteCreateInputSchema, TurnScopedCtx>({
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
  inputSchema: noteCreateInputSchema,
  handler: handleNoteCreate,
})

// ---------------------------------------------------------------------------
// note_update
// ---------------------------------------------------------------------------

const noteUpdateInputSchema = z.object({
  id: z.string().uuid().describe("The note's UUID."),
  title: z
    .string()
    .trim()
    .min(1)
    .max(NOTE_TITLE_MAX_CHARS)
    .optional()
    .describe("New title, if changing it."),
  body_md: z
    .string()
    .max(NOTE_BODY_MAX_CHARS)
    .optional()
    .describe(
      "New body in Markdown, if replacing it. Use [[ark|label|folio]] citations and " +
        "![[ark|caption|folio]] image embeds.",
    ),
})
export type NoteUpdateInput = z.infer<typeof noteUpdateInputSchema>

export async function handleNoteUpdate(input: NoteUpdateInput, ctx: TurnScopedCtx): Promise<NoteWriteOutcome> {
  const corpus = await resolveIngestedCorpus(ctx, NOTE_NOT_INGESTED_ERROR)
  if ("error" in corpus) return refusal(corpus.error)

  // Scope before mutating. `input.id` came from the model and names any note
  // in the database, not necessarily one this project owns.
  const target = await NoteQueries.getForProject(input.id, ctx.projectId)
  if (!target) return refusal(NOTE_NOT_FOUND_ERROR)

  const written = await NoteService.update(input.id, ctx.corpusProjectId, {
    title: input.title,
    bodyMd: input.body_md,
  })
  // Deleted between the scope check and the write — rare, but the honest
  // answer is the same one the scope check gives.
  if (!written) return refusal(NOTE_NOT_FOUND_ERROR)

  ctx.emit?.({
    type: "note_event",
    data: { kind: "updated", noteId: written.note.id, title: written.note.title },
  })

  // Only quotes absent verbatim from the prior body were written this turn.
  const quoteCheck =
    input.body_md === undefined
      ? undefined
      : await runQuoteCheck(ctx, input.body_md, target.body_md)
  return noteResult(
    written.note,
    written.rejected,
    input.body_md === undefined ? [] : findInvalidFolioCitations(input.body_md),
    quoteCheck,
  )
}

export const noteUpdateTool = defineTool<typeof noteUpdateInputSchema, TurnScopedCtx>({
  name: AGENT_TOOLS.noteUpdate,
  description:
    "Update an existing note's title and/or body. " +
    "The previous body is automatically snapshotted to NoteVersion before mutation. " +
    "Omit a field to leave it unchanged. " +
    "Use this to extend a note with new findings rather than creating a near-duplicate. " +
    "Body supports [[ark|label|folio]] citations, ![[ark|caption|folio]] image embeds, and " +
    "[[note:<id>|<label>]] links to other notes.",
  inputSchema: noteUpdateInputSchema,
  handler: handleNoteUpdate,
})

// ---------------------------------------------------------------------------
// note_append
// ---------------------------------------------------------------------------

const noteAppendInputSchema = z.object({
  id: z.string().uuid().describe("The note's UUID."),
  body_md: z
    .string()
    .trim()
    .min(1)
    .max(NOTE_BODY_MAX_CHARS)
    .describe(
      "Markdown to append at the end of the note. Include your own ## / ### headings; " +
        "it is added after a blank line. Use [[ark|label|folio]] citations, " +
        "![[ark|caption|folio]] image embeds, and [[note:<id>|<label>]] note links.",
    ),
})
export type NoteAppendInput = z.infer<typeof noteAppendInputSchema>

export async function handleNoteAppend(input: NoteAppendInput, ctx: TurnScopedCtx): Promise<NoteWriteOutcome> {
  const corpus = await resolveIngestedCorpus(ctx, NOTE_NOT_INGESTED_ERROR)
  if ("error" in corpus) return refusal(corpus.error)

  // Scope before mutating — see note_update.
  const target = await NoteQueries.getForProject(input.id, ctx.projectId)
  if (!target) return refusal(NOTE_NOT_FOUND_ERROR)

  const written = await NoteService.append(input.id, ctx.corpusProjectId, {
    bodyMd: input.body_md,
  })
  if (!written) return refusal(NOTE_NOT_FOUND_ERROR)

  ctx.emit?.({
    type: "note_event",
    data: { kind: "updated", noteId: written.note.id, title: written.note.title },
  })

  // The appended text is what was written this turn; the prior body is the
  // note as it stood, so a quote the agent repeats from it is not re-checked.
  return noteResult(
    written.note,
    written.rejected,
    findInvalidFolioCitations(input.body_md),
    await runQuoteCheck(ctx, input.body_md, target.body_md),
  )
}

export const noteAppendTool = defineTool<typeof noteAppendInputSchema, TurnScopedCtx>({
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
  inputSchema: noteAppendInputSchema,
  handler: handleNoteAppend,
})

// Convenience array for the registry builder.
export const noteTools = [
  noteListTool,
  noteGetTool,
  noteCreateTool,
  noteUpdateTool,
  noteAppendTool,
] as const
