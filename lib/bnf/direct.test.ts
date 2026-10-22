// lib/bnf/direct.test.ts
// The hybrid Gallica resolver (SDS-945), driven through an injected egress so no
// request leaves the process. OAI bodies are the live captures under
// tests/fixtures/bnf/oai/; manifests are minimal hand-built IIIF v3 JSON (the
// Presentation API is never called live).
import assert from "node:assert/strict"
import { readFileSync } from "node:fs"
import { join } from "node:path"
import { describe, it, mock } from "node:test"

import {
  type BnfEgress,
  type BnfHttpResponse,
  BnfDirectClient,
  parseRetryAfter,
} from "@/lib/bnf/direct"
import { BNF_DIRECT_CONCURRENCY } from "@/lib/constants"
import {
  BnfMcpAuthError,
  BnfMcpError,
  BnfMcpNotFoundError,
  BnfMcpRateLimitError,
} from "@/lib/mcp/errors"
import { normalizeDocument } from "@/lib/mcp/normalize"

const FIXTURES = join(process.cwd(), "tests", "fixtures", "bnf", "oai")
const PRESENTATION_BASE = "https://presentation.test/presentation/iiif/gallica/1.0.0"

const FASCICULE = "ark:/12148/bpt6k268418n"
const OCR_PRESS_ISSUE = "ark:/12148/bpt6k559134j"
const MONOGRAPH_TEXT = "ark:/12148/bpt6k9618082w"
const ESTAMPE = "ark:/12148/btv1b69497161"
const CATALOGUE_NOTICE = "ark:/12148/cb30055832f"

/** OAI fixture per ARK. */
const OAI_FIXTURE: Record<string, string> = {
  [FASCICULE]: "fascicule-bpt6k268418n.xml",
  [OCR_PRESS_ISSUE]: "fascicule-ocr-bpt6k559134j.xml",
  [MONOGRAPH_TEXT]: "monographie-texte-bpt6k9618082w.xml",
  [ESTAMPE]: "estampe-btv1b69497161.xml",
}

/** A minimal IIIF v3 manifest: `canvases` folios, optionally a Taux OCR row. */
function manifestJson(ark: string, canvases: number, tauxOcr?: string): string {
  return JSON.stringify({
    "@context": "http://iiif.io/api/presentation/3/context.json",
    id: `https://gallica.bnf.fr/iiif/${ark}/manifest.json`,
    type: "Manifest",
    label: { fr: ["Titre du manifeste"] },
    metadata:
      tauxOcr === undefined
        ? [{ label: { fr: ["Langue"] }, value: { fr: ["français"] } }]
        : [{ label: { fr: ["Taux OCR"] }, value: { fr: [tauxOcr] } }],
    items: Array.from({ length: canvases }, (_, i) => ({
      id: `https://gallica.bnf.fr/iiif/${ark}/canvas/f${i + 1}`,
      type: "Canvas",
    })),
  })
}

function respond(status: number, body: string, headers: Record<string, string> = {}): BnfHttpResponse {
  return {
    status,
    body,
    headers: { get: (name) => headers[name.toLowerCase()] ?? null },
  }
}

interface Stub {
  egress: BnfEgress
  /** Every URL requested, in order. */
  urls: string[]
  manifestCalls: () => string[]
  oaiCalls: () => string[]
}

/**
 * An egress answering OAI from the fixtures and manifests / SRU from `routes`.
 * `routes` maps a URL substring to the response (or a thrown error) for it.
 */
function stubEgress(opts: {
  viaPartner?: boolean
  manifest?: (url: string) => BnfHttpResponse | Error
  other?: (url: string) => BnfHttpResponse | Error
  onCall?: (url: string) => void
}): Stub {
  const urls: string[] = []
  const egress: BnfEgress = {
    viaPartner: opts.viaPartner ?? true,
    presentationBaseUrl: PRESENTATION_BASE,
    async getText(url) {
      urls.push(url)
      opts.onCall?.(url)
      const parsed = new URL(url)
      let answer: BnfHttpResponse | Error
      if (parsed.hostname === "oai.bnf.fr") {
        const id = parsed.searchParams.get("identifier")?.replace("oai:bnf.fr:gallica/", "")
        const file = id === null || id === undefined ? undefined : OAI_FIXTURE[id]
        answer =
          file === undefined
            ? respond(200, readFileSync(join(FIXTURES, "not-found.xml"), "utf8"))
            : respond(200, readFileSync(join(FIXTURES, file), "utf8"))
      } else if (url.includes("/presentation/v3/")) {
        if (opts.manifest === undefined) throw new Error(`unexpected manifest call: ${url}`)
        answer = opts.manifest(url)
      } else {
        if (opts.other === undefined) throw new Error(`unexpected call: ${url}`)
        answer = opts.other(url)
      }
      if (answer instanceof Error) throw answer
      return answer
    },
  }
  return {
    egress,
    urls,
    manifestCalls: () => urls.filter((u) => u.includes("/presentation/v3/")),
    oaiCalls: () => urls.filter((u) => new URL(u).hostname === "oai.bnf.fr"),
  }
}

/** Retry timings that never sleep, with a single attempt unless told otherwise. */
const NO_RETRY = { attempts: 1, baseMs: 0, capMs: 0 }

describe("hybrid resolver: rule 2, OAI says 'mode texte'", () => {
  it("resolves a text monograph with zero manifest calls", async () => {
    const stub = stubEgress({})
    const doc = await new BnfDirectClient({ egress: stub.egress, retry: NO_RETRY }).resolveArk(
      MONOGRAPH_TEXT,
      { mode: "commit" },
    )
    assert.equal(stub.manifestCalls().length, 0)
    assert.equal(stub.oaiCalls().length, 1)
    assert.equal(doc.ocr_available, true)
    assert.equal(doc.ocr_source, "oai")
  })

  it("leaves pages unset and records the OAI provenance of the count", async () => {
    const stub = stubEgress({})
    const doc = await new BnfDirectClient({ egress: stub.egress, retry: NO_RETRY }).resolveArk(
      MONOGRAPH_TEXT,
      { mode: "commit" },
    )
    assert.equal("pages" in doc, false)
    assert.equal(doc.oai_total_views, 406)
    assert.equal(doc.pages_source, "oai")
  })
})

describe("hybrid resolver: rule 3, image-like documents", () => {
  it("resolves an estampe with zero manifest calls and ocr_available false", async () => {
    const stub = stubEgress({})
    const doc = await new BnfDirectClient({ egress: stub.egress, retry: NO_RETRY }).resolveArk(
      ESTAMPE,
      { mode: "commit" },
    )
    assert.equal(stub.manifestCalls().length, 0)
    assert.equal(doc.ocr_available, false)
    assert.equal(doc.ocr_source, "image_like")
    assert.equal(normalizeDocument(doc)?.subtype, "estampes")
  })
})

describe("hybrid resolver: rule 4, a text document OAI is silent on", () => {
  it("fetches the manifest exactly once for the fascicule and takes its canvas count", async () => {
    const stub = stubEgress({ manifest: () => respond(200, manifestJson(FASCICULE, 4, "78.21 %")) })
    const doc = await new BnfDirectClient({ egress: stub.egress, retry: NO_RETRY }).resolveArk(
      FASCICULE,
      { mode: "commit" },
    )
    assert.equal(stub.manifestCalls().length, 1)
    assert.equal(
      stub.manifestCalls()[0].startsWith(`${PRESENTATION_BASE}/presentation/v3/${FASCICULE}/manifest.json`),
      true,
    )
    assert.equal(doc.pages, 4)
    assert.equal(doc.pages_source, "manifest")
    assert.equal(doc.oai_total_views, 3197)
    assert.equal(doc.ocr_available, true)
    assert.equal(doc.ocr_source, "manifest")
    assert.equal(doc.taux_ocr, 78.21)
  })

  it("keeps docType and subtype from the OAI typedoc, never from the manifest", async () => {
    const stub = stubEgress({ manifest: () => respond(200, manifestJson(FASCICULE, 4, "78.21 %")) })
    const doc = await new BnfDirectClient({ egress: stub.egress, retry: NO_RETRY }).resolveArk(
      FASCICULE,
      { mode: "commit" },
    )
    assert.equal(doc.gallica_typedoc, "periodiques:fascicules")
    assert.match(doc.title ?? "", /^Figaro : électeur/)
    const normalized = normalizeDocument(doc)
    assert.equal(normalized?.subtype, "fascicules")
    assert.equal(normalized?.docType, "press")
  })

  it("reads a manifest without a Taux OCR row as no text layer", async () => {
    const stub = stubEgress({ manifest: () => respond(200, manifestJson(FASCICULE, 4)) })
    const doc = await new BnfDirectClient({ egress: stub.egress, retry: NO_RETRY }).resolveArk(
      FASCICULE,
      { mode: "commit" },
    )
    assert.equal(doc.ocr_available, false)
    assert.equal(doc.ocr_source, "manifest")
    assert.equal("taux_ocr" in doc, false)
  })

  it("keeps the label as a text layer when the rate does not parse", async () => {
    const stub = stubEgress({ manifest: () => respond(200, manifestJson(FASCICULE, 4, "n/a")) })
    const doc = await new BnfDirectClient({ egress: stub.egress, retry: NO_RETRY }).resolveArk(
      FASCICULE,
      { mode: "commit" },
    )
    assert.equal(doc.ocr_available, true)
    assert.equal("taux_ocr" in doc, false)
  })

  it("also consults the manifest for an OCR'd press issue OAI does not mark", async () => {
    const stub = stubEgress({
      manifest: () => respond(200, manifestJson(OCR_PRESS_ISSUE, 8, "95 %")),
    })
    const doc = await new BnfDirectClient({ egress: stub.egress, retry: NO_RETRY }).resolveArk(
      OCR_PRESS_ISSUE,
      { mode: "commit" },
    )
    assert.equal(stub.manifestCalls().length, 1)
    assert.equal(doc.ocr_available, true)
    assert.equal(doc.pages, 8)
  })

  it("without a broker the manifest is unreachable: OAI silence leaves the flag unknown, never false", async () => {
    const stub = stubEgress({ viaPartner: false })
    const doc = await new BnfDirectClient({ egress: stub.egress, retry: NO_RETRY }).resolveArk(
      FASCICULE,
      { mode: "commit" },
    )
    assert.equal(stub.manifestCalls().length, 0)
    assert.equal(doc.ocr_available, null)
    assert.equal(doc.ocr_source, "oai")
    assert.equal("pages" in doc, false)
  })
})

describe("hybrid resolver: staging mode", () => {
  it("never fetches the manifest and leaves the OCR flag unknown", async () => {
    const stub = stubEgress({})
    const doc = await new BnfDirectClient({ egress: stub.egress, retry: NO_RETRY }).resolveArk(
      FASCICULE,
      { mode: "staging" },
    )
    assert.equal(stub.manifestCalls().length, 0)
    assert.equal("ocr_available" in doc, false)
    assert.equal("ocr_source" in doc, false)
    assert.equal(doc.pages_source, "oai")
    assert.equal(normalizeDocument(doc)?.subtype, "fascicules")
  })

  it("still reports a text layer OAI marks", async () => {
    const stub = stubEgress({})
    const doc = await new BnfDirectClient({ egress: stub.egress, retry: NO_RETRY }).resolveArk(
      MONOGRAPH_TEXT,
      { mode: "staging" },
    )
    assert.equal(doc.ocr_available, true)
    assert.equal(doc.ocr_source, "oai")
  })

  it("resolveArks applies the mode to every ARK of the batch", async () => {
    const stub = stubEgress({})
    const results = await new BnfDirectClient({ egress: stub.egress, retry: NO_RETRY }).resolveArks(
      [FASCICULE, OCR_PRESS_ISSUE, ESTAMPE],
      { mode: "staging" },
    )
    assert.equal(stub.manifestCalls().length, 0)
    assert.deepEqual(results.map((r) => r.ok), [true, true, true])
  })
})

describe("hybrid resolver: staged records", () => {
  it("skips the OAI fetch for a staged ARK and runs the OCR rule on it", async () => {
    const staging = stubEgress({})
    const client = new BnfDirectClient({ egress: staging.egress, retry: NO_RETRY })
    const stagedDoc = await client.resolveArk(FASCICULE, { mode: "staging" })

    const stub = stubEgress({ manifest: () => respond(200, manifestJson(FASCICULE, 4, "78.21 %")) })
    const results = await new BnfDirectClient({ egress: stub.egress, retry: NO_RETRY }).resolveArks(
      [FASCICULE, ESTAMPE],
      { mode: "commit", staged: new Map([[FASCICULE, stagedDoc]]) },
    )
    assert.deepEqual(results.map((r) => r.ok), [true, true])
    // OAI is asked for the ESTAMPE only; the staged fascicule is not refetched.
    assert.equal(stub.oaiCalls().length, 1)
    assert.equal(stub.manifestCalls().length, 1)
    const fascicule = results[0]
    assert.equal(fascicule.ok && fascicule.document.ocr_source, "manifest")
    assert.equal(fascicule.ok && fascicule.document.pages, 4)
  })
})

describe("hybrid resolver: rule 4 failures never guess a flag", () => {
  it("a manifest 404 returns the record with ocr_available null and warns", async () => {
    const warn = mock.method(console, "warn", () => undefined)
    try {
      const stub = stubEgress({ manifest: () => respond(404, "") })
      const doc = await new BnfDirectClient({ egress: stub.egress, retry: NO_RETRY }).resolveArk(
        FASCICULE,
        { mode: "commit" },
      )
      assert.equal(doc.ocr_available, null)
      assert.equal("ocr_source" in doc, false)
      assert.match(doc.title ?? "", /^Figaro : électeur/)
      assert.deepEqual(warn.mock.calls[0].arguments, [
        "[bnf-direct] manifest not found",
        { ark: FASCICULE },
      ])
    } finally {
      warn.mock.restore()
    }
  })

  it("a manifest 5xx rejects with a transient BnfMcpError", async () => {
    const stub = stubEgress({ manifest: () => respond(503, "unavailable") })
    const client = new BnfDirectClient({ egress: stub.egress, retry: NO_RETRY })
    await assert.rejects(client.resolveArk(FASCICULE, { mode: "commit" }), (err: unknown) => {
      assert.ok(err instanceof BnfMcpError)
      assert.equal(err instanceof BnfMcpNotFoundError, false)
      assert.equal(err instanceof BnfMcpAuthError, false)
      assert.match(err.message, /HTTP 503/)
      return true
    })
  })

  it("a transient manifest failure is retried with backoff before it surfaces", async () => {
    let attempts = 0
    const stub = stubEgress({
      manifest: () => {
        attempts++
        return attempts < 3 ? respond(502, "bad gateway") : respond(200, manifestJson(FASCICULE, 4, "90 %"))
      },
    })
    const client = new BnfDirectClient({
      egress: stub.egress,
      retry: { attempts: 3, baseMs: 0, capMs: 0 },
    })
    const doc = await client.resolveArk(FASCICULE, { mode: "commit" })
    assert.equal(attempts, 3)
    assert.equal(doc.pages, 4)
  })

  it("a manifest body that is not JSON is a transient BnfMcpError", async () => {
    const stub = stubEgress({ manifest: () => respond(200, "<html>captcha</html>") })
    const client = new BnfDirectClient({ egress: stub.egress, retry: NO_RETRY })
    await assert.rejects(client.resolveArk(FASCICULE, { mode: "commit" }), /not valid JSON/)
  })

  it("an OAI not-found stays terminal and never reaches the manifest", async () => {
    const stub = stubEgress({})
    const client = new BnfDirectClient({ egress: stub.egress, retry: NO_RETRY })
    await assert.rejects(
      client.resolveArk("ark:/12148/bpt6kdoesnotexist000", { mode: "commit" }),
      BnfMcpNotFoundError,
    )
    assert.equal(stub.manifestCalls().length, 0)
  })
})

describe("Retry-After", () => {
  it("a 429 carries the delta-seconds header as retryAfterMs", async () => {
    const stub = stubEgress({})
    const rateLimited: BnfEgress = {
      ...stub.egress,
      getText: async () => respond(429, "slow down", { "retry-after": "7" }),
    }
    const client = new BnfDirectClient({ egress: rateLimited, retry: NO_RETRY })
    await assert.rejects(client.resolveArk(FASCICULE, { mode: "commit" }), (err: unknown) => {
      assert.ok(err instanceof BnfMcpRateLimitError)
      assert.equal(err.retryAfterMs, 7000)
      return true
    })
  })

  it("a 429 without the header leaves retryAfterMs undefined", async () => {
    const stub = stubEgress({})
    const rateLimited: BnfEgress = { ...stub.egress, getText: async () => respond(429, "") }
    const client = new BnfDirectClient({ egress: rateLimited, retry: NO_RETRY })
    await assert.rejects(client.resolveArk(FASCICULE, { mode: "commit" }), (err: unknown) => {
      assert.ok(err instanceof BnfMcpRateLimitError)
      assert.equal(err.retryAfterMs, undefined)
      return true
    })
  })

  it("parseRetryAfter reads delta-seconds, an HTTP-date, and rejects junk", () => {
    const now = Date.parse("2026-10-22T12:00:00Z")
    assert.equal(parseRetryAfter("30", now), 30_000)
    assert.equal(parseRetryAfter("Thu, 22 Oct 2026 12:01:00 GMT", now), 60_000)
    assert.equal(parseRetryAfter("Thu, 22 Oct 2026 11:00:00 GMT", now), 0)
    assert.equal(parseRetryAfter("soon", now), undefined)
    assert.equal(parseRetryAfter(null, now), undefined)
  })
})

describe("abort", () => {
  it("an aborted signal stops further ARKs from starting", async () => {
    const controller = new AbortController()
    const reason = new Error("deadline")
    const stub = stubEgress({ onCall: () => controller.abort(reason) })
    const client = new BnfDirectClient({
      signal: controller.signal,
      egress: stub.egress,
      retry: NO_RETRY,
    })
    const arks = Array.from({ length: 4 * BNF_DIRECT_CONCURRENCY }, () => MONOGRAPH_TEXT)
    const results = await client.resolveArks(arks, { mode: "staging" })

    assert.ok(stub.urls.length <= BNF_DIRECT_CONCURRENCY, `${stub.urls.length} requests started`)
    const failed = results.filter((r) => !r.ok)
    assert.ok(failed.length >= arks.length - BNF_DIRECT_CONCURRENCY)
    for (const r of failed) assert.equal(r.ok === false && r.error, reason)
  })

  it("the signal reaches the retry loop: no retry after the abort", async () => {
    const controller = new AbortController()
    const stub = stubEgress({})
    let calls = 0
    const failing: BnfEgress = {
      ...stub.egress,
      getText: async () => {
        calls++
        controller.abort(new Error("deadline"))
        return respond(503, "")
      },
    }
    const client = new BnfDirectClient({
      signal: controller.signal,
      egress: failing,
      retry: { attempts: 5, baseMs: 0, capMs: 0 },
    })
    await assert.rejects(client.resolveArk(MONOGRAPH_TEXT, { mode: "commit" }), /HTTP 503/)
    assert.equal(calls, 1)
  })
})

describe("classifyCanonical", () => {
  const SPARQL_EMPTY = JSON.stringify({ results: { bindings: [] } })
  const UNIMARC_EMPTY = "<srw:searchRetrieveResponse xmlns:srw='x'></srw:searchRetrieveResponse>"

  function canonicalStub(routes: { sparql: () => BnfHttpResponse | Error; unimarc: () => BnfHttpResponse | Error }) {
    return stubEgress({
      other: (url) => (url.includes("sparql") ? routes.sparql() : routes.unimarc()),
    })
  }

  it("rethrows what is not a BnfMcpError instead of reporting api_error", async () => {
    const stub = canonicalStub({
      sparql: () => new TypeError("programming error"),
      unimarc: () => respond(200, UNIMARC_EMPTY),
    })
    const client = new BnfDirectClient({ egress: stub.egress, retry: NO_RETRY })
    await assert.rejects(client.classifyCanonical(CATALOGUE_NOTICE), TypeError)
  })

  it("logs a BnF failure with its route and ark, then reports api_error", async () => {
    const warn = mock.method(console, "warn", () => undefined)
    try {
      const stub = canonicalStub({
        sparql: () => respond(503, ""),
        unimarc: () => respond(200, UNIMARC_EMPTY),
      })
      const client = new BnfDirectClient({ egress: stub.egress, retry: NO_RETRY })
      const outcome = await client.classifyCanonical(CATALOGUE_NOTICE)
      assert.equal(outcome.status, "api_error")
      assert.equal(warn.mock.calls.length, 1)
      const [message, context] = warn.mock.calls[0].arguments as [string, { ark: string; err: unknown }]
      assert.equal(message, "[bnf-direct] canonical via sparql failed")
      assert.equal(context.ark, CATALOGUE_NOTICE)
      assert.ok(context.err instanceof BnfMcpError)
    } finally {
      warn.mock.restore()
    }
  })

  it("an unparsable SPARQL body is a BnF failure, not a programming error", async () => {
    const warn = mock.method(console, "warn", () => undefined)
    try {
      const stub = canonicalStub({
        sparql: () => respond(200, "<html>proxy</html>"),
        unimarc: () => respond(200, UNIMARC_EMPTY),
      })
      const client = new BnfDirectClient({ egress: stub.egress, retry: NO_RETRY })
      assert.equal((await client.classifyCanonical(CATALOGUE_NOTICE)).status, "api_error")
    } finally {
      warn.mock.restore()
    }
  })

  it("not_digitized needs both routes to run cleanly", async () => {
    const stub = canonicalStub({
      sparql: () => respond(200, SPARQL_EMPTY),
      unimarc: () => respond(200, UNIMARC_EMPTY),
    })
    const client = new BnfDirectClient({ egress: stub.egress, retry: NO_RETRY })
    assert.equal((await client.classifyCanonical(CATALOGUE_NOTICE)).status, "not_digitized")
  })

  it("upgrades through SPARQL when a reproduction is linked", async () => {
    const stub = canonicalStub({
      sparql: () =>
        respond(
          200,
          JSON.stringify({
            results: { bindings: [{ gallica: { value: "https://gallica.bnf.fr/ark:/12148/bpt6k104247x" } }] },
          }),
        ),
      unimarc: () => new Error("must not be reached"),
    })
    const client = new BnfDirectClient({ egress: stub.egress, retry: NO_RETRY })
    assert.deepEqual(await client.classifyCanonical(CATALOGUE_NOTICE), {
      ark: CATALOGUE_NOTICE,
      status: "upgraded",
      canonical: "ark:/12148/bpt6k104247x",
    })
  })
})

describe("catalogue SRU", () => {
  const SRU = `<?xml version="1.0"?>
<srw:searchRetrieveResponse xmlns:srw="http://www.loc.gov/zing/srw/" xmlns:dc="http://purl.org/dc/elements/1.1/">
  <srw:records><srw:record><srw:recordData>
    <oai_dc:dc xmlns:oai_dc="http://www.openarchives.org/OAI/2.0/oai_dc/">
      <dc:title>Les Misérables</dc:title>
      <dc:creator>Hugo, Victor</dc:creator>
      <dc:subject>Roman</dc:subject>
      <dc:subject>Paris</dc:subject>
      <dc:subject>  Roman  </dc:subject>
    </oai_dc:dc>
  </srw:recordData></srw:record></srw:records>
</srw:searchRetrieveResponse>`

  it("extracts deduplicated subjects", async () => {
    const stub = stubEgress({ other: () => respond(200, SRU) })
    const doc = await new BnfDirectClient({ egress: stub.egress, retry: NO_RETRY }).resolveArk(
      CATALOGUE_NOTICE,
      { mode: "commit" },
    )
    assert.deepEqual(doc.subject, ["Roman", "Paris"])
    assert.equal(doc.author, "Hugo, Victor")
    assert.equal(stub.manifestCalls().length, 0)
  })

  it("omits subject when the record has none", async () => {
    const stub = stubEgress({
      other: () => respond(200, SRU.replace(/<dc:subject>[\s\S]*?<\/dc:subject>/g, "")),
    })
    const doc = await new BnfDirectClient({ egress: stub.egress, retry: NO_RETRY }).resolveArk(
      CATALOGUE_NOTICE,
      { mode: "commit" },
    )
    assert.equal("subject" in doc, false)
  })
})
