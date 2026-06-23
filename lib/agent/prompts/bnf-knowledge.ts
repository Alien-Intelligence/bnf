import "server-only"

// lib/agent/prompts/bnf-knowledge.ts
// Static BnF domain knowledge injected into the corpus agent's system prompt.
// The production agent has NO internet access, so everything it needs to write
// correct SPARQL against data.bnf.fr and to resolve catalogue (cb) notices to
// digitized Gallica documents must live here.
//
// Sourced from the official BnF API docs (api.bnf.fr), the data.bnf.fr Virtuoso
// namespace declarations, and live SRU/SPARQL verification (2026-06-19). Keep
// facts here verifiable — do not add unconfirmed predicates, namespaces, or ARK
// families (e.g. "bd6t" was NOT confirmed and is deliberately omitted).
//
// NOTE: corpus building is NOT where "ingestability" is decided — that is the
// Ingérer (ingestion) step, computed automatically downstream. So this guide
// frames the cb-vs-digitized distinction around consultation/citation, never as
// an add-time filter, and never tells the agent to judge ARK validity.

// ---------------------------------------------------------------------------
// Catalogue notices (cb ARKs) vs. digitized documents
// ---------------------------------------------------------------------------

export const BNF_CATALOGUE_GUIDE = `## NOTICES CATALOGUE (ARK \`cb…\`) vs DOCUMENTS NUMÉRISÉS

**La constitution du corpus ne se soucie PAS de l'« ingestabilité ».** L'étape d'**ingestion** (ultérieure) détermine automatiquement ce qui sera indexé en texte intégral — ce n'est pas ton affaire ici. Donc : ne filtre pas, n'écarte pas, ne classe pas les documents selon qu'ils seraient « ingérables » ou non. **Tous les ARK BnF réels sont valides** et peuvent être ajoutés ; ne parle jamais d'ARK « valides / invalides » ni « ingérables / non ingérables ».

La distinction ci-dessous sert seulement à **comprendre et consulter** les documents (ouvrir la page, citer une vue précise) — pas à filtrer :

- \`cb…\` — **notice** du Catalogue général : une référence bibliographique (pas de page numérisée ni de viewer IIIF rattaché à cet ARK).
- \`cc…\` — instrument de recherche archives (EAD).
- \`bpt6k…\` — document **numérisé** Gallica (imprimés) : pages consultables + manifeste IIIF.
- \`btv1b…\` — document **numérisé** Gallica (manuscrits, images, cartes, estampes) : manifeste IIIF.

Manifeste IIIF d'un document numérisé : \`https://gallica.bnf.fr/iiif/ark:/12148/<id>/manifest.json\`.

### Notices \`cb…\` : l'upgrade vers le numérisé est AUTOMATIQUE à l'ajout

Quand tu ajoutes une notice \`cb…\` au corpus, l'application tente automatiquement de la **remplacer par son document numérisé Gallica** (\`bpt6k…\`/\`btv1b…\`) s'il en existe un — via \`rdarelationships:electronicReproduction\` (SPARQL data.bnf.fr) puis, à défaut, le champ UNIMARC \`856 $u\`. **Tu n'as donc pas à faire cette résolution toi-même** : ajoute l'ARK \`cb…\` tel quel et c'est la version consultable/citable qui entrera dans le corpus quand elle existe. Si la notice n'a pas de numérisation, elle reste un membre \`cb…\` parfaitement valide (référence bibliographique, sans copie numérisée rattachée à cet ARK).

Inutile donc de précharger l'ARK Gallica avant d'ajouter ; n'écarte jamais une notice « parce qu'elle est \`cb…\` ». Les routes ci-dessous (856 $u, \`electronicReproduction\`, re-recherche Gallica) ne te servent plus qu'en **diagnostic**, si tu veux toi-même montrer/consulter le document numérisé d'une notice donnée :

1. **Champ UNIMARC 856 $u** — \`bnf__bnf_get_catalogue_record\` : URL Gallica (ex. \`http://gallica.bnf.fr/ark:/12148/bpt6k2029874\`) → ARK \`bpt6k…\`/\`btv1b…\`.
2. **SPARQL data.bnf.fr** — \`rdarelationships:electronicReproduction\` au niveau de la manifestation (voir « SPARQL sur data.bnf.fr »).
3. **Re-recherche Gallica** — \`bnf__bnf_search_gallica\` par titre + auteur + date (vérifie la concordance des métadonnées).\``

// ---------------------------------------------------------------------------
// SPARQL over data.bnf.fr
// ---------------------------------------------------------------------------

export const BNF_SPARQL_GUIDE = `## SPARQL sur data.bnf.fr (outil \`bnf__bnf_sparql_query\`)

Le graphe data.bnf.fr relie personnes, œuvres, sujets (Rameau) et **documents numérisés Gallica**. SPARQL sert surtout à découvrir des œuvres/auteurs/sujets et à **récupérer l'ARK Gallica d'un document numérisé** (\`bpt6k…\`/\`btv1b…\`) d'une œuvre ou d'un sujet.

Quand l'utiliser : pour une simple personne → \`bnf__bnf_find_person\` ; pour une simple œuvre → \`bnf__bnf_find_work\`. Réserve SPARQL aux **jointures** (œuvres d'un auteur sur un sujet, par période, énumérer les éditions numérisées d'une œuvre, etc.).

### Règles impératives

- Dans une requête, les URI data.bnf.fr s'écrivent en **\`http://\` (JAMAIS \`https://\`)** — sinon zéro résultat.
- Toujours un \`LIMIT\` (100–500). Ancre la requête sur un ARK connu pour éviter les timeouts.
- Filtre les libellés en français : \`FILTER(langMatches(lang(?label), "fr"))\`.
- Une notice/concept est un \`skos:Concept\` à l'URI \`ark:/12148/cb…\`. L'entité bibliographique (personne, œuvre) est au même URI suffixé \`#about\`, ou atteinte via \`foaf:focus\`.
- Le lien vers le document numérisé Gallica est porté par la **manifestation** via \`rdarelationships:electronicReproduction\` (→ URL \`gallica.bnf.fr/ark:/12148/bpt6k…\`). \`rdfs:seeAlso\` au niveau manifestation pointe vers la notice catalogue (\`cb…\`), pas Gallica.
- Dates : \`bnf-onto:firstYear\` est un entier (comparaisons numériques directes). \`dcterms:date\` est une chaîne, moins fiable pour les plages.
- Recherche texte sur libellé : \`FILTER REGEX(?label, "terme", "i")\`.

### Préfixes (coller en tête de chaque requête)

\`\`\`sparql
PREFIX rdf:               <http://www.w3.org/1999/02/22-rdf-syntax-ns#>
PREFIX rdfs:              <http://www.w3.org/2000/01/rdf-schema#>
PREFIX owl:               <http://www.w3.org/2002/07/owl#>
PREFIX skos:              <http://www.w3.org/2004/02/skos/core#>
PREFIX dcterms:           <http://purl.org/dc/terms/>
PREFIX foaf:              <http://xmlns.com/foaf/0.1/>
PREFIX bio:               <http://vocab.org/bio/0.1/>
PREFIX frbr-rda:          <http://rdvocab.info/uri/schema/FRBRentitiesRDA/>
PREFIX rdarelationships:  <http://rdvocab.info/RDARelationshipsWEMI/>
PREFIX rdagroup2elements: <http://rdvocab.info/ElementsGr2/>
PREFIX bnf-onto:          <http://data.bnf.fr/ontology/bnf-onto/>
\`\`\`

### Modèle (Œuvre / Expression / Manifestation)

\`\`\`
skos:Concept  --foaf:focus-->  Œuvre (#about)
manifestation --rdarelationships:workManifested-->  Œuvre
manifestation --rdarelationships:electronicReproduction-->  URL Gallica (bpt6k…/btv1b…)
manifestation --rdfs:seeAlso-->  notice catalogue (cb…)
\`\`\`

### Exemples (copier-coller, adapter le terme/ARK)

Q1 — Trouver le concept (et l'ARK \`cb\`) d'une personne par son nom :
\`\`\`sparql
SELECT DISTINCT ?concept ?label WHERE {
  ?concept a skos:Concept ; skos:prefLabel ?label .
  FILTER (langMatches(lang(?label), "fr"))
  FILTER (REGEX(?label, "Maupassant", "i"))
} LIMIT 20
\`\`\`

Q2 — Éditions d'une œuvre connue, avec le lien Gallica :
\`\`\`sparql
SELECT DISTINCT ?edition ?title ?date ?gallicaURL WHERE {
  <http://data.bnf.fr/ark:/12148/cb12258414j> foaf:focus ?work .
  ?edition rdarelationships:workManifested ?work .
  OPTIONAL { ?edition dcterms:title ?title . }
  OPTIONAL { ?edition dcterms:date  ?date . }
  OPTIONAL { ?edition rdarelationships:electronicReproduction ?gallicaURL . }
} LIMIT 100
\`\`\`

Q3 — Documents numérisés sur un sujet (Rameau), avec ARK Gallica :
\`\`\`sparql
SELECT DISTINCT ?gallicaURL ?title ?year WHERE {
  ?subject skos:prefLabel ?subjectLabel .
  FILTER (langMatches(lang(?subjectLabel), "fr"))
  FILTER (REGEX(?subjectLabel, "Révolution française", "i"))
  ?edition dcterms:subject ?subject ;
           rdarelationships:electronicReproduction ?gallicaURL .
  OPTIONAL { ?edition dcterms:title ?title . }
  OPTIONAL { ?edition bnf-onto:firstYear ?year . }
} LIMIT 50
\`\`\`

Q4 — Manifestations sur un sujet, par plage d'années (\`firstYear\` est un entier) :
\`\`\`sparql
SELECT DISTINCT ?edition ?title ?year ?gallicaURL WHERE {
  ?edition a frbr-rda:Manifestation ;
           dcterms:subject <http://data.bnf.fr/ark:/12148/cb11932269g> ;
           bnf-onto:firstYear ?year .
  FILTER (?year >= 1789 && ?year <= 1815)
  OPTIONAL { ?edition dcterms:title ?title . }
  OPTIONAL { ?edition rdarelationships:electronicReproduction ?gallicaURL . }
} ORDER BY ?year LIMIT 100
\`\`\`

Q5 — Diagnostic : lister tous les prédicats d'une ressource inconnue :
\`\`\`sparql
SELECT DISTINCT ?p ?v WHERE {
  <http://data.bnf.fr/ark:/12148/cb11907966z#about> ?p ?v .
} LIMIT 200
\`\`\`

Une fois l'ARK Gallica obtenu (\`bpt6k…\`/\`btv1b…\`) : manifeste IIIF = \`https://gallica.bnf.fr/iiif/ark:/12148/<id>/manifest.json\`. Ajoute l'ARK trouvé au corpus.\``
