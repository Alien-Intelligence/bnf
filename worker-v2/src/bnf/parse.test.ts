/**
 * Unit tests for the PURE BnF parsers (src/bnf/parse.ts). No network, no env —
 * every case feeds an inline XML/JSON fixture and asserts the deterministic
 * transform. The network methods on LiveBnfClient are deliberately NOT tested
 * here (they'd need a live broker); these parsers are the only logic that can
 * be verified in isolation, and they carry the load-bearing extraction rules
 * (charset-correct OCR text, fr-preferred labels, the "mode texte" / "vues"
 * heuristics).
 */
import { test } from "node:test";
import assert from "node:assert/strict";

import { PermanentBnfError, TransientBnfError } from "./errors.js";
import {
  arkToSlug,
  descriptionsHaveModeTexte,
  ensureCanonicalArk,
  extractPageCountFromFormat,
  iiifV3Label,
  isCatalogueNotice,
  oaiParser,
  altoFolioFromParse,
  ocrRateValue,
  parseAlto,
  parseOcrRate,
  parseV3Manifest,
  pickDcType,
} from "./parse.js";

// ---------------------------------------------------------------------------
// parseAlto — text extraction + per-folio word-confidence statistics (D1)
// ---------------------------------------------------------------------------

/** An ALTO folio in the real BnF shape: HPOS/VPOS/WIDTH/HEIGHT attributes on
 *  every String, WC written as "1" or "0.34" (parseAttributeValue is off, so
 *  the parser hands them to us as strings). */
const ALTO_WITH_WC = `<?xml version="1.0" encoding="UTF-8"?>
  <alto xmlns="http://www.loc.gov/standards/alto/ns-v3#">
    <Layout>
      <Page ID="PAG_1" PHYSICAL_IMG_NR="1" QUALITY="OK" ACCURACY="99.50">
        <PrintSpace>
          <TextBlock ID="TB_1">
            <TextLine ID="TL_1">
              <String ID="S_1" HPOS="10" VPOS="20" WIDTH="100" HEIGHT="30" WC="1" CONTENT="L'Auto"/>
              <String ID="S_2" HPOS="120" VPOS="20" WIDTH="80" HEIGHT="30" WC="0.34" CONTENT="vélo"/>
            </TextLine>
            <TextLine ID="TL_2">
              <String ID="S_3" HPOS="10" VPOS="60" WIDTH="90" HEIGHT="30" WC="0.84" CONTENT="2"/>
              <String ID="S_4" HPOS="110" VPOS="60" WIDTH="90" HEIGHT="30" WC="0.5" CONTENT="juillet"/>
            </TextLine>
          </TextBlock>
        </PrintSpace>
      </Page>
    </Layout>
  </alto>`;

test("parseAlto: mean WC over scored words, text identical to the plain extraction", () => {
  const r = parseAlto(ALTO_WITH_WC);
  assert.equal(r.text, "L'Auto vélo\n2 juillet");
  assert.equal(r.wordCount, 4);
  assert.equal(r.scoredWordCount, 4);
  // (1 + 0.34 + 0.84 + 0.5) / 4 = 0.67
  assert.equal(r.meanWordConfidence, 0.67);
  assert.equal(r.invalidWcCount, 0);
});

test("parseAlto: ALTO without WC → meanWordConfidence null (never 0), words still counted", () => {
  const xml = `<?xml version="1.0" encoding="UTF-8"?>
    <alto>
      <Layout>
        <Page>
          <PrintSpace>
            <TextBlock>
              <TextLine>
                <String CONTENT="Bonjour"/>
                <String CONTENT="le"/>
                <String CONTENT="monde"/>
              </TextLine>
              <TextLine>
                <String CONTENT="deuxième"/>
                <String CONTENT="ligne"/>
              </TextLine>
            </TextBlock>
          </PrintSpace>
        </Page>
      </Layout>
    </alto>`;
  const r = parseAlto(xml);
  assert.equal(r.text, "Bonjour le monde\ndeuxième ligne");
  assert.equal(r.wordCount, 5);
  assert.equal(r.scoredWordCount, 0);
  assert.equal(r.meanWordConfidence, null, "no scored word → null, not a default 0");
  assert.equal(r.invalidWcCount, 0);
});

test("parseAlto: invalid WC values (non-numeric, > 1, < 0) are excluded and counted, never coerced", () => {
  const xml = `<alto><Layout><Page><PrintSpace><TextBlock><TextLine>
      <String WC="abc" CONTENT="a"/>
      <String WC="1.5" CONTENT="b"/>
      <String WC="-0.1" CONTENT="c"/>
      <String WC="0.8" CONTENT="d"/>
      <String WC="0.6" CONTENT="e"/>
    </TextLine></TextBlock></PrintSpace></Page></Layout></alto>`;
  const r = parseAlto(xml);
  assert.equal(r.text, "a b c d e", "invalid WC never drops the word from the text");
  assert.equal(r.wordCount, 5);
  assert.equal(r.scoredWordCount, 2);
  assert.equal(r.meanWordConfidence, 0.7);
  assert.equal(r.invalidWcCount, 3);
});

test("parseAlto: a String with empty CONTENT is neither a word nor scored", () => {
  const xml = `<alto><Layout><Page><PrintSpace><TextBlock><TextLine>
      <String WC="0.2" CONTENT=""/>
      <String WC="1" CONTENT="seul"/>
    </TextLine></TextBlock></PrintSpace></Page></Layout></alto>`;
  const r = parseAlto(xml);
  assert.equal(r.text, "seul");
  assert.equal(r.wordCount, 1);
  assert.equal(r.scoredWordCount, 1);
  assert.equal(r.meanWordConfidence, 1);
});

test("parseAlto: mean is rounded to 4 decimals", () => {
  const xml = `<alto><Layout><Page><PrintSpace><TextBlock><TextLine>
      <String WC="1" CONTENT="a"/>
      <String WC="1" CONTENT="b"/>
      <String WC="0" CONTENT="c"/>
    </TextLine></TextBlock></PrintSpace></Page></Layout></alto>`;
  assert.equal(parseAlto(xml).meanWordConfidence, 0.6667);
});

test("parseAlto: structurally empty ALTO (no Layout / no words) → empty text, wordCount 0, null mean", () => {
  const noLayout = `<?xml version="1.0"?><alto><Description/></alto>`;
  assert.deepEqual(parseAlto(noLayout), {
    text: "",
    wordCount: 0,
    scoredWordCount: 0,
    meanWordConfidence: null,
    invalidWcCount: 0,
  });
  const emptyPrintSpace = `<?xml version="1.0"?><alto><Layout><Page><PrintSpace></PrintSpace></Page></Layout></alto>`;
  assert.deepEqual(parseAlto(emptyPrintSpace), {
    text: "",
    wordCount: 0,
    scoredWordCount: 0,
    meanWordConfidence: null,
    invalidWcCount: 0,
  });
});

const isAltoParseFailure = (err: unknown): boolean =>
  err instanceof TransientBnfError && err.cause === "alto_parse_failed";

test("parseAlto: XML truncated inside a tag throws TransientBnfError alto_parse_failed (B9)", () => {
  // Pre-fix this was swallowed into "" and the folio counted as legitimately empty.
  const truncated = `<alto><Layout><Page><PrintSpace><TextBlock><TextLine><String CONTENT="a" WC="1"/><String CONTENT="b" WC="0.3`;
  assert.throws(() => parseAlto(truncated), isAltoParseFailure);
});

test("parseAlto: XML truncated BETWEEN elements (no closing tags) is rejected too, not read as a shorter page", () => {
  // A chunked response closed after a complete element: fast-xml-parser alone
  // accepts it and returns the words seen so far, so the page silently loses
  // its tail. The document must be well-formed (XMLValidator) to be read.
  const truncated = `<alto><Layout><Page><PrintSpace><TextBlock><TextLine><String CONTENT="a" WC="1"/>`;
  assert.throws(() => parseAlto(truncated), isAltoParseFailure);
});

test("parseAlto: an <alto> root or Layout that is not an element structure is a parse failure", () => {
  assert.throws(() => parseAlto("<alto>hello</alto>"), isAltoParseFailure);
  assert.throws(() => parseAlto("<alto><Layout>hello</Layout></alto>"), isAltoParseFailure);
});

test("parseAlto: a body with no <alto> root (e.g. an HTML error page served as 200) is a parse failure, not an empty folio", () => {
  const html = `<html><body>Service Unavailable</body></html>`;
  assert.throws(
    () => parseAlto(html),
    (err: unknown) => err instanceof TransientBnfError && err.cause === "alto_parse_failed",
  );
  assert.throws(
    () => parseAlto("<not-alto>"),
    (err: unknown) => err instanceof TransientBnfError && err.cause === "alto_parse_failed",
  );
});

test("parseAlto: a lone ComposedBlock's words are read and scored (not dropped as an empty page)", () => {
  // fast-xml-parser turns a SINGLE child element into an object, not an array;
  // ComposedBlock was missing from the parser's isArray list, so a TextBlock
  // or PrintSpace holding exactly one ComposedBlock lost every word in it and
  // the folio read as confidently empty.
  const xml = `<alto><Layout><Page><PrintSpace>
    <ComposedBlock><TextBlock><TextLine>
      <String CONTENT="Paris" WC="0.5"/><String CONTENT="1889" WC="1"/>
    </TextLine></TextBlock></ComposedBlock>
  </PrintSpace></Page></Layout></alto>`;
  const r = parseAlto(xml);
  assert.equal(r.text, "Paris 1889");
  assert.equal(r.wordCount, 2);
  assert.equal(r.meanWordConfidence, 0.75);
});

// ---------------------------------------------------------------------------
// parseOcrRate — the manifest "Taux OCR" row as a [0,1] score
// ---------------------------------------------------------------------------

test("parseOcrRate: percentage strings (dot or comma decimal) → fraction, 4 decimals", () => {
  assert.deepEqual(parseOcrRate("78.21 %"), { kind: "ok", rate: 0.7821 });
  assert.deepEqual(parseOcrRate("89,59 %"), { kind: "ok", rate: 0.8959 });
  assert.deepEqual(parseOcrRate("100 %"), { kind: "ok", rate: 1 });
  assert.deepEqual(parseOcrRate("0 %"), { kind: "ok", rate: 0 });
  assert.deepEqual(parseOcrRate("78.21%"), { kind: "ok", rate: 0.7821 }, "no space before the sign");
  assert.deepEqual(parseOcrRate("78.21"), { kind: "ok", rate: 0.7821 }, "no sign at all");
});

test("parseOcrRate: missing, unparseable and out-of-range are told apart (never coerced)", () => {
  assert.deepEqual(parseOcrRate(null), { kind: "missing" });
  assert.deepEqual(parseOcrRate("150 %"), { kind: "out_of_range", raw: "150 %" }, "the mcp-bnf port lacks this check");
  assert.deepEqual(parseOcrRate("n/a"), { kind: "unparseable", raw: "n/a" });
  assert.deepEqual(parseOcrRate("-5 %"), { kind: "unparseable", raw: "-5 %" });
  assert.deepEqual(parseOcrRate(""), { kind: "unparseable", raw: "" });
  assert.deepEqual(parseOcrRate("   "), { kind: "unparseable", raw: "   " });
});

test("parseOcrRate: a multi-valued metadata row takes the first value", () => {
  // parseV3ManifestMetadata joins multi-valued fields with " | ".
  assert.deepEqual(parseOcrRate("78.21 % | x"), { kind: "ok", rate: 0.7821 });
});

test("ocrRateValue: only an ok parse yields a number", () => {
  assert.equal(ocrRateValue({ kind: "ok", rate: 0.5 }), 0.5);
  assert.equal(ocrRateValue({ kind: "missing" }), null);
  assert.equal(ocrRateValue({ kind: "unparseable", raw: "x" }), null);
  assert.equal(ocrRateValue({ kind: "out_of_range", raw: "150" }), null);
});

// ---------------------------------------------------------------------------
// altoFolioFromParse — the ONE AltoParse → AltoFolio mapping (client + fake)
// ---------------------------------------------------------------------------

test("altoFolioFromParse: maps the statistics into the sidecar shape", () => {
  assert.deepEqual(
    altoFolioFromParse({
      text: "a b",
      wordCount: 2,
      scoredWordCount: 1,
      meanWordConfidence: 0.5,
      invalidWcCount: 1,
    }),
    {
      text: "a b",
      empty: false,
      quality: { v: 1, wordCount: 2, scoredWordCount: 1, meanWc: 0.5 },
      invalidWcCount: 1,
    },
  );
  assert.equal(
    altoFolioFromParse({ text: "  ", wordCount: 0, scoredWordCount: 0, meanWordConfidence: null, invalidWcCount: 0 }).empty,
    true,
  );
});

// ---------------------------------------------------------------------------
// v3 manifest parsing + iiifV3Label
// ---------------------------------------------------------------------------

test("parseV3Manifest derives canvases, ordre, totalPages and the fr title", () => {
  const json = {
    label: { fr: ["Plan de Paris"], en: ["Map of Paris"] },
    items: [
      {
        id: "https://example/ark:/12148/btv1bX/f1/canvas",
        label: { none: ["f. 1"] },
        width: 2000,
        height: 3000,
      },
      {
        id: "https://example/ark:/12148/btv1bX/f2/canvas",
        label: { fr: ["f. 2"] },
        width: 2010,
        height: 3010,
      },
    ],
  };
  const m = parseV3Manifest(json, 200);
  assert.equal(m.title, "Plan de Paris");
  assert.equal(m.totalPages, 2);
  assert.equal(m.canvases.length, 2);
  assert.deepEqual(m.canvases[0], {
    ordre: 1,
    label: "f. 1",
    width: 2000,
    height: 3000,
  });
  assert.equal(m.canvases[1]!.ordre, 2);
});

test("parseV3Manifest drops folio-less media canvases that would collide on ordre", () => {
  // A "document sonore": two audio playback canvases (no /f<N>/ in the id) followed
  // by four real image folios. The old position-fallback gave the audio canvases
  // ordres 1,2 — colliding with f1,f2 — so pagesExpected (6) outran the distinct
  // folios reachable (4) and the fan-in hung forever. ark:/12148/bpt6k88175778.
  const json = {
    label: { none: ["L'ODYSSEE / Homère"] },
    items: [
      { id: "https://openapi.bnf.fr/iiif/.../bpt6k88175778/canvas/4-4-6-2-4", label: { none: ["Face A"] } },
      { id: "https://openapi.bnf.fr/iiif/.../bpt6k88175778/canvas/4-6-6-2-4", label: { none: ["Face B"] } },
      { id: "https://openapi.bnf.fr/iiif/.../bpt6k88175778/f1/canvas", label: { fr: ["3"] } },
      { id: "https://openapi.bnf.fr/iiif/.../bpt6k88175778/f2/canvas", label: { fr: ["4"] } },
      { id: "https://openapi.bnf.fr/iiif/.../bpt6k88175778/f3/canvas", label: { fr: ["recto"] } },
      { id: "https://openapi.bnf.fr/iiif/.../bpt6k88175778/f4/canvas", label: { fr: ["verso"] } },
    ],
  };
  const m = parseV3Manifest(json, 200);
  assert.equal(m.totalPages, 4, "only the four real image folios remain");
  assert.deepEqual(
    m.canvases.map((c) => c.ordre),
    [1, 2, 3, 4],
    "ordres are unique so the fan-in can complete",
  );
});

test("parseV3Manifest falls back to 1-based position only when no canvas has a folio id", () => {
  const json = {
    label: "Recueil sans folios",
    items: [{ id: "a/canvas/x" }, { id: "a/canvas/y" }, { label: { fr: ["sans id"] } }],
  };
  const m = parseV3Manifest(json, 200);
  assert.deepEqual(
    m.canvases.map((c) => c.ordre),
    [1, 2, 3],
  );
});

test("parseV3Manifest honours maxCanvases (totalPages stays full count)", () => {
  const json = {
    label: "Recueil",
    items: [
      { id: "a/f1/canvas" },
      { id: "a/f2/canvas" },
      { id: "a/f3/canvas" },
    ],
  };
  const m = parseV3Manifest(json, 2);
  assert.equal(m.totalPages, 3);
  assert.equal(m.canvases.length, 2);
});

test("iiifV3Label prefers fr, then none, then first key; coerces strings", () => {
  assert.equal(iiifV3Label({ fr: ["Titre"], en: ["Title"] }), "Titre");
  assert.equal(iiifV3Label({ none: ["Sans langue"], de: ["Titel"] }), "Sans langue");
  assert.equal(iiifV3Label({ de: ["Titel"] }), "Titel");
  assert.equal(iiifV3Label("bare string"), "bare string");
  assert.equal(iiifV3Label(null), null);
});

// ---------------------------------------------------------------------------
// OAI Dublin Core helpers
// ---------------------------------------------------------------------------

test("extractPageCountFromFormat reads 'Nombre total de vues : N'", () => {
  assert.equal(extractPageCountFromFormat(["Nombre total de vues : 12"]), 12);
  // Extra spacing + scanning multiple formats.
  assert.equal(
    extractPageCountFromFormat(["application/pdf", "Nombre total de vues :  340"]),
    340,
  );
  assert.equal(extractPageCountFromFormat(["no count here"]), null);
});

test("descriptionsHaveModeTexte scans all descriptions for 'mode texte'", () => {
  assert.equal(
    descriptionsHaveModeTexte([
      "Contient une table des matières",
      "Avec mode texte",
    ]),
    true,
  );
  assert.equal(descriptionsHaveModeTexte(["Sans texte"]), false);
  assert.equal(descriptionsHaveModeTexte("Avec mode texte"), true);
});

test("pickDcType prefers the fre-tagged dc:type over the first entry", () => {
  // Shape as fast-xml-parser yields it via oaiParser: array of attr-decorated nodes.
  const types = [
    { "#text": "text", "@_xml:lang": "eng" },
    { "#text": "monographie", "@_xml:lang": "fre" },
  ];
  assert.equal(pickDcType(types), "monographie");
  // No fre tag → first entry.
  assert.equal(pickDcType([{ "#text": "image" }]), "image");
  // Bare scalar.
  assert.equal(pickDcType("texte"), "texte");
});

test("pickDcType works against real oaiParser output (fre type wins)", () => {
  // End-to-end through the configured parser so the attribute-prefix + isArray
  // config is exercised exactly as in production.
  const xml = `<dc xmlns:dc="x">
    <dc:type xml:lang="eng">text</dc:type>
    <dc:type xml:lang="fre">monographie imprimée</dc:type>
  </dc>`;
  const parsed = oaiParser.parse(xml) as Record<string, Record<string, unknown>>;
  assert.equal(pickDcType(parsed.dc!["dc:type"]), "monographie imprimée");
});

// ---------------------------------------------------------------------------
// ARK helpers
// ---------------------------------------------------------------------------

test("arkToSlug extracts the opaque identifier", () => {
  assert.equal(arkToSlug("ark:/12148/btv1b9015469h"), "btv1b9015469h");
  assert.equal(arkToSlug("  ark:/12148/bpt6k123456  "), "bpt6k123456");
  // Non-matching input falls back to slash-replacement (never invents content).
  assert.equal(arkToSlug("weird/value"), "weird-value");
});

test("ensureCanonicalArk trims valid ARKs and throws Permanent on junk", () => {
  assert.equal(ensureCanonicalArk("  ark:/12148/btv1bX  "), "ark:/12148/btv1bX");
  assert.throws(() => ensureCanonicalArk("12148/btv1bX"), PermanentBnfError);
  assert.throws(() => ensureCanonicalArk("https://gallica.bnf.fr/x"), PermanentBnfError);
});

test("isCatalogueNotice flags cb* ARKs as notices", () => {
  assert.equal(isCatalogueNotice("ark:/12148/cb32798326r"), true);
  assert.equal(isCatalogueNotice("ark:/12148/btv1b9015469h"), false);
  assert.equal(isCatalogueNotice("ark:/12148/bpt6k123456"), false);
});
