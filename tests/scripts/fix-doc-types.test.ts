// tests/scripts/fix-doc-types.test.ts
// The fix-doc-types backfill, over an in-memory row store, record cache and
// resolver: no database, no network. What it pins:
//   - a dry run writes nothing (no row, no cache entry);
//   - --apply writes docType, subtype and the fresh rawMetadata;
//   - a fascicule whose pages came from OAI gets pages = null, while
//     manifest-derived pages (and ocr_available, which the script cannot even
//     express) are never touched;
//   - --refresh re-fetches and overwrites the cache; without it a hit costs no
//     BnF call;
//   - a failure is reported, so the process exits nonzero.
import assert from "node:assert/strict"
import { beforeEach, describe, test } from "node:test"
import type { BnfMcpDocumentDetail, BnfMcpResolveError, BnfMcpResolveResult } from "@/lib/bnf/types"
import { BnfMcpError, BnfMcpNotFoundError, BnfMcpRateLimitError } from "@/lib/mcp/errors"
import {
  parseOptions,
  reportSummary,
  runFixDocTypes,
  type DocRow,
  type FixDocTypesDeps,
  type FixDocTypesOptions,
  type RowUpdate,
} from "@/scripts/fix-doc-types"

const FASCICULE = "ark:/12148/bpt6k268418n"
const MONOGRAPH = "ark:/12148/bpt6k1111111"
const LEGACY = "ark:/12148/bpt6k2222222"

const fasciculeRecord: BnfMcpDocumentDetail = {
  ark: FASCICULE,
  title: "Le Matin : derniers télégrammes de la nuit",
  gallica_typedoc: "periodiques:fascicules",
  oai_total_views: 3197,
}
const monographRecord: BnfMcpDocumentDetail = {
  ark: MONOGRAPH,
  title: "Essais",
  creator: "Montaigne",
  gallica_typedoc: "monographies",
  oai_total_views: 412,
}

const baseOptions: FixDocTypesOptions = {
  apply: true,
  refresh: false,
  limit: Infinity,
  batch: 10,
  delayMs: 5,
}

interface Harness {
  rows: DocRow[]
  updates: Array<{ projectId: string; ark: string; data: RowUpdate }>
  cache: Map<string, BnfMcpDocumentDetail>
  cacheWrites: BnfMcpResolveResult[]
  resolverCalls: Array<{ arks: string[]; mode: string }>
  sleeps: number[]
  /** Per-ARK resolver outcome; a missing ARK resolves to its default record. */
  outcomes: Map<string, BnfMcpDocumentDetail | Error>
  deps: FixDocTypesDeps
}

function makeHarness(rows: DocRow[]): Harness {
  const h: Harness = {
    rows,
    updates: [],
    cache: new Map(),
    cacheWrites: [],
    resolverCalls: [],
    sleeps: [],
    outcomes: new Map(),
    deps: undefined as unknown as FixDocTypesDeps,
  }
  h.deps = {
    store: {
      listResolvedGallicaRows: async () => h.rows,
      updateRow: async (key, data) => {
        h.updates.push({ ...key, data })
      },
    },
    cache: {
      found: async (arks) => new Map(arks.flatMap((a) => (h.cache.has(a) ? [[a, h.cache.get(a)!] as const] : []))),
      write: async (records) => {
        h.cacheWrites.push(...records)
        for (const r of records) h.cache.set(r.ark, r.document)
      },
    },
    resolver: {
      resolveArks: async (arks, opts) => {
        h.resolverCalls.push({ arks, mode: opts.mode })
        return arks.map((ark): BnfMcpResolveResult | BnfMcpResolveError => {
          const outcome = h.outcomes.get(ark)
          if (outcome === undefined) throw new Error(`test has no outcome for ${ark}`)
          return outcome instanceof Error
            ? { ark, ok: false, error: outcome }
            : { ark, ok: true, document: outcome }
        })
      },
    },
    sleep: async (ms) => {
      h.sleeps.push(ms)
    },
    log: () => {},
  }
  return h
}

/** A legacy-shaped row: OAI count stored as pages, no typedoc, resolved by the manifest. */
function legacyRow(over: Partial<DocRow> = {}): DocRow {
  return {
    projectId: "p1",
    ark: FASCICULE,
    docType: "book",
    subtype: null,
    pages: 4,
    rawMetadata: { title: "Le Matin", ocr_source: "manifest", pages_source: "manifest" },
    ...over,
  }
}

/** A row resolved from OAI before the page rule: it carries the typedoc and OAI's inflated count. */
function oaiRow(over: Partial<DocRow> = {}): DocRow {
  return {
    projectId: "p1",
    ark: FASCICULE,
    docType: "press",
    subtype: null,
    pages: 3197,
    rawMetadata: { title: "Le Matin", gallica_typedoc: "periodiques:fascicules", pages_source: "oai" },
    ...over,
  }
}

describe("runFixDocTypes", () => {
  let h: Harness

  beforeEach(() => {
    h = makeHarness([oaiRow()])
    h.outcomes.set(FASCICULE, fasciculeRecord)
  })

  test("a dry run fetches and reports but writes no row and no cache entry", async () => {
    const summary = await runFixDocTypes({ ...baseOptions, apply: false }, h.deps)

    assert.equal(h.resolverCalls.length, 1)
    assert.deepEqual(h.updates, [])
    assert.deepEqual(h.cacheWrites, [])
    assert.equal(summary.fetched, 1)
    assert.equal(summary.changedRows, 1)
    assert.equal(summary.pagesCleared, 1)
  })

  test("resolves OAI-only: the staging mode, never the manifest", async () => {
    await runFixDocTypes(baseOptions, h.deps)

    assert.deepEqual(h.resolverCalls, [{ arks: [FASCICULE], mode: "staging" }])
  })

  test("--apply writes docType, subtype and rawMetadata, and caches the fetched record", async () => {
    await runFixDocTypes(baseOptions, h.deps)

    assert.equal(h.updates.length, 1)
    const { data } = h.updates[0]!
    assert.equal(data.docType, "press")
    assert.equal(data.subtype, "fascicules")
    const raw = data.rawMetadata as Record<string, unknown>
    assert.equal(raw["gallica_typedoc"], "periodiques:fascicules")
    assert.equal(raw["oai_total_views"], 3197)
    assert.deepEqual(h.cacheWrites, [{ ark: FASCICULE, ok: true, document: fasciculeRecord }])
  })

  test("an OAI-provenance fascicule gets pages = null", async () => {
    await runFixDocTypes(baseOptions, h.deps)

    assert.equal(h.updates[0]!.data.pages, null)
    assert.ok("pages" in h.updates[0]!.data, "pages must be written explicitly")
  })

  test("manifest-derived pages are never touched, and the row is stamped so", async () => {
    h.rows = [legacyRow()]

    await runFixDocTypes(baseOptions, h.deps)

    assert.equal(h.updates.length, 1)
    const { data } = h.updates[0]!
    assert.ok(!("pages" in data), "pages must not be part of the update")
    assert.equal(data.docType, "press")
    assert.equal(data.subtype, "fascicules")
    const raw = data.rawMetadata as Record<string, unknown>
    assert.equal(raw["pages_source"], "manifest")
    assert.equal(raw["ocr_source"], "manifest")
  })

  test("an OAI row whose pages_source says manifest keeps its pages", async () => {
    h.rows = [
      oaiRow({
        rawMetadata: { gallica_typedoc: "periodiques:fascicules", pages_source: "manifest", ocr_source: "manifest" },
      }),
    ]

    await runFixDocTypes(baseOptions, h.deps)

    assert.ok(!("pages" in h.updates[0]!.data))
    const raw = h.updates[0]!.data.rawMetadata as Record<string, unknown>
    assert.equal(raw["pages_source"], "manifest")
    assert.equal(raw["ocr_source"], "manifest")
  })

  test("no update ever carries ocr_available or a non-null pages", async () => {
    h.rows = [legacyRow(), oaiRow({ projectId: "p2" })]

    await runFixDocTypes(baseOptions, h.deps)

    for (const { data } of h.updates) {
      assert.ok(!("ocrAvailable" in data))
      assert.ok(data.pages === undefined || data.pages === null)
    }
  })

  test("a row that is already correct is not rewritten, unless its record was fetched", async () => {
    h.rows = [oaiRow({ docType: "press", subtype: "fascicules", pages: null })]

    const fetched = await runFixDocTypes(baseOptions, h.deps)
    assert.equal(h.updates.length, 1, "a fetch persists the fresh rawMetadata even when nothing else changed")
    assert.equal(fetched.changedRows, 0)
    assert.equal(fetched.rawMetadataOnlyRows, 1)

    h.updates.length = 0
    const cached = await runFixDocTypes(baseOptions, h.deps)
    assert.equal(cached.cacheHits, 1)
    assert.equal(cached.unchangedRows, 1)
    assert.deepEqual(h.updates, [], "a cache hit with nothing to change writes nothing")
  })

  test("every row of an ARK is reconciled against its own provenance", async () => {
    h.rows = [oaiRow({ projectId: "p1" }), legacyRow({ projectId: "p2" })]

    await runFixDocTypes(baseOptions, h.deps)

    const byProject = new Map(h.updates.map((u) => [u.projectId, u.data]))
    assert.equal(byProject.get("p1")!.pages, null)
    assert.ok(!("pages" in byProject.get("p2")!))
    assert.equal(h.resolverCalls[0]!.arks.length, 1, "one ARK is fetched once for all its rows")
  })

  test("a cache hit costs no BnF call", async () => {
    h.cache.set(FASCICULE, fasciculeRecord)

    const summary = await runFixDocTypes(baseOptions, h.deps)

    assert.deepEqual(h.resolverCalls, [])
    assert.deepEqual(h.cacheWrites, [])
    assert.equal(summary.cacheHits, 1)
    assert.equal(summary.fetched, 0)
    assert.equal(h.updates[0]!.data.subtype, "fascicules")
    assert.deepEqual(h.sleeps, [], "no pacing when BnF was not called")
  })

  test("--refresh re-fetches and overwrites the cache entry", async () => {
    const stale: BnfMcpDocumentDetail = { ark: FASCICULE, title: "stale", gallica_typedoc: "monographies" }
    h.cache.set(FASCICULE, stale)

    await runFixDocTypes({ ...baseOptions, refresh: true }, h.deps)

    assert.equal(h.resolverCalls.length, 1)
    assert.deepEqual(h.cache.get(FASCICULE), fasciculeRecord)
    assert.equal(h.cacheWrites.length, 1)
    assert.equal(h.updates[0]!.data.subtype, "fascicules", "the fresh record, not the stale cached one, is applied")
  })

  test("--limit bounds the ARKs fetched, not the cache hits", async () => {
    h.rows = [oaiRow(), oaiRow({ ark: MONOGRAPH, docType: "book", pages: 412 }), legacyRow({ ark: LEGACY })]
    h.cache.set(MONOGRAPH, monographRecord)
    h.outcomes.set(LEGACY, { ark: LEGACY, title: "x", gallica_typedoc: "monographies" })

    const summary = await runFixDocTypes({ ...baseOptions, limit: 1 }, h.deps)

    assert.equal(summary.cacheHits, 1)
    assert.equal(summary.fetched, 1)
    assert.equal(summary.deferred, 1)
    assert.deepEqual(h.resolverCalls[0]!.arks, [FASCICULE])
  })

  test("paces between batches only when BnF was called", async () => {
    h.rows = [oaiRow(), oaiRow({ ark: LEGACY })]
    h.outcomes.set(LEGACY, { ark: LEGACY, title: "x", gallica_typedoc: "monographies" })

    await runFixDocTypes({ ...baseOptions, batch: 1, delayMs: 7 }, h.deps)

    assert.deepEqual(h.sleeps, [7], "one pause between the two batches, none after the last")
  })

  test("not-found is skipped; every other failure is reported, never swallowed", async () => {
    h.rows = [oaiRow(), oaiRow({ ark: MONOGRAPH }), oaiRow({ ark: LEGACY })]
    h.outcomes.set(FASCICULE, new BnfMcpNotFoundError("gone"))
    h.outcomes.set(MONOGRAPH, new BnfMcpRateLimitError("slow down"))
    h.outcomes.set(LEGACY, new BnfMcpError("boom"))

    const summary = await runFixDocTypes(baseOptions, h.deps)

    assert.equal(summary.notFound, 1)
    assert.equal(summary.rateLimited, 1)
    assert.deepEqual(
      summary.failures.map((f) => f.ark),
      [MONOGRAPH, LEGACY],
    )
    assert.deepEqual(h.updates, [])
    assert.equal(reportSummary(summary, baseOptions, () => {}), false, "a failure must make the run exit nonzero")
  })

  test("a clean run reports success", async () => {
    const summary = await runFixDocTypes(baseOptions, h.deps)

    assert.equal(reportSummary(summary, baseOptions, () => {}), true)
  })

  test("an exception from the store propagates", async () => {
    h.deps.store.updateRow = async () => {
      throw new Error("db down")
    }

    await assert.rejects(runFixDocTypes(baseOptions, h.deps), /db down/)
  })
})

describe("parseOptions", () => {
  test("defaults to a dry run with the documented pacing", () => {
    assert.deepEqual(parseOptions([]), { apply: false, refresh: false, limit: Infinity, batch: 10, delayMs: 2000 })
  })

  test("reads every flag", () => {
    assert.deepEqual(parseOptions(["--apply", "--refresh", "--limit", "5", "--batch", "2", "--delay", "100"]), {
      apply: true,
      refresh: true,
      limit: 5,
      batch: 2,
      delayMs: 100,
    })
  })

  test("rejects a bad number or an unknown flag instead of defaulting", () => {
    assert.throws(() => parseOptions(["--limit", "abc"]), /--limit expects a positive integer/)
    assert.throws(() => parseOptions(["--batch", "0"]), /--batch expects a positive integer/)
    assert.throws(() => parseOptions(["--aply"]))
  })
})
