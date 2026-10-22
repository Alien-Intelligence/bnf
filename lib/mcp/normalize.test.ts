// lib/mcp/normalize.test.ts
// parseBnfDate — the one parser every BnF date goes through, for Document rows
// (normalizeDocument) and buffer rows (corpus_search). Found bug (Track E):
// Gallica dates a press ISSUE as a full ISO date ("1937-07-12"), which matched
// no rule and fell to "unparseable": year null, so every issue was invisible
// to year filters and the period histogram (1 249 of 1 249 such documents on
// the track DB).
import { test } from "node:test"
import assert from "node:assert/strict"
import { readFileSync } from "node:fs"
import { join } from "node:path"
import { parseGallicaOaiRecord } from "@/lib/bnf/oai-record"
import type { BnfMcpDocumentDetail } from "@/lib/bnf/types"
import {
  NORMALIZE_REJECTION,
  normalizeDocument,
  normalizeMany,
  parseBnfDate,
  type NormalizeRejection,
} from "./normalize"

test("a full ISO date (a press issue) gives its year and keeps the date as label", () => {
  assert.deepEqual(parseBnfDate("1937-07-12"), { year: 1937, label: "1937-07-12" })
  assert.deepEqual(parseBnfDate("1955-03"), { year: 1955, label: "1955-03" })
})

test("the existing rules are unchanged", () => {
  assert.deepEqual(parseBnfDate(null), { year: null, label: null })
  assert.deepEqual(parseBnfDate("  "), { year: null, label: null })
  assert.deepEqual(parseBnfDate("1862"), { year: 1862, label: null })
  assert.deepEqual(parseBnfDate("vers 1890"), { year: 1890, label: "vers 1890" })
  assert.deepEqual(parseBnfDate("1850-1860"), { year: 1850, label: "1850–1860" })
  assert.deepEqual(parseBnfDate("XIXe siècle"), { year: null, label: "XIXe siècle" })
  assert.deepEqual(parseBnfDate("s.d."), { year: null, label: "s.d." })
})

// ---------------------------------------------------------------------------
// pages / subtype / OCR flag for Gallica OAI records (SDS-945)
// ---------------------------------------------------------------------------

const OAI_FIXTURES = join(process.cwd(), "tests", "fixtures", "bnf", "oai")

function oaiDetail(file: string, ark: string): BnfMcpDocumentDetail {
  return parseGallicaOaiRecord(readFileSync(join(OAI_FIXTURES, file), "utf8"), ark)
}

function normalized(detail: BnfMcpDocumentDetail) {
  const doc = normalizeDocument(detail)
  assert.notEqual(doc, null)
  return doc!
}

test("a fascicule's collection-level view count (3197 vs 4 folios) is not its page count", () => {
  const detail = oaiDetail("fascicule-bpt6k268418n.xml", "ark:/12148/bpt6k268418n")
  assert.equal(detail.oai_total_views, 3197)
  const doc = normalized(detail)
  assert.equal(doc.pages, null)
  assert.equal(doc.subtype, "fascicules")
  assert.equal(doc.docType, "press")
})

test("a fascicule with no view count has no pages", () => {
  const { oai_total_views: _dropped, ...detail } = oaiDetail(
    "fascicule-bpt6k268418n.xml",
    "ark:/12148/bpt6k268418n",
  )
  assert.equal(normalized(detail).pages, null)
})

test("a monograph keeps its count and has no subtype", () => {
  const detail = oaiDetail("monographie-texte-bpt6k9618082w.xml", "ark:/12148/bpt6k9618082w")
  const doc = normalized(detail)
  assert.equal(doc.pages, detail.oai_total_views)
  assert.equal(doc.pages, 406)
  assert.equal(doc.subtype, null)
  assert.equal(doc.docType, "book")
  assert.equal(doc.ocrAvailable, true)
})

test("an estampe gets the 'estampes' subtype", () => {
  const doc = normalized(oaiDetail("estampe-btv1b69497161.xml", "ark:/12148/btv1b69497161"))
  assert.equal(doc.subtype, "estampes")
  assert.equal(doc.docType, "image")
})

test("a press record without a typedoc has no pages", () => {
  const parsed = oaiDetail("no-typedoc-trimmed-fascicule.xml", "ark:/12148/bpt6k268418n")
  assert.equal(parsed.gallica_typedoc, undefined)
  assert.ok(parsed.oai_total_views !== undefined)
  // End to end: the parser surfaces the press label from the <dc:type> list.
  assert.equal(parsed.doc_type, "publication en série imprimée")
  const doc = normalized(parsed)
  assert.equal(doc.pages, null)
  assert.equal(doc.docType, "press")
})

test("a typedoc-less record that is not press keeps its view count", () => {
  const parsed = oaiDetail("no-typedoc-trimmed-fascicule.xml", "ark:/12148/bpt6k268418n")
  assert.equal(normalized({ ...parsed, doc_type: "texte" }).pages, parsed.oai_total_views)
})

test("a manifest canvas count is authoritative, even on a fascicule", () => {
  const detail: BnfMcpDocumentDetail = {
    ...oaiDetail("fascicule-bpt6k268418n.xml", "ark:/12148/bpt6k268418n"),
    pages: 4,
    pages_source: "manifest",
    ocr_available: false,
    ocr_source: "manifest",
  }
  const doc = normalized(detail)
  assert.equal(doc.pages, 4)
  assert.equal(doc.subtype, "fascicules")
  assert.equal(doc.ocrAvailable, false)
})

test("a manifest verdict of 'not found' keeps the OCR flag null, never false", () => {
  const detail: BnfMcpDocumentDetail = {
    ...oaiDetail("fascicule-bpt6k268418n.xml", "ark:/12148/bpt6k268418n"),
    ocr_available: null,
  }
  assert.equal(normalized(detail).ocrAvailable, null)
})

test("an OAI-only record leaves the OCR flag null", () => {
  const detail = oaiDetail("fascicule-ocr-bpt6k559134j.xml", "ark:/12148/bpt6k559134j")
  assert.equal(detail.ocr_available, undefined)
  assert.equal(normalized(detail).ocrAvailable, null)
})

test("rawMetadata keeps the provenance fields", () => {
  const detail: BnfMcpDocumentDetail = {
    ...oaiDetail("fascicule-bpt6k268418n.xml", "ark:/12148/bpt6k268418n"),
    pages: 4,
    pages_source: "manifest",
    ocr_available: true,
    ocr_source: "manifest",
  }
  assert.deepEqual(
    pick(normalized(detail).rawMetadata, ["oai_total_views", "ocr_source", "pages_source"]),
    { oai_total_views: 3197, ocr_source: "manifest", pages_source: "manifest" },
  )
})

function pick(raw: unknown, keys: string[]): Record<string, unknown> {
  const record = raw as Record<string, unknown>
  return Object.fromEntries(keys.map((k) => [k, record[k]]))
}

test("a catalogue record keeps the page count its parser gave", () => {
  const doc = normalized({ ark: "cb123456789", title: "Un livre", pages: 212 })
  assert.equal(doc.pages, 212)
})

test("normalizeMany reports every record it drops, with the reason", () => {
  const rejected: Array<[string | null, NormalizeRejection]> = []
  const kept = normalizeMany(
    [
      { ark: "ark:/12148/bpt6k9618082w", title: "Gardé" },
      { ark: "ark:/12148/bpt6k268418n" },
      { ark: "ark:/12148/temp-work/abc", title: "Travail" },
      { ark: "", title: "Sans ARK" },
    ],
    { onRejected: (ark, reason) => rejected.push([ark, reason]) },
  )
  assert.deepEqual(
    kept.map((d) => d.ark),
    ["ark:/12148/bpt6k9618082w"],
  )
  assert.deepEqual(rejected, [
    ["ark:/12148/bpt6k268418n", NORMALIZE_REJECTION.NO_TITLE],
    ["ark:/12148/temp-work/abc", NORMALIZE_REJECTION.TEMP_WORK],
    [null, NORMALIZE_REJECTION.NO_ARK],
  ])
})
