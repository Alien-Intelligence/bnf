// scripts/seed-sharing-demo.ts
// Seeds a hand-drivable scenario for the groups & sharing feature against a
// RUNNING dev server: an admin/owner, a reader, one group, and one ingested
// corpus shared into it. Deliberately does NOT create the derived workspace —
// that is the interesting thing to do by hand.
//
//   npm run dev -- -p 3001      # in another terminal
//   npx tsx --env-file-if-exists .env.local --conditions react-server scripts/seed-sharing-demo.ts
//
// Idempotent: re-running reuses the accounts and the group.
import { prisma } from "@/lib/db"
import { ProjectService } from "@/models/projects/service"
import { ProjectQueries } from "@/models/projects/queries"
import { ProjectSharingService } from "@/models/projects/sharing"
import { PROJECT_ACCESS } from "@/lib/authz/project-access"

const BASE = process.env["APP_URL"] ?? "http://localhost:3001"
const PW = "demo-sharing"

const OWNER = "camille@bnf-demo.local"
const READER = "helene@bnf-demo.local"
const GROUP_SLUG = "departement-recherche"

async function ensureUser(email: string, name: string) {
  const existing = await prisma.user.findUnique({ where: { email } })
  if (existing) return existing

  const res = await fetch(`${BASE}/api/auth/sign-up/email`, {
    method: "POST",
    headers: { "Content-Type": "application/json", origin: BASE },
    body: JSON.stringify({ email, password: PW, name }),
  })
  if (!res.ok) {
    throw new Error(`sign-up ${email} failed: ${res.status} ${await res.text()}`)
  }
  return prisma.user.findUniqueOrThrow({ where: { email } })
}

async function main() {
  const owner = await ensureUser(OWNER, "Camille Rousseau")
  const reader = await ensureUser(READER, "Hélène Marchand")
  // The owner doubles as the admin so one login covers both the console and
  // the sharing side of the story.
  await prisma.user.update({ where: { id: owner.id }, data: { role: "admin" } })

  const group = await prisma.group.upsert({
    where: { slug: GROUP_SLUG },
    create: { name: "Département Recherche", slug: GROUP_SLUG },
    update: {},
  })
  for (const userId of [owner.id, reader.id]) {
    await prisma.groupMember.upsert({
      where: { groupId_userId: { groupId: group.id, userId } },
      create: { groupId: group.id, userId },
      update: {},
    })
  }

  // The shared corpus. Marked ingested directly: every guard in this feature
  // reads `ingestedVersionId`, and running a real ingestion here would cost
  // real OCR spend for a scenario that never queries the passages.
  const existing = await prisma.project.findFirst({
    where: { ownerId: owner.id, name: "Exposition Universelle 1889" },
  })
  const source =
    existing ??
    (await ProjectService.create({
      name: "Exposition Universelle 1889",
      subtitle: "Presse et controverses",
      ownerId: owner.id,
    }))
  await prisma.project.update({
    where: { id: source.id },
    data: { ingestedVersionId: source.headVersionId },
  })

  await ProjectSharingService.share(
    (await ProjectQueries.get(source.id))!,
    owner.id,
    { groupId: group.id, access: PROJECT_ACCESS.READ },
  )

  // A project the reader owns, so « Mes projets » is not empty for them.
  const readerOwn = await prisma.project.findFirst({
    where: { ownerId: reader.id, name: "Cabinet des Estampes" },
  })
  if (!readerOwn) {
    await ProjectService.create({
      name: "Cabinet des Estampes",
      subtitle: "Notes préparatoires",
      ownerId: reader.id,
    })
  }

  console.log(`
Seeded. Sign in at ${BASE}/fr/sign-in

  Owner + admin   ${OWNER}   / ${PW}
  Reader          ${READER}   / ${PW}

  Group    « Département Recherche » (both are members)
  Shared   « Exposition Universelle 1889 » — owned by Camille, shared at READ
  Reader   also owns « Cabinet des Estampes »

Try, as Hélène: « Partagés avec moi » → « Créer un espace » on the shared
corpus, then revoke the share as Camille and reload the workspace.
`)
}

main().then(() => process.exit(0)).catch((e) => { console.error(e); process.exit(1) })
