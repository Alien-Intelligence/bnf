// lib/agent/prompts/quote-warnings.ts
// Agent-facing French guidance for each quote-check warning: the `detail` the
// note tools return with every `quote_warnings` entry. It is prompt prose, so
// it lives with the prompts (server-only), not in the client-shared
// models/notes/schema.ts that defines the reasons themselves. Phase 4's
// quoting rules (lib/agent/prompts/quoting.ts) describe the same reasons and
// must stay consistent with these sentences.
import "server-only"

import { AGENT_TOOLS } from "@/lib/agent/tools/constants"
import { QUOTE_WARNING_REASON, type QuoteWarningReason } from "@/models/notes/schema"

/** What the agent should do about each reason (rendered into `detail`). */
export const QUOTE_WARNING_DETAIL: Record<QuoteWarningReason, string> = {
  [QUOTE_WARNING_REASON.UNCITED]:
    "Citation sans référence : ajoute juste après le `[[ark|label|folio]]` du passage " +
    "d'où elle vient, ou retire les guillemets et paraphrase.",
  [QUOTE_WARNING_REASON.NOT_IN_CITED_FOLIO]:
    "Ce texte ne figure pas sur le folio cité. Recopie le texte exact du passage, ou " +
    "paraphrase sans guillemets.",
  [QUOTE_WARNING_REASON.FOUND_ON_OTHER_FOLIO]:
    "Ce texte figure sur un autre folio que celui cité : corrige le folio de la référence.",
  [QUOTE_WARNING_REASON.ELISION_ACROSS_FOLIOS]:
    "Le `[…]` relie des extraits de folios différents : fais-en des citations distinctes, " +
    "chacune avec sa référence.",
  [QUOTE_WARNING_REASON.ELISION_TOO_FAR]:
    "Le `[…]` saute plus que quelques mots d'une même phrase ou de deux phrases voisines : " +
    "scinde en citations distinctes reliées par tes propres mots.",
  [QUOTE_WARNING_REASON.ELISION_OUT_OF_ORDER]:
    "Les extraits reliés par `[…]` ne sont pas dans l'ordre du document : scinde la citation.",
  [QUOTE_WARNING_REASON.TOO_MANY_ELISIONS]:
    "Plus de deux `[…]` dans une même citation : scinde-la ou paraphrase.",
  [QUOTE_WARNING_REASON.NONSTANDARD_ELISION_MARKER]:
    "Signale une coupure par `[…]`, jamais par `(…)`.",
  [QUOTE_WARNING_REASON.UNMARKED_CORRECTION]:
    "Un mot diffère de l'OCR sans être signalé : mets le mot corrigé entre crochets, ou " +
    "recopie l'OCR tel quel.",
  [QUOTE_WARNING_REASON.CORRECTION_ON_LOW_OCR]:
    "Ce folio est mal reconnu : ne corrige rien, recopie l'OCR tel quel ou écris `[illisible]`.",
  [QUOTE_WARNING_REASON.UNBALANCED_QUOTE_MARK]:
    "Guillemet ouvrant sans guillemet fermant : ferme la citation (« … » ou “ … ”) ou retire " +
    "le guillemet, sinon elle ne peut pas être contrôlée.",
  [QUOTE_WARNING_REASON.UNVERIFIABLE]:
    `Contrôle impossible (cause indiquée) : relis le passage avec \`${AGENT_TOOLS.ragGetText}\` ` +
    "avant de conserver cette citation.",
}
