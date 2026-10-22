// tests/models/corpus/export-subtype.test.ts
// GET /corpus/export carries the Gallica subcategory as its own `subtype`
// column, right after `doc_type`, and the same filter that selects documents on
// screen selects them in the file. The route is driven for real (its handler,
// its CSV assembly); only the better-auth session lookup is replaced, since a
// signed cookie is not what is under test.
import "server-only"

import { test, before, after, mock } from "node:test"
import assert from "node:assert/strict"
import { prisma } from "@/lib/db"
import { auth } from "@/lib/auth"
import type { Project, User } from "@/lib/generated/prisma/client"
import { createTestUser, createTestProject, deleteTestUser } from "@/lib/testing/fixtures"
import { cleanupProject } from "@/lib/testing/project-cleanup"
import { CorpusService } from "@/models/corpus/service"
import { DOCUMENT_RESOLVE_STATUS } from "@/models/documents/schema"
import { GET } from "@/app/api/projects/[id]/corpus/export/route"

let user: User
let project: Project

const FASCICULE = "ark:/12148/bpt6k9300001"
const MONOGRAPH = "ark:/12148/bpt6k9300002"
const ESTAMPE = "ark:/12148/btv1b9300003"

before(async () => {
  user = await createTestUser()
  project = await createTestProject(user.id, "export-subtype")
  await prisma.document.createMany({
    data: [
      { ark: FASCICULE, docType: "press", subtype: "fascicules", title: "Fascicule" },
      { ark: MONOGRAPH, docType: "book", subtype: null, title: "Monographie" },
      { ark: ESTAMPE, docType: "image", subtype: "estampes", title: "Estampe" },
    ].map((d) => ({
      ...d,
      projectId: project.id,
      source: "gallica",
      lang: "fr",
      resolveStatus: DOCUMENT_RESOLVE_STATUS.RESOLVED,
    })),
  })
  await CorpusService.addArks(project, user, { arks: [FASCICULE, MONOGRAPH, ESTAMPE], reason: "fixture" })
  mock.method(auth.api, "getSession", async () => ({ session: { id: "test-session" }, user: { id: user.id } }))
})

after(async () => {
  mock.restoreAll()
  await cleanupProject(project.id)
  await deleteTestUser(user.id)
})

/** The export for `query`, as header → value maps, one per data line. */
async function exportFor(query: string): Promise<Array<Record<string, string>>> {
  const res = await GET(new Request(`http://localhost/api/projects/${project.id}/corpus/export${query}`), {
    params: Promise.resolve({ id: project.id }),
  })
  assert.equal(res.status, 200)
  const [header, ...lines] = (await res.text()).trim().split(/\r?\n/)
  const columns = header.split(",")
  return lines.map((line) => {
    const cells = line.split(",")
    return Object.fromEntries(columns.map((c, i) => [c, cells[i]]))
  })
}

test("the CSV has a subtype column; a document with no subcategory has it empty", async () => {
  const rows = await exportFor("")
  const byArk = new Map(rows.map((r) => [r.ark, r]))
  assert.equal(byArk.get(FASCICULE)?.subtype, "fascicules")
  assert.equal(byArk.get(ESTAMPE)?.subtype, "estampes")
  assert.equal(byArk.get(MONOGRAPH)?.subtype, "")
})

test("subtype sits right after doc_type in the header", async () => {
  const res = await GET(new Request(`http://localhost/api/projects/${project.id}/corpus/export`), {
    params: Promise.resolve({ id: project.id }),
  })
  const columns = (await res.text()).split(/\r?\n/)[0].split(",")
  assert.equal(columns[columns.indexOf("doc_type") + 1], "subtype")
})

test("the subtype filter reaches the export: the file holds exactly the filtered set", async () => {
  const rows = await exportFor("?subtype=fascicules")
  assert.deepEqual(rows.map((r) => r.ark), [FASCICULE])
})

test("an invalid subtype is refused with a 400, not dropped", async () => {
  const res = await GET(new Request(`http://localhost/api/projects/${project.id}/corpus/export?subtype=gazette`), {
    params: Promise.resolve({ id: project.id }),
  })
  assert.equal(res.status, 400)
})
