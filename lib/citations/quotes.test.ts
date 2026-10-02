// lib/citations/quotes.test.ts
// The pure quote extractor: which spans of a note body are quotations, what
// citation each one is attributed to, and how the text splits into segments
// and tokens for the matcher.
import { test } from "node:test"
import assert from "node:assert/strict"
import { appearsQuotedIn, extractQuotes, normalizeToken } from "./quotes"
import type { ExtractedQuote } from "./quotes"

const ARK = "ark:/12148/bpt6k822781z"
const CITE = (folio: number) => `[[${ARK}|Le Populaire, 1937|${folio}]]`

function words(q: ExtractedQuote): string[] {
  return q.segments.flatMap((s) => s.tokens.map((t) => (t.kind === "word" ? t.norm : "[illisible]")))
}

test("nested guillemets: the outer span is one quote and the inner pair is content", () => {
  const md = `Il rapporte : « le maire déclare « c'est fini » et s'en va » ${CITE(2)}.`
  const quotes = extractQuotes(md)
  assert.equal(quotes.length, 1)
  assert.equal(quotes[0].form, "guillemets")
  assert.equal(quotes[0].raw, "le maire déclare « c'est fini » et s'en va")
  assert.deepEqual(quotes[0].citation, { ark: ARK, folio: 2 })
  assert.equal(quotes[0].index, md.indexOf("«"))
})

test("curly quotes are a quote form; a curly pair inside guillemets is content", () => {
  const md = `He wrote “the fire spread to the kitchens” ${CITE(1)} and later « on dit “fini” à tous » ${CITE(1)}.`
  const quotes = extractQuotes(md)
  assert.deepEqual(
    quotes.map((q) => [q.form, q.raw]),
    [
      ["curly", "the fire spread to the kitchens"],
      ["guillemets", "on dit “fini” à tous"],
    ],
  )
})

test("a blockquote without guillemets is one quote, attributed to the citation on the line after it", () => {
  const md = [
    "## Causes",
    "",
    "> Les premiers témoins accusent l'imprudence",
    "> du personnel des cuisines.",
    "",
    `${CITE(2)}`,
    "",
    "Suite de la note.",
  ].join("\n")
  const quotes = extractQuotes(md)
  assert.equal(quotes.length, 1)
  assert.equal(quotes[0].form, "blockquote")
  assert.equal(quotes[0].raw, "Les premiers témoins accusent l'imprudence\ndu personnel des cuisines.")
  assert.deepEqual(quotes[0].citation, { ark: ARK, folio: 2 })
})

test("a blockquote with inner guillemets yields only the guillemet spans", () => {
  const md = `> Le journal écrit : « un court-circuit a provoqué le sinistre » et commente longuement. ${CITE(2)}`
  const quotes = extractQuotes(md)
  assert.equal(quotes.length, 1)
  assert.equal(quotes[0].form, "guillemets")
  assert.equal(quotes[0].raw, "un court-circuit a provoqué le sinistre")
  assert.deepEqual(quotes[0].citation, { ark: ARK, folio: 2 })
})

test("attribution: the first citation after the closing mark wins over one before", () => {
  const md = `Selon ${CITE(1)}, « un court-circuit a provoqué le sinistre » ${CITE(2)}.`
  assert.deepEqual(extractQuotes(md)[0].citation, { ark: ARK, folio: 2 })
})

test("attribution: with no citation after, the nearest one before in the same block", () => {
  const md = `Le rapport ${CITE(3)} conclut que « un court-circuit a provoqué le sinistre ».`
  assert.deepEqual(extractQuotes(md)[0].citation, { ark: ARK, folio: 3 })
})

test("attribution: another quote opening between the quote and the citation breaks the link", () => {
  const md = `« un court-circuit a provoqué le sinistre » puis « l'imprudence n'y est pour rien » ${CITE(2)}.`
  const quotes = extractQuotes(md)
  assert.equal(quotes[0].citation, null)
  assert.deepEqual(quotes[1].citation, { ark: ARK, folio: 2 })
})

test("attribution: a citation in another paragraph does not count", () => {
  const md = `« un court-circuit a provoqué le sinistre »\n\nVoir ${CITE(2)}.`
  assert.equal(extractQuotes(md)[0].citation, null)
})

test("inline and fenced code are ignored", () => {
  const md = [
    "Le marqueur `« ceci n'est pas une citation »` est une syntaxe.",
    "",
    "```",
    "« ni ceci, dans un bloc de code »",
    "```",
    "",
    `Mais « ceci est une vraie citation de la presse » ${CITE(1)}.`,
  ].join("\n")
  const quotes = extractQuotes(md)
  assert.equal(quotes.length, 1)
  assert.equal(quotes[0].raw, "ceci est une vraie citation de la presse")
})

test("[…] and [...] are elisions; (…) is an elision AND counts as non-standard", () => {
  const md = `« accusent l'imprudence […] du personnel [...] des cuisines (…) du casino » ${CITE(2)}`
  const q = extractQuotes(md)[0]
  assert.equal(q.segments.length, 4)
  assert.equal(q.elisions, 3)
  assert.equal(q.nonstandardMarkers, 1)
})

test("[illisible] and [mot] become the illegible and bracketed tokens", () => {
  const md = `« la [maison] forestière [illisible] depuis l'aube » ${CITE(3)}`
  const q = extractQuotes(md)[0]
  const tokens = q.segments[0].tokens
  assert.deepEqual(tokens[1], { kind: "word", norm: "maison", bracketed: true })
  assert.deepEqual(tokens[3], { kind: "illegible" })
  assert.deepEqual(tokens[0], { kind: "word", norm: "la", bracketed: false })
  assert.equal(q.words, 6)
})

test("citations and image embeds inside a quote are removed from its text", () => {
  const md = `« du personnel ${CITE(2)} des cuisines ![[${ARK}|une|2]] du casino »`
  const q = extractQuotes(md)[0]
  assert.deepEqual(words(q), ["du", "personnel", "des", "cuisines", "du", "casino"])
})

test("short spans (terms, titles) are extracted with their word count so the check can skip them", () => {
  const md = `Le journal « Le Figaro » ${CITE(1)} et le terme « Alamans ».`
  const quotes = extractQuotes(md)
  assert.deepEqual(quotes.map((q) => q.words), [2, 1])
})

test("normalisation: NFC, French lower-case, apostrophes, emphasis and edge punctuation", () => {
  assert.equal(normalizeToken("L’IMPRUDENCE,"), "l'imprudence")
  assert.equal(normalizeToken("**ma:son**"), "ma:son")
  assert.equal(normalizeToken("«répu-"), "répu")
  assert.equal(normalizeToken("établi"), "établi")
  assert.equal(normalizeToken("—"), "")
})

test("markdown emphasis around a quoted phrase does not change its tokens", () => {
  const md = `« *accusent* l'**imprudence** du _personnel_ » ${CITE(2)}`
  assert.deepEqual(words(extractQuotes(md)[0]), ["accusent", "l'imprudence", "du", "personnel"])
})

test("appearsQuotedIn: the same span between marks counts, a sub-phrase of an old quote does not", () => {
  const prior = `« Dès l'aube, une foule considérable se pressait » ${CITE(1)}\n\n> Bloc cité\n> sur deux lignes.`
  assert.equal(appearsQuotedIn(prior, { raw: "Dès l'aube, une foule considérable se pressait", form: "guillemets" }), true)
  assert.equal(appearsQuotedIn(prior, { raw: "une foule considérable se pressait", form: "guillemets" }), false)
  assert.equal(appearsQuotedIn(prior, { raw: "Dès l'aube, une foule considérable se pressait", form: "curly" }), false)
  assert.equal(appearsQuotedIn(prior, { raw: "Bloc cité\nsur deux lignes.", form: "blockquote" }), true)
})

test("appearsQuotedIn: a guillemet span that wraps inside a blockquote is found in the prior body", () => {
  const prior = `> Le journal écrit : « un court-circuit a\n> provoqué le sinistre » ${CITE(2)}`
  const [q] = extractQuotes(prior)
  assert.equal(q.raw, "un court-circuit a\nprovoqué le sinistre")
  assert.equal(appearsQuotedIn(prior, q), true)
})
