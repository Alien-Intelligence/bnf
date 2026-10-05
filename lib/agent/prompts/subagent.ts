// lib/agent/prompts/subagent.ts
// The directive appended to a spawned sub-agent's system prompt. The child
// inherits the parent scope's full system prompt (memory + corpus grounding via
// PromptBuilder) so it reasons with the same context, then this directive
// reframes it as a FOCUSED, isolated worker: do one heavy sweep, deposit
// findings durably (buffer / notes), and return a short synthesis — never a
// transcript, because the parent only ever sees the returned text.
//
// French, like every agent-facing prompt (the working language is FR).
import { AGENT_TOOLS } from "@/lib/agent/tools/constants"
import { SESSION_SCOPE, type SessionScope } from "@/models/sessions/schema"

/** Sub-agent directive for a given scope + concrete sub-task. */
export function buildSubagentDirective(scope: SessionScope, task: string): string {
  const shared =
    "\n\n---\n\n" +
    "# TU ES UN SOUS-AGENT DE RECHERCHE\n" +
    "Tu as été délégué·e par l'agent principal pour accomplir UNE tâche ciblée, " +
    "dans un contexte isolé. L'agent principal ne verra PAS ton déroulé — il ne " +
    "recevra que ta synthèse finale. Par conséquent :\n" +
    "- Concentre-toi exclusivement sur la tâche confiée ci-dessous.\n" +
    "- Dépose tes trouvailles de façon DURABLE (voir ci-dessous) — ne compte pas " +
    "sur ton texte pour transmettre des données volumineuses.\n" +
    "- Termine par une SYNTHÈSE COURTE (quelques phrases) : ce que tu as trouvé, " +
    "combien, et où tu l'as déposé. Pas de liste exhaustive, pas de transcript.\n" +
    "- Tu ne peux PAS déléguer à ton tour (pas de sous-sous-agent).\n"

  const deposit =
    scope === SESSION_SCOPE.CORPUS
      ? "## Dépôt (corpus)\n" +
        `Balaie UNIQUEMENT avec \`${AGENT_TOOLS.corpusSearch}\` (presse : \`doc_type: "fascicule"\`, ` +
        "`collapsing: false`) et laisse les candidats s'accumuler dans le TAMPON avec " +
        "leurs métadonnées. N'utilise JAMAIS `bnf__bnf_search_*` : leurs résultats " +
        `n'entrent pas dans le tampon, et les redéposer avec \`${AGENT_TOOLS.bufferAdd}\` coûte une ` +
        `requête BnF par ARK. Tu peux inspecter le tampon (\`${AGENT_TOOLS.bufferStats}\`, \`${AGENT_TOOLS.bufferList}\`). ` +
        `NE VALIDE PAS le corpus (\`${AGENT_TOOLS.bufferCommit}\`) et ne vide pas le tampon : la ` +
        "validation reste la décision de l'agent principal après revue. Ta synthèse " +
        "donne les chiffres renvoyés par les outils (`added`, `alreadyInCorpus`), " +
        "jamais une estimation.\n"
      : "## Dépôt (recherche)\n" +
        `Utilise \`${AGENT_TOOLS.ragQuery}\` / \`${AGENT_TOOLS.ragKeywordSearch}\` / \`${AGENT_TOOLS.ragGetText}\` pour rassembler ` +
        `les passages pertinents du corpus ingéré, et \`${AGENT_TOOLS.docGet}\` au besoin. Ta ` +
        "synthèse cite les ARK+folios clés trouvés ; l'agent principal rédigera la " +
        "note finale à partir de ta synthèse.\n"

  return `${shared}\n${deposit}\n## TA TÂCHE\n${task}\n`
}
