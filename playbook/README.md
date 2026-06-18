# BnF Corpus Research — Playbook

This playbook is the rulebook the building agent uses while implementing the BnF
Corpus Research workspace described in [`../design/docs/`](../design/docs/README.md).

The design docs answer **what** to build. The playbook answers **how to build it
consistently** — file structure, naming, layering, state, validation, streaming,
and the patterns that make a multi-agent app with persistent corpus state remain
debuggable as it grows.

## Reading order

| # | Rule | Scope |
|---|------|-------|
| **App skeleton** | | |
| 01 | [Page structure](page-structure.md) | What a page file is allowed to contain |
| 02 | [Page / client split](page-client-split.md) | `page.tsx` server / `client.tsx` client |
| 03 | [Componentization](componentization.md) | Named components per shadcn primitive |
| 04 | [Forms](forms.md) | react-hook-form + Zod + shadcn `Form` |
| 05 | [UI states](ui-states.md) | Loading, empty, error — always all three |
| 06 | [New primitives](new-primitives.md) | The five gates before you touch `components/ui/` |
| **Data flow** | | |
| 07 | [Hooks](hooks.md) | `lib/queries/` server + `hooks/api/` TanStack Query client |
| 08 | [Client patterns](client-patterns.md) | The four silent-failure traps |
| 09 | [API routes](api-routes.md) | `parseBody`, `ok<T>`, typed response envelopes |
| 10 | [API layers](api-layers.md) | `withAuth` → Policy → Service stack |
| 11 | [Models](models.md) | `models/<name>/{schema,queries,service,policy,types}.ts` |
| 12 | [Constants](constants.md) | No magic strings; domain enums next to schemas |
| 13 | [i18n](i18n.md) | `next-intl`, French default, both locale files updated together |
| **BnF-specific** | | |
| 14 | [Corpus versioning](corpus-versioning.md) | Versions, deltas, head vs. ingested pointers |
| 15 | [Agent streaming](agent-streaming.md) | Claude loops, SSE event protocol, tool-call logging |
| 16 | [MCP client](mcp-client.md) | BnF MCP integration, ARK normalization, IIIF links |
| 17 | [Ingestion jobs](ingestion-jobs.md) | Async job runner contract, stage progress |
| 18 | [Citations](citations.md) | `[[ark\|label\|folio]]` parsing, rendering, deep-links |
| 19 | [Memory](memory.md) | Project memory vs. session context — they are not the same thing |

## How to use this playbook

- Read 01–13 once before writing any feature code; they describe the spine of
  the app. Refer back to them every time you create a file.
- Read 14–19 before touching the feature each one names. The BnF-specific rules
  encode invariants the design docs spell out — getting them wrong silently
  breaks corpus state, retrieval, or onboarding.
- When a rule says "forbidden", it means: if you write it that way, code review
  rejects it. The rules exist because the alternative has cost us a debug
  session somewhere.

## Status legend

- ✅ **Required** — this is the only correct form.
- 🔶 **Recommended default** — adopt unless you have a specific reason not to;
  document the reason where you deviate.
- ⛔ **Deferred** — owned by infrastructure outside this app (data cluster, BnF MCP).
  This playbook tells you the *contract* the app needs; the implementation is elsewhere.
