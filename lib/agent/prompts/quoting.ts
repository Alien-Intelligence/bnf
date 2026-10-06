// lib/agent/prompts/quoting.ts
// The quoting rules (feedback-2026-09-29 #7 / #8, Track C Phase 4): how the
// agent quotes the text of a document, cuts a passage, corrects OCR and reacts
// to the quote check. One source for the research prompt section, the corpus
// STYLE bullet, the research sub-agent's deposit and the note tools' hint, so
// the four never drift. The reasons the hint and the section name are the ones
// the guard returns (lib/citations/quote-check.ts) and the guidance it attaches
// (lib/agent/prompts/quote-warnings.ts).
import "server-only"

import { AGENT_TOOLS } from "@/lib/agent/tools/constants"
import { QUOTE_MAX_ELISIONS } from "@/lib/constants"
import { BNF_MCP_TOOL, bnfPrefixedToolName } from "@/lib/mcp/tools"
import { OCR_CORRECTION_MARKING_MODE, type OcrCorrectionMarking } from "@/models/notes/schema"

/** How a corrected OCR word is marked, as the research section states it. */
const MARKING_RULE: Record<OcrCorrectionMarking, string> = {
  [OCR_CORRECTION_MARKING_MODE.BRACKETED_WORD]:
    `Signale chaque mot corrigé en l'écrivant **entre crochets** : \`[maison]\` pour un OCR \`ma:son\`. Le lecteur voit ainsi ce que tu as touché. Un mot recollé en fin de ligne ou un retour à la ligne supprimé ne se signale pas : ce n'est pas une correction de lettre. Les crochets ne servent qu'à cela, à \`[…]\` et à \`[illisible]\` — jamais à insérer un mot de ton cru.`,
  [OCR_CORRECTION_MARKING_MODE.SILENT]:
    `Écris le mot corrigé directement, sans le signaler : la référence \`[[ark|label|folio]]\` permet au lecteur de vérifier sur l'original. N'ajoute jamais de crochets autour d'un mot : les crochets ne servent qu'à \`[…]\` et à \`[illisible]\`.`,
}

/** The same convention, in the English of the tool descriptions. */
const MARKING_HINT: Record<OcrCorrectionMarking, string> = {
  [OCR_CORRECTION_MARKING_MODE.BRACKETED_WORD]: "Mark an OCR word you corrected in brackets: [maison].",
  [OCR_CORRECTION_MARKING_MODE.SILENT]: "Do not bracket corrected words.",
}

/** « Deux coupures au plus » — the number QUOTE_MAX_ELISIONS holds, in words. */
const ELISION_CAP_WORDS: Record<number, string> = { 1: "Une coupure", 2: "Deux coupures", 3: "Trois coupures" }

function elisionCap(): string {
  const words = ELISION_CAP_WORDS[QUOTE_MAX_ELISIONS]
  if (words === undefined) {
    throw new Error(`QUOTE_MAX_ELISIONS=${QUOTE_MAX_ELISIONS} has no wording in lib/agent/prompts/quoting.ts`)
  }
  return words
}

/** The research prompt's section « CITER LE TEXTE D'UN DOCUMENT — À LA LETTRE ». */
export function renderQuotingRules(marking: OcrCorrectionMarking): string {
  return `## CITER LE TEXTE D'UN DOCUMENT — À LA LETTRE

Une citation est une **promesse faite au lecteur** : ce qui est entre guillemets est ce que dit le document, mot pour mot, à l'endroit cité. Le bibliothécaire ne peut pas distinguer une citation que tu aurais reconstruite d'une citation réelle — c'est pourquoi la moindre reconstruction est une faute grave.

**Citation ou paraphrase — choisis, ne mélange jamais.**
- Tout texte placé entre « » (ou “ ” dans une session en anglais) ou dans un bloc de citation (\`>\`) est une **citation** : il est recopié **à l'identique** d'un passage que tes outils t'ont renvoyé, sur le folio que tu cites juste après.
- Tout le reste est **paraphrase** : tes propres mots, sans guillemets, toujours suivis de la référence \`[[ark|label|folio]]\`. Une paraphrase n'est jamais présentée comme une citation — pas de guillemets « pour faire vrai », pas de bloc de citation pour un résumé.
- Une **traduction** n'est jamais une citation : cite l'original entre guillemets, et donne ta traduction hors guillemets, comme ta propre glose.
- Chaque citation est suivie de **sa propre** référence \`[[ark|label|folio]]\`, avec le folio exact du passage d'où elle vient. Sans folio sûr, pas de guillemets : paraphrase.
- Ne cite qu'un texte que tu as **lu dans un résultat d'outil**. Une citation rapportée par un sous-agent n'est utilisable que si sa synthèse la donne entre guillemets avec son ARK et son folio ; sinon relis le passage (\`${AGENT_TOOLS.ragGetText}\`) avant de la citer.

**Couper un passage : \`[…]\`, à l'intérieur d'un même passage seulement.**
- \`[…]\` signale que tu as retiré des mots **à l'intérieur d'une même phrase, ou entre deux phrases qui se suivent**, dans le même paragraphe du même folio — quelques mots, une fin de phrase, jamais davantage. Le texte OCR ne marque pas toujours les paragraphes : dans le doute, considère que deux phrases éloignées de plus de quelques lignes ne se suivent pas.
- Ne relie **jamais** par \`[…]\` deux paragraphes, deux folios, deux articles ou deux sections. Des extraits éloignés deviennent des **citations distinctes**, chacune avec sa propre référence \`[[ark|label|folio]]\`, reliées par **tes propres mots** (« Plus loin, l'auteur précise : … »).
- La coupure ne doit **rien changer au sens** : elle ne renverse pas une affirmation, ne la renforce pas, ne fait pas disparaître une négation, une réserve ou une condition (« ne… pas », « sauf », « peut-être », « si »), et n'accroche jamais le sujet d'une phrase au verbe ou au complément d'une autre.
- **${elisionCap()} au plus** par citation. Au-delà, scinde en plusieurs citations ou paraphrase.
- Écris la coupure \`[…]\` — points de suspension entre crochets. Jamais \`(…)\`, ni \`…\` ou \`...\` seuls, qui se confondent avec la ponctuation du document.

**Erreurs d'OCR : corriger un caractère, jamais interpréter.**
Le texte des documents vient de la reconnaissance optique des caractères (OCR) et contient des erreurs. Tu peux corriger **uniquement** une erreur évidente de caractère, dans **un seul mot**, quand la bonne lecture ne fait **aucun doute** d'après le contexte :
- une lettre mal lue (\`:\` pour \`i\`, \`rn\` pour \`m\`, \`0\` pour \`o\`, \`ii\` pour \`u\`…) ;
- un mot coupé en fin de ligne (\`répu-\` / \`blique\` → \`république\`) ;
- un retour à la ligne parasite au milieu d'une phrase.
${MARKING_RULE[marking]}
Tout le reste est **interdit** dans une citation : reformuler, moderniser l'orthographe ou la syntaxe (« estoit », « sçavoir » restent tels quels), compléter un mot tronqué, combler une lacune, deviner un mot illisible, « améliorer » le sens. Quand un mot ou un groupe de mots est illisible ou ambigu, **recopie-le tel quel** ou remplace-le par \`[illisible]\` — ne le devine jamais.

**Folios mal reconnus (\`ocrLow: true\`).** Chaque passage indique \`ocrQuality\` (qualité moyenne de reconnaissance du folio, entre 0 et 1, ou \`null\` si elle est inconnue) et \`ocrLow\` (vrai quand ce folio est mal reconnu). Sur un folio \`ocrLow: true\` :
- ne corrige **rien**, pas même un caractère : cite à la lettre, même brouillé, ou écris \`[illisible]\` ;
- ne « répare » jamais le sens d'un passage brouillé, et n'en tire pas une phrase lisible qui ne figure pas dans le texte ;
- préfère des citations **courtes**, et appuie ton propos sur une paraphrase prudente de ce qui est lisible ;
- dis-le au chercheur dans la conversation : à cet endroit, le document est mal reconnu, et la référence \`[[ark|label|folio]]\` ouvre la page originale pour vérifier.
Quand un texte n'a pas d'indicateur (lecture par \`${AGENT_TOOLS.ragGetText}\`), applique les mêmes règles dès que le passage est visiblement brouillé.
N'écris pas toi-même d'avertissement général sur la qualité de l'OCR dans une note : l'outil l'ajoute automatiquement à côté des citations concernées.

**Contrôle automatique des citations.** À chaque écriture de note, l'outil compare tes citations au texte du folio cité et peut renvoyer \`quote_warnings\`. Chaque avertissement désigne une citation infidèle (absente du folio, trouvée sur un autre folio, coupure trop large ou dans le désordre, correction non signalée…) et dit quoi faire. Corrige aussitôt avec \`${AGENT_TOOLS.noteUpdate}\` : recopie le texte exact, corrige le folio, scinde la citation, ou transforme-la en paraphrase sans guillemets. **Une seule tentative par citation** : si l'avertissement revient, paraphrase. \`unverifiable\` signifie seulement que le contrôle n'a pas pu se faire : relis alors le passage avant de conserver la citation.`
}

/** The corpus prompt's STYLE bullet: the corpus agent quotes page text when it justifies an addition. */
export const CORPUS_QUOTING_RULE = `- **Cite à la lettre, ou paraphrase.** Quand tu rapportes le texte d'une page (lu avec \`${bnfPrefixedToolName(BNF_MCP_TOOL.GET_PAGE_TEXT)}\`) pour justifier un ajout, recopie-le mot pour mot entre « », avec le titre et la page ; sinon, résume-le avec tes mots, sans guillemets. Ne relie jamais par \`[…]\` deux extraits éloignés, ne complète jamais un mot illisible et ne « répare » pas un OCR brouillé : recopie-le tel quel ou écris \`[illisible]\`.`

/** Appended to the research sub-agent's deposit: its synthesis quotes like a note. */
export const SUBAGENT_QUOTING_RULE = `Si ta synthèse rapporte une citation, recopie-la **à la lettre** entre « », suivie de l'ARK et du folio exacts du passage, et signale si ce folio est mal reconnu (\`ocrLow: true\`). Ne reconstitue jamais une citation de mémoire : en cas de doute, rapporte l'idée en paraphrase avec son ARK et son folio. Les règles « CITER LE TEXTE D'UN DOCUMENT — À LA LETTRE » valent pour ta synthèse comme pour une note.`

/** The quoting hint every note write tool's description ends with (English, like the descriptions). */
export function renderNoteQuoteHint(marking: OcrCorrectionMarking): string {
  return (
    "QUOTES: anything inside « » (or “ ”) or a > blockquote must be copied verbatim from a passage a tool " +
    "returned, immediately followed by its own [[ark|label|folio]] for the folio it comes from; otherwise write " +
    "paraphrase without quote marks. `[…]` may only drop words inside one sentence or between two consecutive " +
    `sentences of the same folio, at most ${QUOTE_MAX_ELISIONS} per quote — distant passages become separate quotes. ` +
    `Never complete illegible OCR: copy it as is or write [illisible]. ${MARKING_HINT[marking]} ` +
    `The result may contain quote_warnings: fix each one with ${AGENT_TOOLS.noteUpdate}, or turn that quote into paraphrase.`
  )
}
