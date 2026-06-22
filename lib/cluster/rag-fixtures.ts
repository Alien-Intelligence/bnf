// lib/cluster/rag-fixtures.ts
// Hand-written fake passages for the FakeRagRunner.
//
// Each entry extends RagPassage with a `topics` string array used by the
// scoring function to match against free-text queries without any embedding
// model.  Topics are lowercase French/English keywords — the scorer does a
// simple substring check.
//
// ARKs are taken verbatim from prisma/seed.ts (the 30-document seed set).
// Passages are illustrative excerpts that reflect the document type and
// period (Exposition Universelle 1889) — they are synthetic fixtures, not
// OCR output.

import type { RagPassage } from "./rag"

// Fixtures carry no entryId — the FakeRagRunner derives a stable one from the
// ARK (and uses it to reconstruct full text). Everything else mirrors RagPassage.
export type RagFixture = Omit<RagPassage, "entryId"> & { topics: string[] }

export const RAG_FIXTURES: RagFixture[] = [
  // ── Le Figaro — 6 mai 1889 ──────────────────────────────────────────────
  {
    ark: "ark:/12148/bpt6k2839841",
    folio: 1,
    snippet:
      "L'enthousiasme à l'inauguration de l'Exposition Universelle de Paris est sans précédent. Dès l'aube, une foule considérable se pressait aux abords du Champ de Mars.",
    score: 0.0,
    charRange: [0, 156] as [number, number],
    title: "Le Figaro, 6 mai 1889",
    year: 1889,
    topics: ["inauguration", "exposition", "figaro", "foule", "champ de mars", "universelle"],
  },
  {
    ark: "ark:/12148/bpt6k2839841",
    folio: 2,
    snippet:
      "La cérémonie d'inauguration, présidée par M. le Président de la République, a revêtu un éclat sans précédent. C'est la fête du travail et de la paix que la France offre aujourd'hui au monde entier.",
    score: 0.0,
    charRange: [157, 340] as [number, number],
    title: "Le Figaro, 6 mai 1889",
    year: 1889,
    topics: ["inauguration", "président", "république", "france", "exposition", "paix"],
  },

  // ── Le Temps — 5 mai 1889 ───────────────────────────────────────────────
  {
    ark: "ark:/12148/bpt6k227349z",
    folio: 1,
    snippet:
      "L'inauguration de l'Exposition universelle aura lieu demain. On remarquera l'absence des souverains étrangers : la célébration du centenaire de 1789 a tenu à l'écart les cours monarchiques de l'Europe.",
    score: 0.0,
    charRange: [0, 197] as [number, number],
    title: "Le Temps, 5 mai 1889",
    year: 1889,
    topics: ["inauguration", "exposition", "souverains", "centenaire", "monarchie", "europe", "diplomatie"],
  },
  {
    ark: "ark:/12148/bpt6k227349z",
    folio: 3,
    snippet:
      "L'enjeu, pour la jeune République, est tout entier diplomatique. Accueillir le monde entier sans la caution des têtes couronnées constitue un pari audacieux et républicain.",
    score: 0.0,
    charRange: [198, 367] as [number, number],
    title: "Le Temps, 5 mai 1889",
    year: 1889,
    topics: ["diplomatie", "république", "politique", "exposition", "monarchie"],
  },

  // ── Le Petit Journal — 7 mai 1889 ───────────────────────────────────────
  {
    ark: "ark:/12148/bpt6k6151234",
    folio: 1,
    snippet:
      "La Tour Eiffel domine le panorama de ses trois cents mètres d'acier. Le public afflue en masse depuis les faubourgs. On dit qu'il y aura cent mille visiteurs dès ce premier dimanche ouvert.",
    score: 0.0,
    charRange: [0, 185] as [number, number],
    title: "Le Petit Journal, 7 mai 1889",
    year: 1889,
    topics: ["tour eiffel", "eiffel", "visiteurs", "foule", "exposition", "acier"],
  },

  // ── Le Matin — 7 mai 1889 ───────────────────────────────────────────────
  {
    ark: "ark:/12148/bpt6k2910347",
    folio: 1,
    snippet:
      "Les foules du monde entier convergent vers la capitale. Depuis la gare du Nord, les omnibus font la navette sans relâche jusqu'au Champ-de-Mars. La tour de M. Eiffel apparaît à chaque carrefour, étrange silhouette métallique qui étonne encore.",
    score: 0.0,
    charRange: [0, 240] as [number, number],
    title: "Le Matin, 7 mai 1889",
    year: 1889,
    topics: ["tour eiffel", "eiffel", "foule", "transport", "champ de mars", "visiteurs", "métallique"],
  },
  {
    ark: "ark:/12148/bpt6k2910347",
    folio: 2,
    snippet:
      "Les hôteliers de la capitale ne désemplissent plus. Toutes les chambres sont louées jusqu'au mois de novembre. On parle de délégations venues d'Amérique, d'Asie, et même d'Océanie.",
    score: 0.0,
    charRange: [241, 416] as [number, number],
    title: "Le Matin, 7 mai 1889",
    year: 1889,
    topics: ["tourisme", "visiteurs", "exposition", "international", "délégations"],
  },

  // ── Le Temps — 14 février 1887 (pétition contre la Tour Eiffel) ─────────
  {
    ark: "ark:/12148/bpt6k1238740",
    folio: 1,
    snippet:
      "Nous, écrivains, sculpteurs, architectes, amateurs passionnés de la beauté jusqu'ici intacte de Paris, protestons de toutes nos forces contre l'érection en plein cœur de notre capitale de l'inutile et monstrueuse Tour Eiffel.",
    score: 0.0,
    charRange: [0, 225] as [number, number],
    title: "Le Temps, 14 février 1887",
    year: 1887,
    topics: ["pétition", "tour eiffel", "eiffel", "protestation", "artistes", "architectes", "critique"],
  },
  {
    ark: "ark:/12148/bpt6k1238740",
    folio: 2,
    snippet:
      "La pétition des Artistes réunit plus de trois cents signatures de personnalités du monde des arts et des lettres. Guy de Maupassant aurait déclaré ne plus vouloir voir cette « chandelle de ferraille ».",
    score: 0.0,
    charRange: [226, 424] as [number, number],
    title: "Le Temps, 14 février 1887",
    year: 1887,
    topics: ["pétition", "maupassant", "artistes", "tour eiffel", "eiffel", "critique", "ferraille"],
  },

  // ── Le Monde illustré — 11 mai 1889 (presse illustrée) ──────────────────
  {
    ark: "ark:/12148/bpt6k6293847",
    folio: 1,
    snippet:
      "Notre dessinateur a parcouru les allées de l'Exposition afin de croquer sur le vif les scènes les plus pittoresques. Les pavillons exotiques attirent une curiosité immense.",
    score: 0.0,
    charRange: [0, 172] as [number, number],
    title: "Le Monde illustré, 11 mai 1889",
    year: 1889,
    topics: ["presse illustrée", "exposition", "pavillons", "dessin", "exotique", "illustration"],
  },
  {
    ark: "ark:/12148/bpt6k6293847",
    folio: 8,
    snippet:
      "La Galerie des machines est le véritable temple de l'industrie moderne. Les engins à vapeur, les métiers à tisser mécaniques, les dynamos électriques : tout concourt à montrer la puissance du génie industriel.",
    score: 0.0,
    charRange: [512, 715] as [number, number],
    title: "Le Monde illustré, 11 mai 1889",
    year: 1889,
    topics: ["galerie des machines", "industrie", "machines", "vapeur", "électricité", "technique"],
  },

  // ── L'Illustration — n°2412, 11 mai 1889 ────────────────────────────────
  {
    ark: "ark:/12148/bpt6k104789x",
    folio: 3,
    snippet:
      "L'Illustration consacre ce numéro à l'Exposition Universelle. Nos gravures rendent compte, avec une fidélité sans égale, des merveilles que renferme le Champ de Mars.",
    score: 0.0,
    charRange: [0, 168] as [number, number],
    title: "L'Illustration, n°2412, 11 mai 1889",
    year: 1889,
    topics: ["presse illustrée", "illustration", "exposition", "gravure", "champ de mars"],
  },

  // ── Vue panoramique depuis le Trocadéro (photographie) ──────────────────
  {
    ark: "ark:/12148/btv1b8451123",
    folio: 1,
    snippet:
      "Vue prise depuis la hauteur du Trocadéro. On distingue au premier plan le pont d'Iéna et les pavillons étrangers ; la Tour Eiffel occupe le centre de la composition. Tirage albuminé.",
    score: 0.0,
    charRange: [0, 182] as [number, number],
    title: "Vue panoramique depuis le Trocadéro",
    year: 1889,
    topics: ["photographie", "trocadéro", "tour eiffel", "eiffel", "panorama", "exposition", "pavillons"],
  },

  // ── Caricature Le Charivari ──────────────────────────────────────────────
  {
    ark: "ark:/12148/btv1b8901234",
    folio: 1,
    snippet:
      "Caricature publiée dans Le Charivari, représentant Gustave Eiffel en géant d'acier enjambant Paris. Légende : « Tremble, monsieur de la Critique ! »",
    score: 0.0,
    charRange: [0, 149] as [number, number],
    title: "Caricature — « Le Citoyen Eiffel »",
    year: 1889,
    topics: ["caricature", "eiffel", "satire", "charivari", "presse illustrée", "humour"],
  },

  // ── Catalogue général officiel ───────────────────────────────────────────
  {
    ark: "ark:/12148/bpt6k9612345",
    folio: 1,
    snippet:
      "Le présent catalogue recense l'ensemble des exposants admis par la Commission impériale. Les nations représentées sont au nombre de trente-cinq.",
    score: 0.0,
    charRange: [0, 145] as [number, number],
    title: "Catalogue général officiel de l'Exposition",
    year: 1889,
    topics: ["catalogue", "exposants", "nations", "commission", "exposition", "officiel"],
  },
  {
    ark: "ark:/12148/bpt6k9612345",
    folio: 42,
    snippet:
      "La section française occupe à elle seule la moitié du palais des Beaux-Arts. Peinture, sculpture, architecture et arts appliqués sont représentés par plus de mille artistes.",
    score: 0.0,
    charRange: [146, 320] as [number, number],
    title: "Catalogue général officiel de l'Exposition",
    year: 1889,
    topics: ["beaux-arts", "peinture", "sculpture", "artistes", "exposition", "france"],
  },

  // ── Guide bleu de l'Exposition de 1889 ──────────────────────────────────
  {
    ark: "ark:/12148/bpt6k6529871",
    folio: 12,
    snippet:
      "Pour accéder à la Tour Eiffel, le visiteur empruntera l'ascenseur Otis, installé dans les piliers est et ouest. La montée jusqu'au deuxième étage coûte un franc cinquante.",
    score: 0.0,
    charRange: [0, 170] as [number, number],
    title: "Guide bleu de l'Exposition de 1889",
    year: 1889,
    topics: ["tour eiffel", "eiffel", "ascenseur", "visiteurs", "guide", "tarif"],
  },
  {
    ark: "ark:/12148/bpt6k6529871",
    folio: 55,
    snippet:
      "La Galerie des machines, longue de quatre cent vingt mètres, abrite les plus grands trésors de l'industrie contemporaine. La charpente métallique de la halle est elle-même un chef-d'œuvre d'ingénierie.",
    score: 0.0,
    charRange: [171, 368] as [number, number],
    title: "Guide bleu de l'Exposition de 1889",
    year: 1889,
    topics: ["galerie des machines", "industrie", "machines", "ingénierie", "guide", "métallique"],
  },

  // ── Les Merveilles de l'Exposition — Sciences ────────────────────────────
  {
    ark: "ark:/12148/bpt6k7219034",
    folio: 8,
    snippet:
      "L'électricité occupe une place de premier rang parmi les merveilles de l'Exposition. Les fontaines lumineuses, illuminées la nuit par des projecteurs de couleur, constituent un spectacle féerique inédit.",
    score: 0.0,
    charRange: [0, 196] as [number, number],
    title: "Les Merveilles de l'Exposition — Sciences",
    year: 1889,
    topics: ["électricité", "fontaines lumineuses", "sciences", "technique", "exposition", "lumière"],
  },
  {
    ark: "ark:/12148/bpt6k7219034",
    folio: 22,
    snippet:
      "Le phonographe d'Edison, exposé pour la première fois en France, suscite la stupéfaction des visiteurs. Entendre une voix humaine reproduite par une machine paraît tenir du prodige.",
    score: 0.0,
    charRange: [197, 380] as [number, number],
    title: "Les Merveilles de l'Exposition — Sciences",
    year: 1889,
    topics: ["phonographe", "edison", "sciences", "invention", "technique", "visiteurs"],
  },

  // ── The Illustrated London News ──────────────────────────────────────────
  {
    ark: "ark:/12148/bpt6k81244q3",
    folio: 4,
    snippet:
      "The Paris Exposition of 1889 surpasses all previous international exhibitions in scale and ambition. The Eiffel Tower, still regarded with scepticism by many, has become the undeniable symbol of the event.",
    score: 0.0,
    charRange: [0, 200] as [number, number],
    title: "The Illustrated London News — Paris",
    year: 1889,
    topics: ["eiffel", "exposition", "paris", "international", "english", "tower"],
  },

  // ── Affiche officielle ───────────────────────────────────────────────────
  {
    ark: "ark:/12148/btv1b9006722",
    folio: 1,
    snippet:
      "Affiche officielle de l'Exposition Universelle de 1889. Composition allégorique représentant la République française couronnant le génie industriel. Impression chromolithographique.",
    score: 0.0,
    charRange: [0, 178] as [number, number],
    title: "Affiche officielle — Exposition Universelle",
    year: 1889,
    topics: ["affiche", "estampe", "exposition", "allégorie", "république", "officiel", "art"],
  },

  // ── Tour Eiffel en construction — 1888 ──────────────────────────────────
  {
    ark: "ark:/12148/btv1b531284c",
    folio: 1,
    snippet:
      "Photographie prise en 1888 montrant la structure métallique de la Tour Eiffel à mi-construction. Les quatre piliers convergent vers le premier étage. Les ouvriers sont visibles sur les échafaudages.",
    score: 0.0,
    charRange: [0, 194] as [number, number],
    title: "Tour Eiffel en construction — 1888",
    year: 1888,
    topics: ["tour eiffel", "eiffel", "construction", "photographie", "acier", "ingénierie", "ouvriers"],
  },

  // ── Rapport général — Alfred Picard ─────────────────────────────────────
  {
    ark: "ark:/12148/bpt6k5384021",
    folio: 18,
    snippet:
      "L'Exposition de 1889 a accueilli trente-deux millions de visiteurs en six mois. Ce chiffre, jamais atteint, témoigne du succès populaire d'une manifestation que beaucoup jugeaient prématurée.",
    score: 0.0,
    charRange: [0, 193] as [number, number],
    title: "Rapport général — A. Picard",
    year: 1891,
    topics: ["visiteurs", "bilan", "exposition", "succès", "statistiques", "rapport"],
  },
  {
    ark: "ark:/12148/bpt6k5384021",
    folio: 74,
    snippet:
      "La recette totale des entrées s'élève à quarante et un millions de francs. Les dépenses, y compris la construction de la Tour Eiffel et de la Galerie des machines, atteignent quarante-trois millions.",
    score: 0.0,
    charRange: [194, 390] as [number, number],
    title: "Rapport général — A. Picard",
    year: 1891,
    topics: ["budget", "finances", "exposition", "bilan", "rapport", "statistiques"],
  },

  // ── Plan général de l'Exposition ────────────────────────────────────────
  {
    ark: "ark:/12148/btv1b8492756",
    folio: 1,
    snippet:
      "Plan général de l'Exposition Universelle de 1889, à l'échelle 1:2 000. On y distingue : le Champ de Mars, le Trocadéro, la Tour Eiffel, la Galerie des machines, les pavillons étrangers.",
    score: 0.0,
    charRange: [0, 185] as [number, number],
    title: "Plan général de l'Exposition, Champ de Mars",
    year: 1889,
    topics: ["plan", "carte", "exposition", "champ de mars", "trocadéro", "tour eiffel", "galerie des machines"],
  },
]
