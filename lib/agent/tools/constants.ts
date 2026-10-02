/**
 * Canonical tool-name constants.
 *
 * Tool names use underscores throughout because `defineTool` (chat-sdk)
 * validates against `^[a-zA-Z0-9_-]{1,64}$`, which rejects dots.
 * The dot-separated form shown in the design docs (e.g. "corpus.get_state")
 * is the conceptual grouping — the wire names on the wire are underscore-separated.
 *
 * MCP tool names use the `<serverName>__<toolName>` prefix convention that
 * `createToolRegistry` applies automatically when building the Anthropic tool
 * list (see playbook/mcp-client.md).
 */
import { OCR_LOW_QUALITY_THRESHOLD } from "@/lib/constants"
import { ocrPercent } from "@/lib/ocr/quality"

export const AGENT_TOOLS = {
  // --- Corpus tools -----------------------------------------------------------
  corpusGetState:       "corpus_get_state",
  corpusList:           "corpus_list",
  corpusAdd:            "corpus_add",
  corpusRemove:         "corpus_remove",
  corpusRemoveByFilter: "corpus_remove_by_filter",
  corpusStats:          "corpus_stats",
  corpusDiff:           "corpus_diff",

  // --- Buffer tools (the research "tampon" — corpus scope only) --------------
  // corpus_search funnels BnF search through the buffer; the buffer_* tools
  // curate the candidate set before committing it to the versioned corpus.
  corpusSearch:          "corpus_search",
  bufferList:            "buffer_list",
  bufferStats:           "buffer_stats",
  bufferRemoveByFilter:  "buffer_remove_by_filter",
  bufferAdd:             "buffer_add",
  bufferDiscard:         "buffer_discard",
  bufferCommit:          "buffer_commit",
  bufferClear:           "buffer_clear",

  // --- Memory tools -----------------------------------------------------------
  memoryRead:  "memory_read",
  memoryWrite: "memory_write",

  // --- Ingestion tools --------------------------------------------------------
  ingestSubmit: "ingest_submit",

  // --- RAG tools --------------------------------------------------------------
  ragQuery:         "rag_query",
  ragKeywordSearch: "rag_keyword_search",
  ragGetText:       "rag_get_text",

  // --- Note tools -------------------------------------------------------------
  noteList:   "note_list",
  noteGet:    "note_get",
  noteCreate: "note_create",
  noteUpdate: "note_update",
  noteAppend: "note_append",

  // --- Document tools ---------------------------------------------------------
  docGet: "doc_get",

  // --- Interaction tools ------------------------------------------------------
  // Ends the turn and renders an interactive multiple-choice chooser; the user's
  // selections come back as the next user message. See lib/agent/tools/interaction.ts.
  askUser: "ask_user",

  // --- Sub-agent tools --------------------------------------------------------
  // Runs a bounded child agent loop in an ISOLATED context and returns only a
  // distilled result — heavy sweeps stage into the buffer / gather via RAG
  // without flooding the parent context window. See lib/agent/tools/spawn.ts.
  spawnResearch: "spawn_research",

  // --- BnF MCP tools (prefixed by the MCP server name "bnf") -----------------
  // These are NOT registered via defineTool — they come from the MCP server.
  // Listed here so the prompt-builder and the SSE event labels can reference
  // them by a typed key rather than a magic string.
  bnfSearchCatalogue: "bnf__bnf_search_catalogue",
  bnfSearchGallica:   "bnf__bnf_search_gallica",
  bnfGetRecord:       "bnf__bnf_get_catalogue_record",
  bnfGetDocumentInfo: "bnf__bnf_get_document_info",
} as const

export type AgentToolName = (typeof AGENT_TOOLS)[keyof typeof AGENT_TOOLS]

// ---------------------------------------------------------------------------
// OCR-quality notices (feedback 2026-09-29 #7, Track B — plan D16)
//
// Model-facing, so French constants rather than i18n: agent-facing text
// follows the prompts' canonical French (playbook/i18n.md, "agent output is not
// translated"). Factual only — the quote-integrity rules themselves are prompt
// work owned by Track C, which can refer to these fields. The threshold comes
// from OCR_LOW_QUALITY_THRESHOLD, never a literal.
// ---------------------------------------------------------------------------

const OCR_LOW_PERCENT = `${ocrPercent(OCR_LOW_QUALITY_THRESHOLD)} %`

/** Attached to a rag_query / rag_get_text result when any folio in it has ocrLow=true. */
export const RAG_OCR_LOW_NOTICE =
  `ocrLow=true : la reconnaissance du texte de ce folio est peu fiable ` +
  `(qualité OCR moyenne < ${OCR_LOW_PERCENT}). Toute note qui cite ce folio ` +
  `portera automatiquement la mise en garde de la BnF.`

/** Attached to a rag_keyword_search result when any hit has ocrLowFolioCount > 0. */
export const RAG_KEYWORD_OCR_LOW_NOTICE =
  `ocrLowFolios : les folios de ce document dont la reconnaissance du texte est ` +
  `peu fiable (qualité OCR moyenne < ${OCR_LOW_PERCENT}). Toute note qui cite ` +
  `l'un d'eux portera automatiquement la mise en garde de la BnF.`

/** Attached to a note write / note_get result that cites a low folio. */
export const NOTE_LOW_OCR_NOTICE =
  `Ces citations renvoient à des folios dont la reconnaissance du texte est peu ` +
  `fiable (qualité OCR moyenne < ${OCR_LOW_PERCENT}). La note affiche ` +
  `automatiquement la mise en garde de la BnF et signale ces citations : ` +
  `n'ajoute pas de mise en garde toi-même.`

/** Attached when some cited folios have no OCR quality available yet. */
export const NOTE_OCR_UNKNOWN_NOTICE =
  `La qualité OCR de ces folios n'est pas encore disponible : elle n'est ni ` +
  `bonne ni mauvaise à ce stade. Ne la présente pas comme vérifiée.`

/**
 * Attached to a COMMITTED note write when the OCR-quality check afterwards
 * failed: the note is written — never retry the write — only the check is
 * missing.
 */
export const NOTE_OCR_CHECK_FAILED_NOTICE =
  `La note est bien enregistrée, mais la vérification de la qualité OCR de ses ` +
  `citations a échoué. Ne relance pas l'écriture de la note.`

/**
 * The ARK given to a corpus-text tool is not a Document (indexed, for
 * rag_get_text) of this project's corpus. Structured output, never a throw:
 * the model recovers by passing an ARK taken from a search result
 * (CLAUDE_ERROR_PATTERNS §15).
 */
export const ARK_NOT_IN_CORPUS_ERROR = "ark_not_in_corpus"
