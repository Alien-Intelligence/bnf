import "server-only"

// lib/agent/prompts/bnf-knowledge.ts
// Static BnF domain knowledge injected into the corpus agent's system prompt.
// The production agent has NO internet access, so everything it needs to write
// correct SPARQL against data.bnf.fr and to resolve catalogue (cb) notices to
// digitized Gallica ARKs must live here.
//
// Sourced from the official BnF API docs (api.bnf.fr), the data.bnf.fr Virtuoso
// namespace declarations, and live SRU/SPARQL verification (2026-06-19). See
// the research notes for provenance. Keep facts here verifiable — do not add
// unconfirmed predicates, namespaces, or ARK families (e.g. "bd6t" was NOT
// confirmed and is deliberately omitted).

// ---------------------------------------------------------------------------
// Catalogue notices (cb ARKs) vs. digitized documents
// ---------------------------------------------------------------------------

export const BNF_CATALOGUE_GUIDE = `## NOTICES CATALOGUE (ARK \`cb…\`) vs DOCUMENTS NUMÉRISÉS

\`bnf__bnf_search_catalogue\` renvoie des **notices** du Catalogue général, identifiées par un ARK \`cb…\` (ex. \`ark:/12148/cb40096442t\`). **Une notice \`cb…\` n'est PAS un document numérisé** : pas de manifeste IIIF, pas de page Gallica, pas de texte intégral. Elle peut tout de même être ajoutée au corpus (l'application l'accepte et la marque « non ingérable »), mais elle ne sera pas indexée ni interrogeable après ingestion. Préfère donc toujours résoudre vers l'ARK Gallica quand il existe, et **préviens explicitement l'utilisateur** quand tu ajoutes une notice \`cb…\` non numérisée.

Familles d'ARK (le préfixe après \`ark:/12148/\` indique le système source) :
- \`cb…\` — notice du Catalogue général. Description bibliographique seulement. **Pas d'IIIF, pas de texte.**
- \`cc…\` — instrument de recherche archives (EAD). **Pas d'IIIF.**
- \`bpt6k…\` — Gallica, imprimés (livres, presse). **Manifeste IIIF + OCR.** Ingérable.
- \`btv1b…\` — Gallica, manuscrits / images / cartes / estampes. **Manifeste IIIF.** Ingérable.

Seuls les ARK \`bpt6k…\` et \`btv1b…\` sont ingérables. Manifeste IIIF d'un document numérisé :
\`https://gallica.bnf.fr/iiif/ark:/12148/<id>/manifest.json\`

### Passer d'une notice \`cb…\` à son ARK Gallica (par ordre de fiabilité)

1. **Champ UNIMARC 856 $u** — appelle \`bnf__bnf_get_catalogue_record\`. Si la notice a une version numérisée, le champ \`856 $u\` contient l'URL Gallica (ex. \`http://gallica.bnf.fr/ark:/12148/bpt6k2029874\`) : en extraire l'ARK \`bpt6k…\`/\`btv1b…\`. Déterministe quand présent. (Absence possible si la notice n'est pas numérisée, ou en variante Intermarc.)
2. **SPARQL data.bnf.fr** — \`rdarelationships:electronicReproduction\` au niveau de la manifestation donne l'URL Gallica (voir la section « SPARQL sur data.bnf.fr »). Déterministe quand le lien existe.
3. **Re-recherche Gallica** — à défaut, \`bnf__bnf_search_gallica\` par titre + auteur + date. Vérifie la concordance des métadonnées avant de traiter le résultat comme la même édition. Heuristique.

### Règle de décision

- L'utilisateur veut des documents **ingérables** (texte intégral / IIIF) → privilégie directement \`bnf__bnf_search_gallica\` (ARK \`bpt6k…\`/\`btv1b…\`, avec manifeste IIIF). Utilise-les tels quels.
- Tu as une notice \`cb…\` → tente 1, puis 2, puis 3. Dès qu'un ARK Gallica est obtenu, c'est lui qu'on ajoute (de préférence à la notice).
- Aucun document numérisé trouvé par aucune voie → tu **peux** quand même ajouter la notice \`cb…\` si elle a une valeur pour le corpus (référence catalographique, complétude), mais **préviens l'utilisateur** : « Ce document n'est pas numérisé sur Gallica ; la notice sera ajoutée mais ne sera pas ingérée (non interrogeable en texte intégral). » N'ajoute jamais une notice \`cb…\` en silence comme si c'était un document numérisé.`

// ---------------------------------------------------------------------------
// SPARQL over data.bnf.fr
// ---------------------------------------------------------------------------

export const BNF_SPARQL_GUIDE = `## SPARQL sur data.bnf.fr (outil \`bnf__bnf_sparql_query\`)

Le graphe data.bnf.fr relie personnes, œuvres, sujets (Rameau) et **documents numérisés Gallica**. SPARQL sert surtout à découvrir des œuvres/auteurs/sujets et à **récupérer l'ARK Gallica ingérable** (\`bpt6k…\`/\`btv1b…\`) d'une œuvre ou d'un sujet.

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

Une fois l'ARK Gallica obtenu (\`bpt6k…\`/\`btv1b…\`) : manifeste IIIF = \`https://gallica.bnf.fr/iiif/ark:/12148/<id>/manifest.json\`. Ajoute cet ARK au corpus — jamais le \`cb…\`.`
