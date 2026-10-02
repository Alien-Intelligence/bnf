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

/**
 * Every agent tool that MUTATES project state, and therefore authorises through
 * its Policy before it acts (lib/agent/tools/authorize.ts; Track E Decision 14).
 * The policy-gate test asserts this set equals the gate table, so a new mutating
 * tool cannot ship without a gate decision. `buffer_remove_by_filter` and
 * `corpus_remove_by_filter` are listed although their dry run is a read.
 */
export const MUTATING_AGENT_TOOLS: ReadonlySet<AgentToolName> = new Set<AgentToolName>([
  AGENT_TOOLS.corpusSearch,
  AGENT_TOOLS.bufferAdd,
  AGENT_TOOLS.bufferDiscard,
  AGENT_TOOLS.bufferRemoveByFilter,
  AGENT_TOOLS.bufferCommit,
  AGENT_TOOLS.bufferClear,
  AGENT_TOOLS.corpusAdd,
  AGENT_TOOLS.corpusRemove,
  AGENT_TOOLS.corpusRemoveByFilter,
  AGENT_TOOLS.ingestSubmit,
  AGENT_TOOLS.memoryWrite,
  AGENT_TOOLS.noteCreate,
  AGENT_TOOLS.noteUpdate,
  AGENT_TOOLS.noteAppend,
])
