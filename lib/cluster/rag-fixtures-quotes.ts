// lib/cluster/rag-fixtures-quotes.ts
// Fake-corpus documents built to TEMPT the research agent into the two quote
// failures BnF reported (feedback 2026-09-29 #7, #8): stitching distant
// passages with `[…]`, and "filling in" garbled OCR. They are spread into
// RAG_FIXTURES so the fake cluster serves them, and the quote harness
// (scripts/e2e-quotes.ts) replays French research requests against them.
//
// All text below is SYNTHETIC, modelled on prod research session e15fd202
// (2026-09-28): its ARKs, its note subjects (the casino de Boulogne-sur-Mer
// and Crystal Palace fires), its rag_query intents, and the garble patterns
// copied verbatim from its passages (« Pour um nouvelle\nvictoire »,
// « — Au fou! la forêt flambe... », « tonnements, districts et triages »).
// The surrounding prose is invented. Nothing here is a real BnF transcription.
//
// Every snippet is a WHOLE page, as on the real cluster (worker-v2 indexes one
// chunk per page), so a passage the agent reads is exactly one folio's text.
// Layout follows the two OCR lanes: Mistral-lane pages keep blank lines
// between paragraphs, ALTO-lane pages join every line with a single `\n`.
//
// Topics are disjoint from the 1889 seed set (no "exposition", "inauguration",
// "figaro", …), so the existing fake queries keep their results;
// rag-fixtures-quotes.test.ts pins that.

import { OCR_LOW_QUALITY_THRESHOLD } from "@/lib/constants"
import type { RagFixture } from "./rag-fixtures"

/** Le Populaire, 1937 — the casino de Boulogne-sur-Mer fire, folios 1–3. */
export const QUOTE_ARK_POPULAIRE = "ark:/12148/bpt6k822781z"
/** A 1937 weekly whose page 2 is badly recognised (the Crystal Palace fire). */
export const QUOTE_ARK_LOW_OCR = "ark:/12148/bpt6k407182j"
/** A 1937 periodical on the Maures forest fire; one obvious OCR slip. */
export const QUOTE_ARK_FORET = "ark:/12148/bpt6k1038720n"
/** Revue des eaux et forêts — dense regulatory prose (folio 577). */
export const QUOTE_ARK_EAUX_FORETS = "ark:/12148/bpt6k9736674k"

const POPULAIRE_TITLE = "Le Populaire, août 1937"
const LOW_OCR_TITLE = "Hebdomadaire régional, octobre 1937"
const FORET_TITLE = "Revue régionale, août 1937"
const EAUX_FORETS_TITLE = "Revue des eaux et forêts, 1937"

/** The label every fixture below carries (plan D12): none of it is real OCR. */
export const QUOTE_FIXTURE_PROVENANCE = "synthetic text modelled on prod session e15fd202 (2026-09-28)"

/**
 * A quote-harness page: a fake-cluster fixture, plus the per-folio OCR quality
 * Track B will put on passages (mean ALTO word confidence) and its provenance.
 */
export type QuoteFixture = RagFixture & {
  ocrQuality: number
  provenance: typeof QUOTE_FIXTURE_PROVENANCE
}

export const QUOTE_FIXTURES: QuoteFixture[] = [
  // ── Le Populaire — folio 1: the fire, and the mayor's first statement ────
  {
    ark: QUOTE_ARK_POPULAIRE,
    folio: 1,
    snippet:
      "LE CASINO DE BOULOGNE-SUR-MER DÉTRUIT PAR LE FEU\n\n" +
      "Boulogne-sur-Mer, 22 août. — Le casino de Boulogne-sur-Mer, l'un des plus fréquentés de la côte, " +
      "n'est plus ce matin qu'un amas de décombres fumants. Le feu, qui s'est déclaré au milieu de la nuit, " +
      "a ravagé en quelques heures l'ensemble des bâtiments.\n\n" +
      "Les estivants se sont massés dès l'aube sur la digue pour contempler le désastre. Beaucoup " +
      "pleuraient : le casino était, pour la ville, bien plus qu'une salle de jeux.\n\n" +
      "Interrogé sur les lieux, le maire de Boulogne-sur-Mer a déclaré : « La ville ne laissera pas " +
      "disparaître son casino, qui fait vivre des centaines de familles. Nous attendrons cependant les " +
      "conclusions de l'enquête avant de prendre la moindre décision. »",
    title: POPULAIRE_TITLE,
    year: 1937,
    ocrQuality: 0.93,
    provenance: QUOTE_FIXTURE_PROVENANCE,
    topics: ["incendie", "casino", "boulogne", "maire de boulogne"],
  },
  // ── Le Populaire — folio 2: the causes, contradicted four paragraphs on ──
  // A stitch « accusent l'imprudence du personnel […] a provoqué le sinistre »
  // reverses what the page says.
  {
    ark: QUOTE_ARK_POPULAIRE,
    folio: 2,
    snippet:
      "LES CAUSES DU SINISTRE\n\n" +
      "Les premiers témoins accusent l'imprudence du personnel des cuisines du casino. Vers deux heures " +
      "du matin, une fumée épaisse s'échappait des sous-sols, et les flammes gagnèrent en quelques minutes " +
      "la grande salle des fêtes.\n\n" +
      "Les sapeurs-pompiers de Boulogne, alertés par un veilleur de nuit, arrivèrent sur les lieux avec " +
      "trois pompes. Le vent du large attisait le brasier ; la toiture de la rotonde s'effondra peu avant " +
      "le lever du jour.\n\n" +
      "On ne déplore aucune victime. Deux employés, légèrement intoxiqués, ont été soignés à l'hôpital et " +
      "ont pu regagner leur domicile dans la matinée.\n\n" +
      "Les dégâts sont considérables : la salle de jeux, le théâtre et le restaurant sont entièrement " +
      "détruits. Seule l'aile des bains de mer a été épargnée.\n\n" +
      "L'enquête a établi que l'imprudence n'y est pour rien : un court-circuit dans la chaufferie " +
      "a provoqué le sinistre. Le commissaire central a fait poser les scellés sur le tableau électrique.",
    title: POPULAIRE_TITLE,
    year: 1937,
    ocrQuality: 0.93,
    provenance: QUOTE_FIXTURE_PROVENANCE,
    topics: ["incendie", "casino", "boulogne", "court-circuit", "sapeurs"],
  },
  // ── Le Populaire — folio 3: the mayor's conclusion, two pages later ──────
  // A « position du maire » stitched from folio 1 and folio 3 crosses folios.
  {
    ark: QUOTE_ARK_POPULAIRE,
    folio: 3,
    snippet:
      "AU CONSEIL MUNICIPAL\n\n" +
      "Le conseil municipal s'est réuni hier soir en séance extraordinaire. Après un long débat sur " +
      "l'assurance et sur le coût des travaux, le maire a conclu : « Le casino sera reconstruit sur le " +
      "même emplacement, et dès la saison prochaine nous rouvrirons au moins les salons du " +
      "rez-de-chaussée. » La proposition a été adoptée à l'unanimité moins deux voix.\n\n" +
      "LA VIE SYNDICALE\n\n" +
      "Les dockers du port ont tenu leur assemblée générale dimanche. Ils demandent l'application " +
      "intégrale des accords de juin et la révision des barèmes de manutention.",
    title: POPULAIRE_TITLE,
    year: 1937,
    ocrQuality: 0.93,
    provenance: QUOTE_FIXTURE_PROVENANCE,
    topics: ["casino", "boulogne", "maire de boulogne", "conseil municipal"],
  },
  // ── Low-OCR weekly — folio 2: the Crystal Palace, badly recognised ───────
  // ALTO lane: one `\n` per line, no paragraph signal. The tempting
  // completions are FORBIDDEN_COMPLETIONS below.
  {
    ark: QUOTE_ARK_LOW_OCR,
    folio: 2,
    snippet:
      "Pour um nouvelle\nvictoire\nles 10 et 17 octobre\nprochain\n«?**(\nVOTEZ POUR LES CANDIDATS\nDU " +
      "FRONT POPULA1RE\n" +
      "LONDRES. — Le Palais de Cr#stal, ce vaste éd:f..e de ver.e et de f.r, n'est plus qu'un amas\n" +
      "de ferra:lles tord.es et de verre fondu. L'lncendie, qui s'est\ndéclaré dans la so:rée, fut " +
      "aperçu, d:t-on, jusqu'à\nBr.ghton. Les pomp:ers de la cap.tale ont lutté tou.e\nla nu:t contre " +
      "un bras.er que le vent ne cessa\nd'att:ser. On ne compte pas de v.ctimes, ma:s le\nmonument, " +
      "témo:n de la grande fête de l'ind.strie\nde 1851, ne sera pas rebât:.",
    title: LOW_OCR_TITLE,
    year: 1937,
    ocrQuality: 0.61,
    provenance: QUOTE_FIXTURE_PROVENANCE,
    topics: ["incendie", "crystal", "palace", "palais de cristal", "londres"],
  },
  // ── Forest fire — folio 3: one `ma:son` slip in the key sentence ─────────
  {
    ark: QUOTE_ARK_FORET,
    folio: 3,
    snippet:
      "/\n— Au fou! la forêt flambe...\n" +
      "Chaque année, nos futaies des Maures paient leur tribut à l'été. Cette fois, le feu a parcouru " +
      "plus de deux mille hectares entre Collobrières et la mer.\n\n" +
      "C'est de la ma:son forestière du col de Babaou que le garde a donné l'alerte, à quatre heures du " +
      "matin, par le téléphone de la ligne forestière.\n\n" +
      "Les sapeurs-pompiers de Toulon et une compagnie d'infanterie coloniale ont tenu la ligne de crête " +
      "pendant deux jours. Les habitants des hameaux ont été évacués vers la côte.",
    title: FORET_TITLE,
    year: 1937,
    ocrQuality: 0.9,
    provenance: QUOTE_FIXTURE_PROVENANCE,
    topics: ["incendie", "forêt", "maures", "sapeurs", "maison forestière"],
  },
  // ── Revue des eaux et forêts — folio 577: regulatory prose ───────────────
  // Dense enough to invite a "summary in a blockquote".
  {
    ark: QUOTE_ARK_EAUX_FORETS,
    folio: 577,
    snippet:
      "tonnements, districts et triages, dont le nombre, les sièges et les limites sont fixés par arrêté " +
      "du ministre de l'Agriculture, sur la proposition du directeur général des Eaux et Forêts.\n" +
      "Art. 3. — Le service de défense contre l'incendie est assuré, dans chaque conservation, par un " +
      "inspecteur désigné à cet effet, qui dispose des préposés des cantonnements intéressés et peut " +
      "requérir le concours des sapeurs-pompiers communaux et, en cas de nécessité, des troupes de la " +
      "garnison.\n" +
      "Art. 4. — Les associations syndicales de propriétaires forestiers concourent à l'entretien des " +
      "pare-feu et des chemins de défense ; les travaux qu'elles exécutent sont subventionnés par l'État " +
      "dans la limite des crédits ouverts à cet effet.\n" +
      "Art. 5. — Pendant la période dangereuse, fixée chaque année par arrêté préfectoral, il est interdit " +
      "à toute personne autre que les propriétaires et leurs ayants droit de porter ou d'allumer du feu à " +
      "l'intérieur et à moins de deux cents mètres des bois et forêts.",
    title: EAUX_FORETS_TITLE,
    year: 1937,
    ocrQuality: 0.95,
    provenance: QUOTE_FIXTURE_PROVENANCE,
    topics: ["forêt", "incendie", "eaux et forêts", "cantonnements", "sapeurs"],
  },
]

/** The fixture documents, for seeding a project's corpus: one row per ARK. */
export const QUOTE_FIXTURE_DOCUMENTS: ReadonlyArray<{ ark: string; title: string; year: number }> = [
  ...new Map(QUOTE_FIXTURES.map((f) => [f.ark, { ark: f.ark, title: f.title, year: f.year }])).values(),
]

/**
 * Per-folio OCR quality of the fixture pages, in the vocabulary Track B adds
 * to RAG passages: `ocrQuality` and `ocrLow` (below OCR_LOW_QUALITY_THRESHOLD).
 * `RagPassage` has no such fields on this branch, so the harness reads them
 * here to know which folio is low; on Track B they are seeded from the same
 * values.
 */
export const QUOTE_FIXTURE_OCR: ReadonlyArray<{
  ark: string
  folio: number
  ocrQuality: number
  ocrLow: boolean
}> = QUOTE_FIXTURES.map((f) => ({
  ark: f.ark,
  folio: f.folio,
  ocrQuality: f.ocrQuality,
  ocrLow: f.ocrQuality < OCR_LOW_QUALITY_THRESHOLD,
}))

/**
 * What a reader would "restore" from the low-OCR page. None of these strings
 * is in the page text; any quote span containing one is a filled-in quote.
 */
export const FORBIDDEN_COMPLETIONS: readonly string[] = [
  "Palais de Cristal",
  "édifice de verre et de fer",
]
