// tests/models/documents/ark-kind.test.ts
// classifyArkKind — the record kind a buffer row or corpus document IS, read
// from the identifier form and the canonical type (Track E Phase 3). dc:type
// cannot tell a press issue from a monograph (Gallica marks both `text`); the
// `cb…/date` collection form, the ARK prefix and the search's doc_type can.
// One case per rule branch. Lives under tests/ because `npm test` does not glob
// models/.
import { test } from "node:test"
import assert from "node:assert/strict"
import { ARK_KIND, ARK_KIND_COLOR, DOC_TYPE, classifyArkKind } from "@/models/documents/schema"
import { BUFFER_ARK_KIND_VALUES } from "@/models/buffer/schema"

test("rule 1: a collection entry (cb…/date before toFullArk) is a periodical collection", () => {
  assert.equal(
    classifyArkKind({ ark: "ark:/12148/cb34355551z", collectionEntry: true, docType: "press" }),
    ARK_KIND.PERIODICAL_COLLECTION,
  )
  // Even with no type: the identifier form is the stronger signal.
  assert.equal(
    classifyArkKind({ ark: "ark:/12148/cb34355551z", collectionEntry: true, docType: null }),
    ARK_KIND.PERIODICAL_COLLECTION,
  )
})

test("rule 2: a cb… id is a periodical collection when typed press, otherwise a catalogue notice", () => {
  assert.equal(
    classifyArkKind({ ark: "ark:/12148/cb34355551z", collectionEntry: false, docType: "press" }),
    ARK_KIND.PERIODICAL_COLLECTION,
  )
  assert.equal(
    classifyArkKind({ ark: "ark:/12148/cb32895690b", collectionEntry: false, docType: null }),
    ARK_KIND.CATALOGUE_NOTICE,
  )
  assert.equal(
    classifyArkKind({ ark: "ark:/12148/cb32895690b", collectionEntry: false, docType: "book" }),
    ARK_KIND.CATALOGUE_NOTICE,
  )
})

test("rule 3: a digitized id takes its kind from the canonical type", () => {
  const d = (ark: string, docType: string | null) => classifyArkKind({ ark, collectionEntry: false, docType })
  assert.equal(d("ark:/12148/bpt6k7549530", "press"), ARK_KIND.PERIODICAL_ISSUE)
  assert.equal(d("ark:/12148/bpt6k2839841", "book"), ARK_KIND.MONOGRAPH)
  assert.equal(d("ark:/12148/btv1b8470216w", "image"), ARK_KIND.IMAGE)
  assert.equal(d("ark:/12148/btv1b8470216w", "poster"), ARK_KIND.IMAGE)
  assert.equal(d("ark:/12148/btv1b8470216w", "estampe"), ARK_KIND.IMAGE)
  assert.equal(d("ark:/12148/btv1b8470216w", "enlum"), ARK_KIND.IMAGE)
  assert.equal(d("ark:/12148/btv1b8470216w", "map"), ARK_KIND.OTHER_DOCUMENT)
  assert.equal(d("ark:/12148/btv1b8470216w", "manuscript"), ARK_KIND.OTHER_DOCUMENT)
  assert.equal(d("ark:/12148/bpt6k1", "score"), ARK_KIND.OTHER_DOCUMENT)
  assert.equal(d("ark:/12148/bpt6k1", "audio"), ARK_KIND.OTHER_DOCUMENT)
  assert.equal(d("ark:/12148/bpt6k1", "video"), ARK_KIND.OTHER_DOCUMENT)
  assert.equal(d("ark:/12148/bpt6k1", "object"), ARK_KIND.OTHER_DOCUMENT)
  assert.equal(d("ark:/12148/bpt6k1", "charte"), ARK_KIND.OTHER_DOCUMENT)
  assert.equal(d("ark:/12148/bd6t511758012", "press"), ARK_KIND.PERIODICAL_ISSUE)
  // `text` is genuinely ambiguous (a monograph or an issue), as are `other` and null.
  assert.equal(d("ark:/12148/bpt6k7549530", "text"), ARK_KIND.UNKNOWN)
  assert.equal(d("ark:/12148/bpt6k7549530", "other"), ARK_KIND.UNKNOWN)
  assert.equal(d("ark:/12148/bpt6k7549530", null), ARK_KIND.UNKNOWN)
})

test("rule 4: anything else is unknown; short ids work like full ARKs", () => {
  assert.equal(classifyArkKind({ ark: "ark:/12148/temp-work/abc", collectionEntry: false, docType: "book" }), ARK_KIND.UNKNOWN)
  assert.equal(classifyArkKind({ ark: "ark:/99999/xyz", collectionEntry: false, docType: "book" }), ARK_KIND.UNKNOWN)
  assert.equal(classifyArkKind({ ark: "bpt6k2839841", collectionEntry: false, docType: "book" }), ARK_KIND.MONOGRAPH)
})

test("every kind has a colour and the new doc types exist in the vocabulary", () => {
  for (const kind of Object.values(ARK_KIND)) {
    assert.equal(typeof ARK_KIND_COLOR[kind], "string", `${kind} has a colour`)
  }
  assert.ok(DOC_TYPE.text, "text (texte imprimé, nature indéterminée)")
  assert.ok(DOC_TYPE.object, "object — GALLICA_DOC_TYPE maps `objet` to it, so the UI must know it")
})

test("the buffer candidate schema accepts exactly the ARK_KIND values", () => {
  assert.deepEqual([...BUFFER_ARK_KIND_VALUES].sort(), Object.values(ARK_KIND).sort())
})
