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
import {
  DOCUMENT_OCR_STATUS,
  FOLIO_OCR_STATE,
  type DocumentOcrStatus,
  type FolioOcrStateKind,
} from "@/models/documents/schema"

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

/**
 * The notices that name the threshold, built FROM a threshold so the test can
 * prove the percentage is derived (a builder fed 0.5 must say 50 %).
 */
export function ocrLowNotices(threshold: number) {
  const pct = `${ocrPercent(threshold)} %`
  return {
    /** Attached to a rag_query / rag_get_text result when any folio in it has ocrLow=true. */
    rag:
      `ocrLow=true : la reconnaissance du texte de ce folio est peu fiable ` +
      `(qualité OCR moyenne < ${pct}). Toute note qui cite ce folio ` +
      `portera automatiquement la mise en garde de la BnF.`,
    /** Attached to a rag_keyword_search result when any hit has ocrLowFolioCount > 0. */
    keyword:
      `ocrLowFolios : les folios de ce document dont la reconnaissance du texte est ` +
      `peu fiable (qualité OCR moyenne < ${pct}). Toute note qui cite ` +
      `l'un d'eux portera automatiquement la mise en garde de la BnF.`,
    /** Attached to a note write / note_get result that cites a low folio. */
    note:
      `Ces citations renvoient à des folios dont la reconnaissance du texte est peu ` +
      `fiable (qualité OCR moyenne < ${pct}). La note affiche ` +
      `automatiquement la mise en garde de la BnF et signale ces citations : ` +
      `n'ajoute pas de mise en garde toi-même.`,
  }
}

const OCR_LOW_NOTICES = ocrLowNotices(OCR_LOW_QUALITY_THRESHOLD)
export const RAG_OCR_LOW_NOTICE = OCR_LOW_NOTICES.rag
export const RAG_KEYWORD_OCR_LOW_NOTICE = OCR_LOW_NOTICES.keyword
export const NOTE_LOW_OCR_NOTICE = OCR_LOW_NOTICES.note

/**
 * What each folio OCR state means, as the model is told it — in the tool
 * descriptions, the research prompt and the notices. Keyed by the vocabulary
 * itself, so a new state cannot ship without its meaning.
 */
export const FOLIO_OCR_STATE_MEANING: Record<FolioOcrStateKind, string> = {
  [FOLIO_OCR_STATE.RECORDED]:
    "qualité mesurée et enregistrée (ocrQuality, ocrSource, ocrLow font foi)",
  [FOLIO_OCR_STATE.PENDING]:
    "qualité pas encore disponible : le document est en cours de synchronisation",
  [FOLIO_OCR_STATE.UNAVAILABLE]:
    "qualité non obtenue pour ce document (la BnF ne la fournit pas, ou sa " +
    "synchronisation échoue) : elle peut ne jamais l'être",
  [FOLIO_OCR_STATE.NOT_RECORDED]:
    "aucune qualité pour ce folio, définitivement : le document est synchronisé " +
    "mais ce folio n'en fait pas partie des pages traitées",
  [FOLIO_OCR_STATE.NO_FOLIO]: "la référence ne porte pas de folio",
  [FOLIO_OCR_STATE.CORPUS_REVOKED]:
    "l'accès au corpus partagé a été révoqué : sa qualité OCR n'est plus lue",
  [FOLIO_OCR_STATE.CHECK_FAILED]: "la lecture de la qualité OCR a échoué",
}

/** What each document OCR status means (doc_get `ocr.status`, keyword hits' `ocrStatus`). */
export const DOCUMENT_OCR_STATUS_MEANING: Record<DocumentOcrStatus, string> = {
  [DOCUMENT_OCR_STATUS.AVAILABLE]: "qualité connue pour tout le document",
  [DOCUMENT_OCR_STATUS.PENDING]: "pas encore synchronisé : qualité pas encore disponible",
  [DOCUMENT_OCR_STATUS.BUILDING]: "synchronisation en cours : qualité pas encore disponible",
  [DOCUMENT_OCR_STATUS.INCOMPATIBLE]:
    "le service de qualité OCR et l'application ne sont pas à la même version : qualité pas encore disponible",
  [DOCUMENT_OCR_STATUS.UNAVAILABLE]:
    "qualité non obtenue (la BnF ne la fournit pas, ou la synchronisation échoue) : " +
    "elle peut ne jamais l'être",
  [DOCUMENT_OCR_STATUS.QUARANTINED]:
    "synchronisation abandonnée après des échecs répétés : qualité inconnue",
}

/** `a — meaning ; b — meaning`, the legend of a vocabulary for a description or a prompt. */
function legend<K extends string>(meaning: Record<K, string>, keys: readonly K[]): string {
  return keys.map((k) => `\`${k}\` — ${meaning[k]}`).join(" ; ")
}

/** Every folio OCR state with its meaning. */
export const FOLIO_OCR_STATE_LEGEND = legend(
  FOLIO_OCR_STATE_MEANING,
  Object.values(FOLIO_OCR_STATE),
)
/** Every document OCR status with its meaning. */
export const DOCUMENT_OCR_STATUS_LEGEND = legend(
  DOCUMENT_OCR_STATUS_MEANING,
  Object.values(DOCUMENT_OCR_STATUS),
)

/**
 * Attached when some cited folios' quality is UNKNOWN to the reader; each
 * citation carries its `ocr_state`, explained here.
 */
export const NOTE_OCR_UNKNOWN_NOTICE =
  `La qualité OCR de ces folios est inconnue — ni bonne ni mauvaise : ne la ` +
  `présente pas comme vérifiée. ocr_state : ${legend(FOLIO_OCR_STATE_MEANING, [
    FOLIO_OCR_STATE.PENDING,
    FOLIO_OCR_STATE.UNAVAILABLE,
    FOLIO_OCR_STATE.NOT_RECORDED,
  ])}.`

/**
 * Attached to a note read (note_get, note_list) of a derived workspace whose
 * corpus grant was revoked: the note is the workspace's own and is returned,
 * but the source corpus's OCR rows are no longer read.
 */
export const NOTE_OCR_CORPUS_REVOKED_NOTICE =
  `L'accès au corpus partagé a été révoqué : la qualité OCR des citations de ` +
  `cette note n'est plus lue. Elle est inconnue, pas bonne.`

/**
 * Attached to a note read (note_get, note_list) when reading its citations'
 * OCR quality failed: the note is returned, its quality is unknown.
 */
export const NOTE_OCR_READ_FAILED_NOTICE =
  `La lecture de la qualité OCR des citations de cette note a échoué : elle est ` +
  `inconnue, pas bonne. Ne la présente pas comme vérifiée.`

/**
 * Attached to a COMMITTED note write when the OCR-quality check afterwards
 * failed: the note is written — never retry the write — only the check is
 * missing.
 */
export const NOTE_OCR_CHECK_FAILED_NOTICE =
  `La note est bien enregistrée, mais la vérification de la qualité OCR de ses ` +
  `citations a échoué. Ne relance pas l'écriture de la note.`

/**
 * Attached to a note write that cited ARKs the corpus does not hold: the text
 * stays in the body but no Citation row was recorded (playbook/citations.md).
 */
export const NOTE_INVALID_CITATION_MESSAGE =
  "Ces ARK ne figurent dans aucune version du corpus : la citation a été " +
  "conservée dans le texte mais n'a pas été indexée. Vérifie l'ARK avec " +
  "rag_query ou retire la citation."

/**
 * The ARK given to a corpus-text tool is not a Document (indexed, for
 * rag_get_text) of this project's corpus. Structured output, never a throw:
 * the model recovers by passing an ARK taken from a search result
 * (CLAUDE_ERROR_PATTERNS §15).
 */
export const ARK_NOT_IN_CORPUS_ERROR = "ark_not_in_corpus"
