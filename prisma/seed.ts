/**
 * prisma/seed.ts — BnF Corpus Research dev database seed.
 *
 * Run via:  npx prisma db seed
 * Which executes: tsx --conditions react-server prisma/seed.ts
 *   (--conditions react-server makes `server-only` resolve to the empty shim
 *   so we can import service modules that guard against client bundling.)
 *
 * Required environment variables (via .env.local, loaded by prisma.config.ts):
 *   DATABASE_URL       — Postgres connection string
 *   BETTER_AUTH_SECRET — ≥ 32-char secret for better-auth token signing
 *   BETTER_AUTH_URL    — e.g. http://localhost:3000
 *   ANTHROPIC_API_KEY  — required by lib/env.ts at import time (even though
 *                        the seed itself never calls the Anthropic API)
 *
 * Idempotent: re-running produces no duplicates and no errors.
 *
 * What it does:
 *   1. Ensures dev user leo@alien.club exists (via auth.api.signUpEmail).
 *   2. Ensures Project A "Exposition Universelle 1889" exists (ProjectService.create).
 *   3. Upserts 30 hand-picked documents from the prototype SEED data.
 *   4. Adds all 30 ARKs to the corpus (CorpusService.addArks → head seq=2).
 *   5. Removes the first ARK (CorpusService.removeArks → head seq=3).
 *      The Document row is NOT deleted — membership change only (invariant).
 *   6. Ensures Project B "Brouillon" exists, empty (head stays seq=1).
 *   7. Prints a summary with project URLs and corpus counts.
 */

// NOTE: .env.local is loaded by the tsx --env-file-if-exists flag configured
// in prisma.config.ts migrations.seed. Environment variables are therefore
// available before any module initialisation (ESM imports are hoisted and
// execute before user code, so a dotenv.config() call inside the script body
// would be too late for lib/env.ts and lib/db.ts).

import { auth } from "@/lib/auth"
import { UserQueries } from "@/models/users/queries"
import { ProjectQueries } from "@/models/projects/queries"
import { ProjectService } from "@/models/projects/service"
import { DocumentService } from "@/models/documents/service"
import { CorpusService } from "@/models/corpus/service"
import { prisma } from "@/lib/db"

// ---------------------------------------------------------------------------
// Seed document data — sourced from the prototype SEED JS object.
// ARKs are opaque identifiers from the BnF/Gallica URN scheme; we use them
// verbatim from the design prototype. Types match the `docType` column.
// ---------------------------------------------------------------------------
const SEED_DOCS = [
  {
    ark: "ark:/12148/bpt6k2839841",
    title: "Le Figaro — 6 mai 1889",
    author: "Le Figaro",
    year: 1889,
    docType: "press",
    lang: "fr",
    source: "gallica",
    pages: 6,
    excerpt:
      "PARIS, 6 MAI. — L'Exposition est ouverte. Dès l'aube, une foule considérable se pressait aux abords du Champ de Mars, et la cérémonie d'inauguration, présidée par M. le Président de la République, a revêtu un éclat sans précédent.\n\nC'est la fête du travail et de la paix que la France offre aujourd'hui au monde entier…",
  },
  {
    ark: "ark:/12148/bpt6k227349z",
    title: "Le Temps — 5 mai 1889",
    author: "Le Temps",
    year: 1889,
    docType: "press",
    lang: "fr",
    source: "gallica",
    pages: 4,
    excerpt:
      "L'inauguration de l'Exposition universelle aura lieu demain. On remarquera l'absence des souverains étrangers : la célébration du centenaire de 1789 a tenu à l'écart les cours monarchiques de l'Europe. L'enjeu, pour la jeune République, est tout entier diplomatique…",
  },
  {
    ark: "ark:/12148/bpt6k6151234",
    title: "Le Petit Journal — 7 mai 1889",
    author: "Le Petit Journal",
    year: 1889,
    docType: "press",
    lang: "fr",
    source: "gallica",
    pages: 4,
    excerpt:
      "C'est aujourd'hui que l'Exposition s'ouvre enfin au peuple. La Tour Eiffel domine le panorama de ses trois cents mètres d'acier. Le public afflue en masse depuis les faubourgs. On dit qu'il y aura cent mille visiteurs dès ce premier dimanche ouvert…",
  },
  {
    ark: "ark:/12148/bpt6k527891p",
    title: "Le Gaulois — 15 mai 1889",
    author: "Le Gaulois",
    year: 1889,
    docType: "press",
    lang: "fr",
    source: "gallica",
    pages: 4,
  },
  {
    ark: "ark:/12148/bpt6k459102t",
    title: "Journal des débats — 6 mai 1889",
    author: "Journal des débats",
    year: 1889,
    docType: "press",
    lang: "fr",
    source: "gallica",
    pages: 4,
  },
  {
    ark: "ark:/12148/bpt6k3841029",
    title: "Le Siècle — 6 mai 1889",
    author: "Le Siècle",
    year: 1889,
    docType: "press",
    lang: "fr",
    source: "retronews",
    pages: 4,
  },
  {
    ark: "ark:/12148/bpt6k5512089",
    title: "La République française — 7 mai 1889",
    author: "La République française",
    year: 1889,
    docType: "press",
    lang: "fr",
    source: "retronews",
    pages: 4,
  },
  {
    ark: "ark:/12148/bpt6k2910347",
    title: "Le Matin — 7 mai 1889",
    author: "Le Matin",
    year: 1889,
    docType: "press",
    lang: "fr",
    source: "retronews",
    pages: 4,
    excerpt:
      "Les foules du monde entier convergent vers la capitale. Depuis la gare du Nord, les omnibus font la navette sans relâche jusqu'au Champ-de-Mars. La tour de M. Eiffel apparaît à chaque carrefour, étrange silhouette métallique qui étonne encore…",
  },
  {
    ark: "ark:/12148/bpt6k6901234",
    title: "L'Écho de Paris — 15 mai 1889",
    author: "L'Écho de Paris",
    year: 1889,
    docType: "press",
    lang: "fr",
    source: "gallica",
    pages: 4,
  },
  {
    ark: "ark:/12148/bpt6k7109832",
    title: "Le Voltaire — 8 mai 1889",
    author: "Le Voltaire",
    year: 1889,
    docType: "press",
    lang: "fr",
    source: "retronews",
    pages: 2,
  },
  {
    ark: "ark:/12148/bpt6k6293847",
    title: "Le Monde illustré — 11 mai 1889",
    author: "Le Monde illustré",
    year: 1889,
    docType: "press",
    lang: "fr",
    source: "gallica",
    pages: 16,
  },
  {
    ark: "ark:/12148/bpt6k104789x",
    title: "L'Illustration — n°2412, 11 mai 1889",
    author: "L'Illustration",
    year: 1889,
    docType: "press",
    lang: "fr",
    source: "gallica",
    pages: 20,
  },
  {
    ark: "ark:/12148/bpt6k4781230",
    title: "La Presse — 6 mai 1889",
    author: "La Presse",
    year: 1889,
    docType: "press",
    lang: "fr",
    source: "retronews",
    pages: 4,
  },
  {
    ark: "ark:/12148/bpt6k7529018",
    title: "Gil Blas — 6 mai 1889",
    author: "Gil Blas",
    year: 1889,
    docType: "press",
    lang: "fr",
    source: "retronews",
    pages: 4,
  },
  {
    ark: "ark:/12148/bpt6k1238740",
    title: "Le Temps — 14 février 1887",
    author: "Le Temps",
    year: 1887,
    docType: "press",
    lang: "fr",
    source: "gallica",
    pages: 4,
    excerpt:
      "Nous, écrivains, sculpteurs, architectes, amateurs passionnés de la beauté jusqu'ici intacte de Paris, protestons de toutes nos forces, au nom du goût français méconnu, contre l'érection en plein cœur de notre capitale de l'inutile et monstrueuse Tour Eiffel…",
  },
  {
    ark: "ark:/12148/bpt6k4892011",
    title: "Le Charivari — caricatures de l'Expo",
    author: "Le Charivari",
    year: 1889,
    docType: "press",
    lang: "fr",
    source: "gallica",
    pages: 8,
  },
  {
    ark: "ark:/12148/bpt6k9102983",
    title: "Le Monde illustré — rétrospective 1890",
    author: "Le Monde illustré",
    year: 1890,
    docType: "press",
    lang: "fr",
    source: "gallica",
    pages: 14,
  },
  {
    ark: "ark:/12148/btv1b531284c",
    title: "Tour Eiffel en construction — 1888",
    author: "Photographie, P. Petit",
    year: 1888,
    docType: "image",
    lang: "fr",
    source: "gallica",
    pages: 1,
  },
  {
    ark: "ark:/12148/btv1b8492011",
    title: "Galerie des machines, vue intérieure",
    author: "Photographie",
    year: 1889,
    docType: "image",
    lang: "fr",
    source: "gallica",
    pages: 1,
  },
  {
    ark: "ark:/12148/btv1b8451123",
    title: "Vue panoramique depuis le Trocadéro",
    author: "Photographie",
    year: 1889,
    docType: "image",
    lang: "fr",
    source: "gallica",
    pages: 1,
    excerpt:
      "Vue prise depuis la hauteur du Trocadéro. On distingue au premier plan le pont d'Iéna et les pavillons étrangers ; la Tour Eiffel occupe le centre de la composition. Tirage albuminé.",
  },
  {
    ark: "ark:/12148/btv1b5308811",
    title: "Portrait de G. Eiffel au sommet",
    author: "Photographie",
    year: 1889,
    docType: "image",
    lang: "fr",
    source: "gallica",
    pages: 1,
  },
  {
    ark: "ark:/12148/btv1b6209034",
    title: "Fontaines lumineuses de nuit",
    author: "Photographie",
    year: 1889,
    docType: "image",
    lang: "fr",
    source: "gallica",
    pages: 1,
  },
  {
    ark: "ark:/12148/btv1b9006722",
    title: "Affiche officielle — Exposition Universelle",
    author: "Estampe, impr. Champenois",
    year: 1889,
    docType: "estampe",
    lang: "fr",
    source: "gallica",
    pages: 1,
  },
  {
    ark: "ark:/12148/btv1b8456720",
    title: "Gravure — Inauguration de la Tour Eiffel",
    author: "Estampe, Le Monde illustré",
    year: 1889,
    docType: "estampe",
    lang: "fr",
    source: "gallica",
    pages: 1,
  },
  {
    ark: "ark:/12148/btv1b8901234",
    title: "Caricature — « Le Citoyen Eiffel »",
    author: "Estampe, Le Charivari",
    year: 1889,
    docType: "estampe",
    lang: "fr",
    source: "gallica",
    pages: 1,
    excerpt:
      "Caricature publiée dans Le Charivari, représentant Gustave Eiffel en géant d'acier enjambant Paris. Légende : « Tremble, monsieur de la Critique ! »",
  },
  {
    ark: "ark:/12148/bpt6k9612345",
    title: "Catalogue général officiel de l'Exposition",
    author: "Ministère du Commerce",
    year: 1889,
    docType: "book",
    lang: "fr",
    source: "gallica",
    pages: 642,
    excerpt:
      "Le présent catalogue recense l'ensemble des exposants admis par la Commission impériale. Les nations représentées sont au nombre de trente-cinq. La section française occupe à elle seule la moitié du palais des Beaux-Arts…",
  },
  {
    ark: "ark:/12148/bpt6k5384021",
    title: "Rapport général — A. Picard",
    author: "Alfred Picard",
    year: 1891,
    docType: "book",
    lang: "fr",
    source: "gallica",
    pages: 510,
  },
  {
    ark: "ark:/12148/bpt6k6529871",
    title: "Guide bleu de l'Exposition de 1889",
    author: "Hachette",
    year: 1889,
    docType: "book",
    lang: "fr",
    source: "gallica",
    pages: 288,
  },
  {
    ark: "ark:/12148/bpt6k7219034",
    title: "Les Merveilles de l'Exposition — Sciences",
    author: "Librairie illustrée",
    year: 1889,
    docType: "book",
    lang: "fr",
    source: "gallica",
    pages: 198,
  },
  {
    ark: "ark:/12148/btv1b8492756",
    title: "Plan général de l'Exposition, Champ de Mars",
    author: "Carte, échelle 1:2 000",
    year: 1889,
    docType: "map",
    lang: "fr",
    source: "gallica",
    pages: 1,
  },
  // Two English-language press entries (mix of lang, per the prototype)
  {
    ark: "ark:/12148/bpt6k81120w7",
    title: "The Graphic — The Paris Exhibition",
    author: "The Graphic (London)",
    year: 1889,
    docType: "press",
    lang: "en",
    source: "gallica",
    pages: 8,
  },
  {
    ark: "ark:/12148/bpt6k81244q3",
    title: "The Illustrated London News — Paris",
    author: "Illustrated London News",
    year: 1889,
    docType: "press",
    lang: "en",
    source: "retronews",
    pages: 10,
  },
] as const

// ---------------------------------------------------------------------------
// Helper: is this error a better-auth "email already taken" response?
//
// better-auth throws an APIError (from better-call) with:
//   err.body.code === "USER_ALREADY_EXISTS_USE_ANOTHER_EMAIL"
//   err.status  === "UNPROCESSABLE_ENTITY"
//
// We catch ONLY this case. Every other error propagates — per
// CLAUDE_ERROR_PATTERNS.md: "catch-all exceptions without re-raising" is
// a forbidden pattern.
// ---------------------------------------------------------------------------
function isEmailAlreadyExistsError(err: unknown): boolean {
  if (err === null || typeof err !== "object") return false
  const e = err as Record<string, unknown>

  // Primary: check the body.code field that better-auth sets
  if (
    typeof e["body"] === "object" &&
    e["body"] !== null &&
    (e["body"] as Record<string, unknown>)["code"] ===
      "USER_ALREADY_EXISTS_USE_ANOTHER_EMAIL"
  ) {
    return true
  }

  // Fallback: status string check (belt-and-suspenders, same error)
  if (e["status"] === "UNPROCESSABLE_ENTITY") {
    return true
  }

  return false
}

// ---------------------------------------------------------------------------
// Main seed
// ---------------------------------------------------------------------------
async function seed(): Promise<void> {
  console.log("=== BnF seed: starting ===")

  // -------------------------------------------------------------------------
  // Step 1 — Dev user
  // -------------------------------------------------------------------------
  console.log("Step 1: ensuring dev user leo@alien.club …")

  // Try to create the user via the same auth path the sign-up UI uses.
  try {
    // Password must meet better-auth's minimum length (default: 8 chars).
    // "dev-local" is clearly non-production and easy to remember.
    await auth.api.signUpEmail({
      body: {
        email: "leo@alien.club",
        password: "dev-local",
        name: "Leo",
      },
    })
    console.log("  ✓ Dev user created")
  } catch (err: unknown) {
    if (isEmailAlreadyExistsError(err)) {
      console.log("  ✓ Dev user already exists — skipping creation")
    } else {
      // Any other error is genuinely unexpected — propagate.
      throw err
    }
  }

  // Load the user record so we have the id for downstream service calls.
  const devUser = await UserQueries.getByEmail("leo@alien.club")
  if (!devUser) {
    throw new Error(
      "Dev user leo@alien.club not found after creation — database inconsistency",
    )
  }
  console.log(`  userId = ${devUser.id}`)

  // -------------------------------------------------------------------------
  // Step 2 — Project A (populated)
  // Idempotent: skip if a project with this name already exists for this owner.
  // -------------------------------------------------------------------------
  const PROJECT_A_NAME = "Exposition Universelle 1889"
  const PROJECT_B_NAME = "Brouillon"

  console.log(`Step 2: ensuring project "${PROJECT_A_NAME}" …`)

  const existingProjects = await ProjectQueries.listForOwner(devUser.id)
  let projectA = existingProjects.find((p) => p.name === PROJECT_A_NAME) ?? null
  let projectAIsNew = false

  if (!projectA) {
    projectA = await ProjectService.create({
      name: PROJECT_A_NAME,
      subtitle: "Corpus · presse 1889",
      ownerId: devUser.id,
    })
    projectAIsNew = true
    console.log(`  ✓ Project A created (id=${projectA.id})`)
  } else {
    console.log(`  ✓ Project A already exists (id=${projectA.id}) — skipping creation`)
  }

  // -------------------------------------------------------------------------
  // Steps 3–5 only run when the project was just created.
  //
  // Rationale: the corpus mutation codepath (advanceVersion) is not idempotent
  // across seed runs on an already-populated project — re-adding all ARKs to
  // a head that already has 31 of 32 would re-add the one that was removed and
  // then immediately remove it again, creating spurious corpus versions.
  //
  // On first run (new project): executes the real codepath, producing seq=3.
  // On subsequent runs (existing project): skips to preserve DB state.
  // -------------------------------------------------------------------------
  if (projectAIsNew) {
    // Step 3 — Upsert documents
    console.log(`Step 3: upserting ${SEED_DOCS.length} documents …`)

    const docsToInsert = SEED_DOCS.map(({ ark, ...rest }) => ({
      ark,
      ...rest,
    }))

    await DocumentService.upsertMany(projectA.id, docsToInsert)
    console.log(`  ✓ ${SEED_DOCS.length} document rows upserted`)

    // Step 4 — Add all ARKs to the corpus via the real codepath.
    // Exercises advanceVersion() → head advances from seq=1 to seq=2.
    console.log("Step 4: adding all ARKs to corpus via CorpusService.addArks …")

    const allArks = SEED_DOCS.map((d) => d.ark)

    const addResult = await CorpusService.addArks(projectA, devUser, {
      arks: allArks,
      reason: "seed",
    })
    console.log(
      `  ✓ addArks complete — head seq=${addResult.versionSeq}, total=${addResult.total}, +${addResult.lastDeltaAdded}`,
    )

    // Step 5 — Remove the first ARK (regression test for removeArks + diff).
    // Head advances from seq=2 to seq=3. The Document row stays.
    console.log("Step 5: removing first ARK via CorpusService.removeArks …")

    const removedArk = SEED_DOCS[0].ark
    const removeResult = await CorpusService.removeArks(projectA, devUser, {
      arks: [removedArk],
      reason: "seed-remove-test",
    })
    console.log(
      `  ✓ removeArks complete — head seq=${removeResult.versionSeq}, total=${removeResult.total}, -${removeResult.lastDeltaRemoved}`,
    )
  } else {
    console.log("Steps 3–5: skipped (project A already exists — corpus state preserved)")
  }

  // -------------------------------------------------------------------------
  // Step 6 — Project B (empty, for empty-state UI testing)
  // -------------------------------------------------------------------------
  console.log(`Step 6: ensuring project "${PROJECT_B_NAME}" …`)

  let projectB = existingProjects.find((p) => p.name === PROJECT_B_NAME) ?? null

  if (!projectB) {
    projectB = await ProjectService.create({
      name: PROJECT_B_NAME,
      subtitle: "Corpus vide pour le test",
      ownerId: devUser.id,
    })
    console.log(`  ✓ Project B created (id=${projectB.id})`)
  } else {
    console.log(`  ✓ Project B already exists (id=${projectB.id}) — skipping creation`)
  }

  // -------------------------------------------------------------------------
  // Step 7 — Fetch final state for the summary print
  // -------------------------------------------------------------------------
  const projectAFinal = await prisma.project.findUniqueOrThrow({
    where: { id: projectA.id },
    select: { headVersionId: true },
  })
  const projectBFinal = await prisma.project.findUniqueOrThrow({
    where: { id: projectB.id },
    select: { headVersionId: true },
  })

  const headA = await prisma.corpusVersion.findFirstOrThrow({
    where: { id: projectAFinal.headVersionId! },
    select: { seq: true, status: true },
  })
  const headB = await prisma.corpusVersion.findFirstOrThrow({
    where: { id: projectBFinal.headVersionId! },
    select: { seq: true, status: true },
  })

  const membershipCountA = await prisma.corpusMembership.count({
    where: { versionId: projectAFinal.headVersionId! },
  })
  const docCountA = await prisma.document.count({
    where: { projectId: projectA.id },
  })

  // -------------------------------------------------------------------------
  // Summary
  // -------------------------------------------------------------------------
  console.log("")
  console.log("=== BnF seed: complete ===")
  console.log("")
  console.log("Dev user:  leo@alien.club  /  password: dev-local")
  console.log("")
  console.log(`Project A: "${PROJECT_A_NAME}" (id=${projectA.id})`)
  console.log(`  URL:  http://localhost:3000/projects/${projectA.id}/constituer`)
  console.log(`  Head: seq=${headA.seq}, status=${headA.status}`)
  console.log(`  Corpus membership (head): ${membershipCountA} ARKs`)
  console.log(`  Document rows (project): ${docCountA} (includes removed-ARK row)`)
  console.log("")
  console.log(`Project B: "${PROJECT_B_NAME}" (id=${projectB.id})`)
  console.log(`  Head: seq=${headB.seq}, status=${headB.status}`)
  console.log(`  Corpus membership (head): 0 ARKs`)
  console.log("")
  console.log("Validation queries:")
  console.log(
    `  SELECT seq, status FROM corpus_version WHERE project_id = '${projectA.id}' ORDER BY seq;`,
  )
  console.log(
    `  SELECT count(*) FROM corpus_membership WHERE version_id = (SELECT head_version_id FROM project WHERE id = '${projectA.id}');`,
  )
  console.log(
    `  SELECT count(*) FROM document WHERE project_id = '${projectA.id}';`,
  )
}

seed()
  .then(() => {
    process.exit(0)
  })
  .catch((err: unknown) => {
    console.error("Seed failed:", err)
    process.exit(1)
  })
