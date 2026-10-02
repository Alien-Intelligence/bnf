// lib/mcp/vocab.test.ts
// The canonical doc-type and language functions every buffer row goes through
// (Track E Phase 3). The doc-type table is EVERY raw `doc_type` value found in
// the 86 765 prod buffer rows (prod-evidence/usage_nulls.txt, 25 values): a
// value falling to `other` here must be genuinely unclassifiable, because the
// filters speak this vocabulary (`type: ["press"]`) and a mislabel is a filter
// that silently misses.
import { test } from "node:test"
import assert from "node:assert/strict"
import {
  GALLICA_FILTER_DOC_TYPE,
  GALLICA_SEARCHABLE_DOC_TYPE,
  canonicalDocTypeFromLabel,
  canonicalLang,
} from "./vocab"

test("every raw prod doc_type label maps to a canonical code", () => {
  const table: Array<[string, string]> = [
    ["text", "text"],
    ["image fixe", "image"],
    ["manuscript", "manuscript"],
    ["image", "image"],
    ["map", "map"],
    ["sound", "audio"],
    ["still image", "image"],
    ["manuscript cartographic resource", "map"],
    ["Genre musical : divers", "score"],
    ["Monographie imprimée", "book"],
    ["Colloque & conférence", "book"],
    ["texte", "text"],
    ["plan", "map"],
    ["Text", "text"],
    ["archival material", "other"],
    ["Monographie", "book"],
    ["Genre musical : air", "score"],
    ["Genre musical : chanson", "score"],
    ["Genre musical : opéra-ballet", "score"],
    ["manuscript music", "score"],
    ["Genre musical : valse", "score"],
    ["Texte", "text"],
    ["Image fixe", "image"],
    ["Manuscrit", "manuscript"],
  ]
  assert.equal(table.length, 24, "the 25 prod values minus the null")
  for (const [raw, code] of table) {
    const got = canonicalDocTypeFromLabel(raw)
    assert.equal(got.code, code, `"${raw}" → ${code}`)
    assert.equal(got.known, true, `"${raw}" is a known label`)
  }
})

test("Gallica search filter values and the dc:type keys map through the same table", () => {
  assert.deepEqual(canonicalDocTypeFromLabel("fascicule"), { code: "press", known: true })
  assert.deepEqual(canonicalDocTypeFromLabel("monographie"), { code: "book", known: true })
  assert.deepEqual(canonicalDocTypeFromLabel("typeAffiche"), { code: "poster", known: true })
  assert.deepEqual(canonicalDocTypeFromLabel("Affiche illustrée"), { code: "poster", known: true })
  assert.deepEqual(canonicalDocTypeFromLabel("objet"), { code: "object", known: true })
  assert.deepEqual(canonicalDocTypeFromLabel("printed text"), { code: "text", known: true })
  assert.deepEqual(canonicalDocTypeFromLabel("moving image"), { code: "video", known: true })
  assert.deepEqual(canonicalDocTypeFromLabel("three dimensional object"), { code: "object", known: true })
})

test("the part before the first ' | ' is what gets classified", () => {
  assert.deepEqual(canonicalDocTypeFromLabel("texte | Texte imprimé"), { code: "text", known: true })
  assert.deepEqual(canonicalDocTypeFromLabel("image fixe | estampe"), { code: "image", known: true })
})

test("null, empty and unknown labels", () => {
  assert.deepEqual(canonicalDocTypeFromLabel(null), { code: null, known: true })
  assert.deepEqual(canonicalDocTypeFromLabel(""), { code: null, known: true })
  assert.deepEqual(canonicalDocTypeFromLabel("   "), { code: null, known: true })
  assert.deepEqual(canonicalDocTypeFromLabel("Zorglub"), { code: "other", known: false })
})

test("ordering: cartographic beats manuscript, music beats manuscript", () => {
  assert.equal(canonicalDocTypeFromLabel("manuscript cartographic resource").code, "map")
  assert.equal(canonicalDocTypeFromLabel("musique manuscrite").code, "score")
  assert.equal(canonicalDocTypeFromLabel("manuscrit enluminé").code, "manuscript")
})

test("canonicalLang maps MARC bibliographic AND terminology codes, names, and keeps unknowns", () => {
  assert.equal(canonicalLang("ger"), "de")
  assert.equal(canonicalLang("deu"), "de")
  assert.equal(canonicalLang("fre"), "fr")
  assert.equal(canonicalLang("fra"), "fr")
  assert.equal(canonicalLang("dut"), "nl")
  assert.equal(canonicalLang("cze"), "cs")
  assert.equal(canonicalLang("rum"), "ro")
  assert.equal(canonicalLang("per"), "fa")
  assert.equal(canonicalLang("Français"), "fr")
  assert.equal(canonicalLang("french"), "fr")
  assert.equal(canonicalLang("Allemand"), "de")
  assert.equal(canonicalLang("latin"), "la")
  assert.equal(canonicalLang("fr"), "fr")
  assert.equal(canonicalLang("DE"), "de")
  assert.equal(canonicalLang("xxx"), "xxx")
  assert.equal(canonicalLang("Xyz-Q"), "xyz-q")
  assert.equal(canonicalLang(null), null)
  assert.equal(canonicalLang("  "), null)
})

test("every searchable Gallica doc_type has a strict canonical mapping", () => {
  for (const v of GALLICA_SEARCHABLE_DOC_TYPE) {
    assert.ok(typeof GALLICA_FILTER_DOC_TYPE[v] === "string", `${v} is mapped`)
  }
  assert.equal(GALLICA_FILTER_DOC_TYPE.fascicule, "press")
  assert.equal(GALLICA_FILTER_DOC_TYPE.monographie, "book")
  assert.equal(GALLICA_FILTER_DOC_TYPE.objet, "object")
})
