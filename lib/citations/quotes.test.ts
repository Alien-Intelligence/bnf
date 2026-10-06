// lib/citations/quotes.test.ts
// The pure quote extractor: which spans of a note body are quotations, what
// citation each one is attributed to, and how the text splits into segments
// and tokens for the matcher.
import { test } from "node:test"
import assert from "node:assert/strict"
import { QUOTE_UNBALANCED_MARKS_MAX_PER_BLOCK } from "@/lib/constants"
import { QUOTE_FORM, QUOTE_UNVERIFIABLE_CAUSE } from "@/models/notes/schema"
import { neverOutOfTime } from "./deadline"
import { normalizeToken, quoteIdentity, scanNoteQuotes } from "./quotes"
import type { ExtractedQuote } from "./quotes"

const ARK = "ark:/12148/bpt6k822781z"
const CITE = (folio: number) => `[[${ARK}|Le Populaire, 1937|${folio}]]`

/** Scan with no budget; `excerptChars` only shapes the unbalanced / unscanned excerpts. */
function scan(md: string, excerptChars = 40) {
  return scanNoteQuotes(md, { outOfTime: neverOutOfTime, excerptChars })
}
function quotesOf(md: string): ExtractedQuote[] {
  return scan(md).quotes
}
function sameQuote(p: ExtractedQuote, q: ExtractedQuote): boolean {
  return quoteIdentity(p) === quoteIdentity(q)
}

function words(q: ExtractedQuote): string[] {
  return q.segments.flatMap((s) => s.tokens.map((t) => (t.kind === "word" ? t.norm : "[illisible]")))
}

test("nested guillemets: the outer span is one quote and the inner pair is content", () => {
  const md = `Il rapporte : « le maire déclare « c'est fini » et s'en va » ${CITE(2)}.`
  const quotes = quotesOf(md)
  assert.equal(quotes.length, 1)
  assert.equal(quotes[0].form, QUOTE_FORM.GUILLEMETS)
  assert.equal(quotes[0].raw, "le maire déclare « c'est fini » et s'en va")
  assert.deepEqual(quotes[0].citation, { ark: ARK, folio: 2 })
  assert.equal(quotes[0].index, md.indexOf("«"))
})

test("curly quotes are a quote form; a curly pair inside guillemets is content", () => {
  const md = `He wrote “the fire spread to the kitchens” ${CITE(1)} and later « on dit “fini” à tous » ${CITE(1)}.`
  const quotes = quotesOf(md)
  assert.deepEqual(
    quotes.map((q) => [q.form, q.raw]),
    [
      [QUOTE_FORM.CURLY, "the fire spread to the kitchens"],
      [QUOTE_FORM.GUILLEMETS, "on dit “fini” à tous"],
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
  const quotes = quotesOf(md)
  assert.equal(quotes.length, 1)
  assert.equal(quotes[0].form, QUOTE_FORM.BLOCKQUOTE)
  assert.equal(quotes[0].raw, "Les premiers témoins accusent l'imprudence\ndu personnel des cuisines.")
  assert.deepEqual(quotes[0].citation, { ark: ARK, folio: 2 })
})

test("a blockquote with inner guillemets yields only the guillemet spans", () => {
  const md = `> Le journal écrit : « un court-circuit a provoqué le sinistre » et commente longuement. ${CITE(2)}`
  const quotes = quotesOf(md)
  assert.equal(quotes.length, 1)
  assert.equal(quotes[0].form, QUOTE_FORM.GUILLEMETS)
  assert.equal(quotes[0].raw, "un court-circuit a provoqué le sinistre")
  assert.deepEqual(quotes[0].citation, { ark: ARK, folio: 2 })
})

test("attribution: the first citation after the closing mark wins over one before", () => {
  const md = `Selon ${CITE(1)}, « un court-circuit a provoqué le sinistre » ${CITE(2)}.`
  assert.deepEqual(quotesOf(md)[0].citation, { ark: ARK, folio: 2 })
})

test("attribution: with no citation after, the nearest one before in the same block", () => {
  const md = `Le rapport ${CITE(3)} conclut que « un court-circuit a provoqué le sinistre ».`
  assert.deepEqual(quotesOf(md)[0].citation, { ark: ARK, folio: 3 })
})

test("attribution: another quote opening between the quote and the citation breaks the link", () => {
  const md = `« un court-circuit a provoqué le sinistre » puis « l'imprudence n'y est pour rien » ${CITE(2)}.`
  const quotes = quotesOf(md)
  assert.equal(quotes[0].citation, null)
  assert.deepEqual(quotes[1].citation, { ark: ARK, folio: 2 })
})

test("attribution: a citation in another paragraph does not count", () => {
  const md = `« un court-circuit a provoqué le sinistre »\n\nVoir ${CITE(2)}.`
  assert.equal(quotesOf(md)[0].citation, null)
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
  const quotes = quotesOf(md)
  assert.equal(quotes.length, 1)
  assert.equal(quotes[0].raw, "ceci est une vraie citation de la presse")
})

test("[…] and [...] are elisions; (…) is an elision AND counts as non-standard", () => {
  const md = `« accusent l'imprudence […] du personnel [...] des cuisines (…) du casino » ${CITE(2)}`
  const q = quotesOf(md)[0]
  assert.equal(q.segments.length, 4)
  assert.equal(q.elisions, 3)
  assert.equal(q.nonstandardMarkers, 1)
})

test("[illisible] and [mot] become the illegible and bracketed tokens", () => {
  const md = `« la [maison] forestière [illisible] depuis l'aube » ${CITE(3)}`
  const q = quotesOf(md)[0]
  const tokens = q.segments[0].tokens
  assert.deepEqual(tokens[1], { kind: "word", norm: "maison", bracketed: true })
  assert.deepEqual(tokens[3], { kind: "illegible" })
  assert.deepEqual(tokens[0], { kind: "word", norm: "la", bracketed: false })
  assert.equal(q.words, 6)
})

test("citations and image embeds inside a quote are removed from its text", () => {
  const md = `« du personnel ${CITE(2)} des cuisines ![[${ARK}|une|2]] du casino »`
  const q = quotesOf(md)[0]
  assert.deepEqual(words(q), ["du", "personnel", "des", "cuisines", "du", "casino"])
})

test("short spans (terms, titles) are extracted with their word count so the check can skip them", () => {
  const md = `Le journal « Le Figaro » ${CITE(1)} et le terme « Alamans ».`
  const quotes = quotesOf(md)
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
  assert.deepEqual(words(quotesOf(md)[0]), ["accusent", "l'imprudence", "du", "personnel"])
})

test("quoteIdentity: same text, marks and citation; a sub-phrase or a new citation is a new quote", () => {
  const [old] = quotesOf(`« Dès l'aube, une foule considérable se pressait » ${CITE(1)}`)
  const same = quotesOf(`Il note : « Dès l'aube, une foule\nconsidérable se pressait » ${CITE(1)}.`)[0]
  const sub = quotesOf(`« une foule considérable se pressait » ${CITE(1)}`)[0]
  const curly = quotesOf(`“Dès l'aube, une foule considérable se pressait” ${CITE(1)}`)[0]
  const recited = quotesOf(`« Dès l'aube, une foule considérable se pressait » ${CITE(2)}`)[0]
  const uncited = quotesOf(`« Dès l'aube, une foule considérable se pressait »`)[0]
  assert.equal(sameQuote(old, same), true)
  assert.equal(sameQuote(old, sub), false)
  assert.equal(sameQuote(old, curly), false)
  assert.equal(sameQuote(old, recited), false)
  assert.equal(sameQuote(uncited, old), false, "gaining a citation makes it new")
})

test("quoteIdentity: a guillemet span that wraps inside a blockquote matches its re-sent self", () => {
  const body = `> Le journal écrit : « un court-circuit a\n> provoqué le sinistre » ${CITE(2)}`
  const [a] = quotesOf(body)
  const [b] = quotesOf(`${body}\n\nUn ajout.`)
  assert.equal(a.raw, "un court-circuit a\nprovoqué le sinistre")
  assert.equal(sameQuote(a, b), true)
})

test("an unclosed « does not hide the quotes after it in the block, and is reported", () => {
  const md = `Il écrit « une phrase jamais refermée, puis « un court-circuit a provoqué le sinistre » ${CITE(2)}.`
  assert.deepEqual(quotesOf(md).map((q) => q.raw), ["un court-circuit a provoqué le sinistre"])
  const unbalanced = scan(md, 40).unbalanced
  assert.deepEqual(unbalanced.map((u) => u.index), [md.indexOf("«")])
  assert.match(unbalanced[0].excerpt, /^une phrase jamais refermée/)
})

test("an unclosed “ does not hide a later « » quote, and is reported", () => {
  const md = `He wrote “the fire spread and « un court-circuit a provoqué le sinistre » ${CITE(2)}.`
  assert.deepEqual(quotesOf(md).map((q) => q.form), [QUOTE_FORM.GUILLEMETS])
  assert.deepEqual(scan(md, 40).unbalanced.map((u) => u.index), [md.indexOf("“")])
})

test("balanced marks report nothing", () => {
  assert.deepEqual(scan(`« a » “b” « c « d » e »`, 40).unbalanced, [])
})

test("a citation with folio 0 is not a citation: the quote stays uncited", () => {
  const md = `« un court-circuit a provoqué le sinistre » [[${ARK}|Le Populaire|0]]`
  assert.equal(quotesOf(md)[0].citation, null)
})

test("recovery from unclosed marks is capped per block; the rest of the block is reported unscanned, not dropped", () => {
  const stray = Array.from({ length: QUOTE_UNBALANCED_MARKS_MAX_PER_BLOCK + 10 }, (_, i) => `« ouvert${i}`).join(" ")
  const md = `« un court-circuit a provoqué le sinistre » ${CITE(2)} ${stray} « jamais vu après le plafond »\n\n« un autre paragraphe bien fermé » ${CITE(3)}`
  const result = scan(md, 20)
  assert.equal(result.unbalanced.length, QUOTE_UNBALANCED_MARKS_MAX_PER_BLOCK)
  // The quotes before the cap and the next block's are kept; the rest of the
  // capped block is not scanned, and says so once, from right after the mark
  // that reached the cap.
  assert.deepEqual(result.quotes.map((q) => q.raw), ["un court-circuit a provoqué le sinistre", "un autre paragraphe bien fermé"])
  const capMark = md.indexOf(`« ouvert${QUOTE_UNBALANCED_MARKS_MAX_PER_BLOCK - 1} `)
  assert.deepEqual(result.unscannedRestOfBlock.map((u) => u.index), [capMark + 1])
  assert.match(result.unscannedRestOfBlock[0].excerpt, new RegExp(`^ouvert${QUOTE_UNBALANCED_MARKS_MAX_PER_BLOCK - 1} « ouvert`))
  assert.equal(result.stopped, null)
})

test("attribution in a dense block: each quote takes its own citation, never a neighbour's", () => {
  // Every rule, repeated 300 times in ONE paragraph: the indexed lookups
  // (binary search over the block's sorted spans and citations) must give
  // what the rules say for each quote.
  const unit = (n: number) =>
    `« premier passage numéro ${n} » ${CITE(n)} puis ${CITE(n + 1000)} « second passage numéro ${n} » ` +
    `« troisième ${CITE(n + 2000)} passage ${n} » texte « quatrième passage numéro ${n} » ` +
    `« cinquième passage numéro ${n} » « sixième passage numéro ${n} »`
  const md = Array.from({ length: 300 }, (_, i) => unit(i + 1)).join(" ")
  const quotes = quotesOf(md)
  assert.equal(quotes.length, 1800)
  for (let i = 0; i < 300; i++) {
    const n = i + 1
    const folios = quotes.slice(i * 6, i * 6 + 6).map((q) => q.citation?.folio ?? null)
    assert.deepEqual(
      folios,
      [
        n, // 1. the first citation after it, before the next quote opens
        n + 1000, // 2. none after (the third opens first); the nearest before
        n + 2000, // 3. none after, the nearest before is behind the second quote: the one inside
        n + 2000, // 2. none after; the nearest before (inside the third) with no quote opening in between
        null, // the fourth opens between it and every earlier citation; none after or inside
        null, // likewise behind the fifth
      ],
      `unit ${n}`,
    )
  }
})

test("the scan stops on the deadline between blocks, keeps what it found, and says where it stopped", () => {
  const blocks = Array.from({ length: 200 }, (_, i) => `« passage numéro ${i} bien fermé » ${CITE(i + 1)}`)
  const md = blocks.join("\n\n")
  let calls = 0
  // Out of time after a few clock reads: the scan reads the clock once per
  // QUOTE_MATCH_DEADLINE_STRIDE steps (lines, characters, spans), so with
  // ~10 000 steps in this body the stop lands inside it.
  const result = scanNoteQuotes(md, {
    outOfTime: () => (++calls > 3 ? QUOTE_UNVERIFIABLE_CAUSE.BUDGET_EXCEEDED : null),
    excerptChars: 30,
  })
  assert.ok(result.stopped !== null, "the scan reports that it stopped")
  assert.equal(result.stopped.reason, QUOTE_UNVERIFIABLE_CAUSE.BUDGET_EXCEEDED)
  assert.ok(result.quotes.length < blocks.length)
  assert.ok(result.quotes.every((q) => q.index < (result.stopped?.index ?? 0)), "nothing past the stop is returned")
  assert.equal(md.slice(result.stopped.index).startsWith("« passage numéro"), true, "it stops at a block boundary")
})
