// lib/bnf/oai-record.test.ts
// Pins parseGallicaOaiRecord against OAI-PMH records captured live on
// 2026-10-22 (see tests/fixtures/bnf/oai/README.md).
import assert from "node:assert/strict"
import { readFileSync } from "node:fs"
import { join } from "node:path"
import { describe, it } from "node:test"

import { hasTextMode, parseGallicaOaiRecord, pickTypedoc, totalViews } from "@/lib/bnf/oai-record"
import {
  BnfMcpError,
  BnfMcpNotFoundError,
  BnfMcpRateLimitError,
} from "@/lib/mcp/errors"

const FIXTURES = join(process.cwd(), "tests", "fixtures", "bnf", "oai")

function fixture(name: string): string {
  return readFileSync(join(FIXTURES, name), "utf8")
}

const FASCICULE = "ark:/12148/bpt6k268418n"

describe("parseGallicaOaiRecord: fascicule (bpt6k268418n)", () => {
  const doc = parseGallicaOaiRecord(fixture("fascicule-bpt6k268418n.xml"), FASCICULE)

  it("reads the typedoc from the header setSpec", () => {
    assert.equal(doc.gallica_typedoc, "periodiques:fascicules")
  })

  it("emits the raw view count and never sets pages", () => {
    assert.equal(doc.oai_total_views, 3197)
    assert.equal("pages" in doc, false)
  })

  it("leaves ocr_available unset when OAI is silent", () => {
    assert.equal("ocr_available" in doc, false)
  })

  it("maps the Dublin Core fields and the short ARK", () => {
    assert.equal(doc.ark, "bpt6k268418n")
    assert.match(doc.title ?? "", /^Figaro/)
    assert.equal(doc.date, "1835-05-10")
    assert.equal(doc.language, "fre")
    assert.equal(doc.publisher, "[s.n.] (Paris)")
    assert.equal(doc.gallica_url, "https://gallica.bnf.fr/ark:/12148/bpt6k268418n")
    assert.equal(doc.creator, undefined)
  })

  it("prefers the press label over the generic French label when no value is an enum key", () => {
    assert.equal(doc.doc_type, "publication en série imprimée")
  })

  it("omits subject when the record has none", () => {
    assert.equal("subject" in doc, false)
  })

  it("accepts the short ARK form", () => {
    const short = parseGallicaOaiRecord(fixture("fascicule-bpt6k268418n.xml"), "bpt6k268418n")
    assert.equal(short.ark, "bpt6k268418n")
    assert.equal(short.gallica_url, "https://gallica.bnf.fr/ark:/12148/bpt6k268418n")
  })
})

describe("parseGallicaOaiRecord: OCR'd press issue without 'mode texte'", () => {
  const doc = parseGallicaOaiRecord(
    fixture("fascicule-ocr-bpt6k559134j.xml"),
    "ark:/12148/bpt6k559134j",
  )

  it("keeps the typedoc and the raw count but leaves ocr_available unset", () => {
    assert.equal(doc.gallica_typedoc, "periodiques:fascicules")
    assert.equal(doc.oai_total_views, 123753)
    assert.equal("ocr_available" in doc, false)
  })
})

describe("parseGallicaOaiRecord: monograph with 'mode texte'", () => {
  const doc = parseGallicaOaiRecord(
    fixture("monographie-texte-bpt6k9618082w.xml"),
    "ark:/12148/bpt6k9618082w",
  )

  it("sets ocr_available true", () => {
    assert.equal(doc.ocr_available, true)
  })

  it("takes the typedoc from the setSpec among several", () => {
    assert.equal(doc.gallica_typedoc, "monographies")
    assert.equal(doc.oai_total_views, 406)
  })

  it("takes the first creator and publisher", () => {
    assert.match(doc.creator ?? "", /^Tibulle/)
    assert.equal(doc.publisher, "Letourmy le jeune (Tours)")
    assert.equal(doc.date, "1794-1795")
  })
})

describe("parseGallicaOaiRecord: images:estampes", () => {
  const doc = parseGallicaOaiRecord(
    fixture("estampe-btv1b69497161.xml"),
    "ark:/12148/btv1b69497161",
  )

  it("reads the images typedoc and a single view", () => {
    assert.equal(doc.gallica_typedoc, "images:estampes")
    assert.equal(doc.oai_total_views, 1)
    assert.equal("ocr_available" in doc, false)
  })

  it("extracts subjects in document order", () => {
    assert.deepEqual(doc.subject, [
      "Louis XVI (1754-1793 ; roi de France)",
      "Louis XVI (1754-1793 ; roi de France) -- Testaments",
      "Portraits -- 1789-1799",
    ])
  })
})

describe("parseGallicaOaiRecord: subjects", () => {
  it("trims, deduplicates and drops blank subjects", () => {
    const doc = parseGallicaOaiRecord(
      fixture("subjects-duplicated-trimmed-estampe.xml"),
      "ark:/12148/btv1b69497161",
    )
    assert.deepEqual(doc.subject, [
      "Louis XVI (1754-1793 ; roi de France)",
      "Louis XVI (1754-1793 ; roi de France) -- Testaments",
      "Portraits -- 1789-1799",
    ])
  })
})

describe("parseGallicaOaiRecord: record without a typedoc setSpec", () => {
  const doc = parseGallicaOaiRecord(fixture("no-typedoc-trimmed-fascicule.xml"), FASCICULE)

  it("leaves gallica_typedoc undefined and keeps the rest", () => {
    assert.equal(doc.gallica_typedoc, undefined)
    assert.equal(doc.oai_total_views, 3197)
    assert.equal(doc.doc_type, "publication en série imprimée")
  })
})

describe("parseGallicaOaiRecord: failures", () => {
  it("maps idDoesNotExist to BnfMcpNotFoundError", () => {
    assert.throws(
      () => parseGallicaOaiRecord(fixture("not-found.xml"), "ark:/12148/bpt6kdoesnotexist000"),
      BnfMcpNotFoundError,
    )
  })

  it("maps any other <error> to a plain BnfMcpError carrying the code", () => {
    const xml = `<?xml version="1.0"?><OAI-PMH xmlns="http://www.openarchives.org/OAI/2.0/"><error code="badArgument">bad</error></OAI-PMH>`
    assert.throws(
      () => parseGallicaOaiRecord(xml, FASCICULE),
      (e: unknown) =>
        e instanceof BnfMcpError &&
        !(e instanceof BnfMcpNotFoundError) &&
        !(e instanceof BnfMcpRateLimitError) &&
        /badArgument/.test(e.message),
    )
  })

  it("rejects an HTML proxy page that has a <title>", () => {
    assert.throws(
      () => parseGallicaOaiRecord(fixture("html-proxy-page.html"), FASCICULE),
      (e: unknown) =>
        e instanceof BnfMcpError &&
        !(e instanceof BnfMcpNotFoundError) &&
        /no <OAI-PMH> root/.test(e.message),
    )
  })

  it("rejects a real-world (not well-formed) HTML page as transient", () => {
    const html = "<!DOCTYPE html><html><head><meta charset=utf-8><title>Blocked</title></head><body>no</body></html>"
    assert.throws(
      () => parseGallicaOaiRecord(html, FASCICULE),
      (e: unknown) => e instanceof BnfMcpError && !(e instanceof BnfMcpNotFoundError),
    )
  })

  it("wraps malformed XML in a transient BnfMcpError with its cause", () => {
    const truncated = fixture("fascicule-bpt6k268418n.xml").slice(0, 700)
    assert.throws(
      () => parseGallicaOaiRecord(truncated, FASCICULE),
      (e: unknown) =>
        e instanceof BnfMcpError &&
        !(e instanceof BnfMcpNotFoundError) &&
        e.cause !== undefined,
    )
  })

  it("rejects an empty body as transient", () => {
    assert.throws(
      () => parseGallicaOaiRecord("", FASCICULE),
      (e: unknown) => e instanceof BnfMcpError && !(e instanceof BnfMcpNotFoundError),
    )
  })

  it("treats a deleted header as not found", () => {
    const xml = `<OAI-PMH xmlns="http://www.openarchives.org/OAI/2.0/"><GetRecord><record><header status="deleted"><identifier>x</identifier></header></record></GetRecord></OAI-PMH>`
    assert.throws(() => parseGallicaOaiRecord(xml, FASCICULE), BnfMcpNotFoundError)
  })

  it("treats a record without metadata as transient", () => {
    const xml = `<OAI-PMH xmlns="http://www.openarchives.org/OAI/2.0/"><GetRecord><record><header><identifier>x</identifier></header></record></GetRecord></OAI-PMH>`
    assert.throws(
      () => parseGallicaOaiRecord(xml, FASCICULE),
      (e: unknown) => e instanceof BnfMcpError && !(e instanceof BnfMcpNotFoundError),
    )
  })

  it("treats a record without a title as not found", () => {
    const xml = `<OAI-PMH xmlns="http://www.openarchives.org/OAI/2.0/" xmlns:oai_dc="http://www.openarchives.org/OAI/2.0/oai_dc/" xmlns:dc="http://purl.org/dc/elements/1.1/"><GetRecord><record><header><identifier>x</identifier></header><metadata><oai_dc:dc><dc:date>1900</dc:date></oai_dc:dc></metadata></record></GetRecord></OAI-PMH>`
    assert.throws(() => parseGallicaOaiRecord(xml, FASCICULE), BnfMcpNotFoundError)
  })

  it("never reads fields outside GetRecord/record", () => {
    const xml = `<OAI-PMH xmlns="http://www.openarchives.org/OAI/2.0/" xmlns:dc="http://purl.org/dc/elements/1.1/"><dc:title>stray</dc:title><GetRecord><record><header><identifier>x</identifier></header></record></GetRecord></OAI-PMH>`
    assert.throws(
      () => parseGallicaOaiRecord(xml, FASCICULE),
      (e: unknown) => e instanceof BnfMcpError && !(e instanceof BnfMcpNotFoundError),
    )
  })
})

describe("record helpers", () => {
  it("hasTextMode matches 'Avec mode texte' case-insensitively and only in descriptions", () => {
    assert.equal(hasTextMode({ description: ["x", "Avec mode texte"] }), true)
    assert.equal(hasTextMode({ description: "avec MODE  texte" }), true)
    assert.equal(hasTextMode({ title: "mode texte" }), false)
    assert.equal(hasTextMode({}), false)
  })

  it("totalViews parses the format note and ignores other formats", () => {
    assert.equal(totalViews({ format: ["image/jpeg", "Nombre total de vues :  42"] }), 42)
    assert.equal(totalViews({ format: "image/jpeg" }), undefined)
  })

  it("pickTypedoc ignores non-typedoc setSpecs", () => {
    assert.equal(
      pickTypedoc({ setSpec: ["gallica:theme:8:87", "gallica:typedoc:cartes:plan"] }),
      "cartes:plan",
    )
    assert.equal(pickTypedoc({ setSpec: "gallica:theme:8:87" }), undefined)
    assert.equal(pickTypedoc({}), undefined)
  })
})
