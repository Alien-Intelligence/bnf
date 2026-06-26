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

import { PermanentBnfError } from "./errors.js";
import {
  arkToSlug,
  descriptionsHaveModeTexte,
  ensureCanonicalArk,
  extractPageCountFromFormat,
  iiifV3Label,
  isCatalogueNotice,
  oaiParser,
  parseAltoText,
  parseV3Manifest,
  pickDcType,
} from "./parse.js";

// ---------------------------------------------------------------------------
// parseAltoText
// ---------------------------------------------------------------------------

test("parseAltoText joins Strings into words and TextLines into lines", () => {
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
  assert.equal(parseAltoText(xml), "Bonjour le monde\ndeuxième ligne");
});

test("parseAltoText returns '' for structurally-empty / whitespace ALTO", () => {
  const empty = `<?xml version="1.0"?><alto><Layout><Page><PrintSpace></PrintSpace></Page></Layout></alto>`;
  assert.equal(parseAltoText(empty), "");
  // Malformed XML must not throw — a text-less folio is legitimate.
  assert.equal(parseAltoText("<not-alto>"), "");
  assert.equal(parseAltoText("   "), "");
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
