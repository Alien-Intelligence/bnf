// tests/models/documents/canonical-lang.test.ts
// The Document.lang boot pass completes the migration's MARC-only UPDATE:
// uppercase codes, language names and unknown codes all end in
// canonicalLang's form, and a second run changes nothing.
import "server-only"

import { test, before, after } from "node:test"
import assert from "node:assert/strict"
import { prisma } from "@/lib/db"
import type { Project, User } from "@/lib/generated/prisma/client"
import { canonicalizeDocumentLangs } from "@/lib/documents/canonical-lang"
import { createTestUser, createTestProject, deleteTestUser } from "@/lib/testing/fixtures"
import { cleanupProject } from "@/lib/testing/project-cleanup"

let user: User
let project: Project

const CASES: Array<[string, string, string]> = [
  ["ark:/12148/bpt6k9610001", "DEU", "de"],
  ["ark:/12148/bpt6k9610002", "allemand", "de"],
  ["ark:/12148/bpt6k9610003", "ger", "de"],
  ["ark:/12148/bpt6k9610004", "fr", "fr"],
  ["ark:/12148/bpt6k9610005", "XYZ", "xyz"],
]

before(async () => {
  user = await createTestUser()
  project = await createTestProject(user.id, "canonical-lang")
  await prisma.document.createMany({
    data: CASES.map(([ark, lang]) => ({ ark, lang, projectId: project.id, source: "gallica", resolveStatus: "resolved" })),
  })
})

after(async () => {
  await cleanupProject(project.id)
  await deleteTestUser(user.id)
})

test("every stored lang ends in canonicalLang's form; a second run is a no-op", async () => {
  await canonicalizeDocumentLangs()
  for (const [ark, , expected] of CASES) {
    const doc = await prisma.document.findUniqueOrThrow({ where: { projectId_ark: { projectId: project.id, ark } } })
    assert.equal(doc.lang, expected, ark)
  }
  assert.deepEqual(await canonicalizeDocumentLangs(), { updated: 0 })
})
