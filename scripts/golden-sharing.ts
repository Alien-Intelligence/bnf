// scripts/golden-sharing.ts
// End-to-end validation of groups, project sharing and read-only corpus
// workspaces, against a RUNNING dev server (npm run dev). Three throwaway
// accounts — an admin, a corpus owner, a reader — driving the real HTTP
// surface, because that is where an authorization regression actually shows:
// the unit tests cover the predicate, this covers the wiring.
//
//   npm run dev                 # in another terminal
//   npm run e2e:sharing
//
// Every account, group and project it creates is torn down on the way out.
//
// Note: parseBody runs before authorize() in these routes, so a malformed body
// answers 400 and never reaches the policy — the 403 assertions below are only
// meaningful with valid payloads.
import { prisma } from "@/lib/db"
import { randomUUID } from "node:crypto"

const BASE = process.env["APP_URL"] ?? "http://localhost:3001"
const PW = "TestPassword123!"

type Session = { cookie: string; id: string; email: string }

let failures = 0
function check(ok: boolean, label: string, detail = "") {
  console.log(`${ok ? "  ok  " : "  FAIL"} ${label}${detail ? ` — ${detail}` : ""}`)
  if (!ok) failures++
}

async function signUp(label: string): Promise<Session> {
  const email = `gp-${label}-${randomUUID().slice(0, 8)}@bnf-golden.local`
  const res = await fetch(`${BASE}/api/auth/sign-up/email`, {
    method: "POST",
    headers: { "Content-Type": "application/json", origin: BASE },
    body: JSON.stringify({ email, password: PW, name: `golden ${label}` }),
  })
  if (!res.ok) throw new Error(`sign-up ${label}: ${res.status} ${await res.text()}`)
  const cookie = (res.headers.getSetCookie() ?? []).map((c) => c.split(";")[0]).join("; ")
  const user = await prisma.user.findUniqueOrThrow({ where: { email } })
  return { cookie, id: user.id, email }
}

function api(s: Session) {
  return async (path: string, init: RequestInit = {}) => {
    const res = await fetch(`${BASE}${path}`, {
      ...init,
      headers: { "Content-Type": "application/json", origin: BASE, cookie: s.cookie, ...init.headers },
    })
    const text = await res.text()
    let body: unknown = text
    try { body = JSON.parse(text) } catch { /* non-JSON (CSV export) */ }
    return { status: res.status, body: body as never }
  }
}

const created: string[] = []

async function main() {
  const admin = await signUp("admin")
  await prisma.user.update({ where: { id: admin.id }, data: { role: "admin" } })
  const A = await signUp("owner")
  const B = await signUp("reader")
  // C is granted nothing by A, ever. They exist to prove that a grant to B
  // cannot be re-granted onward (step 6b).
  const C = await signUp("outsider")

  const adminApi = api(admin), a = api(A), b = api(B), c = api(C)

  // 1. Admin creates a group and adds A and B.
  console.log("\n1. admin creates « Département Recherche » and adds A + B")
  const groupName = `Département Recherche ${randomUUID().slice(0, 8)}`
  const g = await adminApi("/api/groups", { method: "POST", body: JSON.stringify({ name: groupName }) })
  check(g.status === 201, "POST /api/groups → 201", String(g.status))
  const groupId = (g.body as { id: string }).id

  const nonAdmin = await a("/api/groups", { method: "POST", body: JSON.stringify({ name: "Interdit" }) })
  check(nonAdmin.status === 403, "a non-admin cannot create a group → 403", String(nonAdmin.status))

  for (const u of [A, B]) {
    const r = await adminApi(`/api/groups/${groupId}/members`, { method: "POST", body: JSON.stringify({ email: u.email }) })
    check(r.status === 201, `add ${u.email.split("@")[0]} → 201`, String(r.status))
  }
  const unknown = await adminApi(`/api/groups/${groupId}/members`, { method: "POST", body: JSON.stringify({ email: "nobody@bnf-golden.local" }) })
  check(unknown.status === 422, "adding an unknown address → 422, not a silent no-op", String(unknown.status))

  // 2. A creates a project, builds a corpus, "ingests" it.
  console.log("\n2. A creates a project and ingests a corpus")
  const p = await a("/api/projects", { method: "POST", body: JSON.stringify({ name: `Corpus A ${randomUUID().slice(0, 8)}` }) })
  check(p.status === 201, "POST /api/projects → 201", String(p.status))
  const source = (p.body as { id: string; headVersionId: string }).id
  created.push(source)

  const add = await a(`/api/projects/${source}/corpus/add`, { method: "POST", body: JSON.stringify({ arks: ["ark:/12148/bpt6k9999991"], reason: "golden path" }) })
  check(add.status === 200 || add.status === 201, "A can add to their own corpus", String(add.status))

  // Ingestion needs the worker; the pointer is what every guard reads, so set it
  // directly rather than standing up the whole pipeline for an authz check.
  const withHead = await prisma.project.findUniqueOrThrow({ where: { id: source } })
  await prisma.project.update({ where: { id: source }, data: { ingestedVersionId: withHead.headVersionId } })

  // 3. Before sharing, B sees nothing.
  console.log("\n3. before sharing, B cannot see the project")
  const bList0 = await b("/api/projects")
  check(!(bList0.body as { id: string }[]).some((x) => x.id === source), "B's project list excludes it")
  const bRead0 = await b(`/api/projects/${source}/corpus`)
  check(bRead0.status === 403, "B GET corpus → 403", String(bRead0.status))

  // 4. A shares at read.
  console.log("\n4. A shares the project with the group at read")
  const sh = await a(`/api/projects/${source}/shares`, { method: "POST", body: JSON.stringify({ groupId, access: "read" }) })
  check(sh.status === 201, "POST shares → 201", String(sh.status))

  const bShare = await b(`/api/projects/${source}/shares`, { method: "POST", body: JSON.stringify({ groupId, access: "write" }) })
  check(bShare.status === 403, "a read-shared member cannot re-share → 403", String(bShare.status))

  // 5. B sees it read-only.
  console.log("\n5. B sees it under « Partagés avec moi », read-only")
  const bList = await b("/api/projects")
  const row = (bList.body as { id: string; access: string; ownerName: string }[]).find((x) => x.id === source)
  check(row?.access === "read", "the row carries access=read", String(row?.access))
  check(!!row?.ownerName, "the row carries the owner's name", row?.ownerName)

  const bRead = await b(`/api/projects/${source}/corpus`)
  check(bRead.status === 200, "B GET corpus → 200", String(bRead.status))
  const bWrite = await b(`/api/projects/${source}/corpus/add`, { method: "POST", body: JSON.stringify({ arks: ["ark:/12148/bpt6k9999992"], reason: "golden path" }) })
  check(bWrite.status === 403, "B POST corpus/add → 403", String(bWrite.status))
  const bIngest = await b(`/api/projects/${source}/ingest`, { method: "POST", body: JSON.stringify({}) })
  check(bIngest.status === 403, "B POST ingest → 403", String(bIngest.status))

  // 6. B derives a workspace.
  console.log("\n6. B creates a derived research workspace")
  const d = await b("/api/projects/derived", { method: "POST", body: JSON.stringify({ sourceProjectId: source, name: "Espace de B" }) })
  check(d.status === 201, "POST /api/projects/derived → 201", `${d.status} ${JSON.stringify(d.body).slice(0, 160)}`)
  const derived = (d.body as { id: string }).id
  created.push(derived)

  const dRow = await prisma.project.findUniqueOrThrow({ where: { id: derived } })
  check(dRow.corpusSourceId === source, "corpusSourceId points at A's project")
  check(dRow.corpusSourceShareId !== null, "the grant is pinned")
  check(dRow.ownerId === B.id, "B owns the workspace")

  const dCorpus = await b(`/api/projects/${derived}/corpus`)
  check(dCorpus.status === 200, "the derived corpus reads through → 200", String(dCorpus.status))
  check((dCorpus.body as { total: number }).total === (bRead.body as { total: number }).total,
        "it returns the SOURCE's corpus, not its own empty head")

  const dAdd = await b(`/api/projects/${derived}/corpus/add`, { method: "POST", body: JSON.stringify({ arks: ["ark:/12148/bpt6k9999993"], reason: "golden path" }) })
  check(dAdd.status === 403, "B cannot mutate their own derived corpus → 403", String(dAdd.status))
  const dSess = await b(`/api/projects/${derived}/sessions`, { method: "POST", body: JSON.stringify({ scope: "corpus" }) })
  check(dSess.status === 403, "a corpus session on a derived project → 403", String(dSess.status))
  const dSessR = await b(`/api/projects/${derived}/sessions`, { method: "POST", body: JSON.stringify({ scope: "research" }) })
  check(dSessR.status === 201, "a research session → 201", String(dSessR.status))
  const dDiff = await b(`/api/projects/${derived}/corpus/diff?from=1&to=1`)
  check(dDiff.status === 409, "diff on a derived project → 409", String(dDiff.status))

  // 6b. B may not re-share the workspace. B owns it, but its corpus is A's, and
  // the derived read path resolves through corpusProjectId() gated on the
  // workspace's pinned share — never on the caller's access to the source. Were
  // this allowed, B would hand A's corpus to a group A never granted anything
  // to. Checked over HTTP because the hole was in the route's policy, not the
  // read path: every other assertion in this file passed while it was open.
  console.log("\n6b. B cannot launder their read grant into an onward one")
  const outsiderGroupName = `Externe ${randomUUID().slice(0, 8)}`
  const g2 = await adminApi("/api/groups", { method: "POST", body: JSON.stringify({ name: outsiderGroupName }) })
  const outsiderGroup = (g2.body as { id: string }).id
  for (const u of [B, C]) {
    await adminApi(`/api/groups/${outsiderGroup}/members`, { method: "POST", body: JSON.stringify({ email: u.email }) })
  }

  const cBefore = await c(`/api/projects/${source}/corpus`)
  check(cBefore.status === 403, "C has no access to A's source → 403", String(cBefore.status))

  const launder = await b(`/api/projects/${derived}/shares`, { method: "POST", body: JSON.stringify({ groupId: outsiderGroup, access: "read" }) })
  check(launder.status === 403, "B sharing their derived workspace → 403", String(launder.status))

  const cAfter = await c(`/api/projects/${derived}/corpus`)
  check(cAfter.status === 403, "C still cannot read A's corpus via the workspace → 403", String(cAfter.status))

  const cList = await c("/api/projects")
  check(!JSON.stringify(cList.body).includes(derived), "C's project list does not contain the workspace")

  // An admin is not the way round it either: the corpus still is not theirs.
  const adminLaunder = await adminApi(`/api/projects/${derived}/shares`, { method: "POST", body: JSON.stringify({ groupId: outsiderGroup, access: "read" }) })
  check(adminLaunder.status === 403, "an admin sharing a derived workspace → 403", String(adminLaunder.status))

  await prisma.group.deleteMany({ where: { id: outsiderGroup } })

  // A note in B's carnet, not A's.
  const note = await b(`/api/projects/${derived}/notes`, { method: "POST", body: JSON.stringify({ title: "Note de B", bodyMd: "Contenu" }) })
  check(note.status === 201, "B writes a note in their workspace → 201", String(note.status))
  const aNotes = await a(`/api/projects/${source}/notes`)
  check((aNotes.body as unknown[]).length === 0, "A's carnet is untouched")

  // 7. A revokes.
  console.log("\n7. A revokes the share")
  const rev = await a(`/api/projects/${source}/shares/${groupId}`, { method: "DELETE" })
  check(rev.status === 200, "DELETE share → 200", String(rev.status))

  const after = await prisma.project.findUniqueOrThrow({ where: { id: derived } })
  check(after.corpusSourceId === source && after.corpusSourceShareId === null, "the workspace is in the revoked state")
  check(await prisma.note.count({ where: { projectId: derived } }) === 1, "B's note survives")

  const revCorpus = await b(`/api/projects/${derived}/corpus`)
  check(revCorpus.status === 409, "the derived corpus → 409 revoked, not an empty list", String(revCorpus.status))
  const bSource = await b(`/api/projects/${source}/corpus`)
  check(bSource.status === 403, "B loses access to the source itself → 403", String(bSource.status))
  const bCarnet = await b(`/api/projects/${derived}/notes`)
  check(bCarnet.status === 200 && (bCarnet.body as unknown[]).length === 1, "B's carnet is still readable")

  // 8. A re-shares at write.
  console.log("\n8. A re-shares at write")
  const sh2 = await a(`/api/projects/${source}/shares`, { method: "POST", body: JSON.stringify({ groupId, access: "write" }) })
  check(sh2.status === 201, "re-share → 201", String(sh2.status))
  check((sh2.body as unknown[]).length === 1, "one grant per (project, group), updated not duplicated")

  const bWrite2 = await b(`/api/projects/${source}/corpus/add`, { method: "POST", body: JSON.stringify({ arks: ["ark:/12148/bpt6k9999994"], reason: "golden path" }) })
  check(bWrite2.status === 200 || bWrite2.status === 201, "B can now add to A's corpus", String(bWrite2.status))
  const bDelShare = await b(`/api/projects/${source}/shares/${groupId}`, { method: "DELETE" })
  check(bDelShare.status === 403, "a write-shared member still cannot re-share → 403", String(bDelShare.status))

  // 9. Removing B from the group revokes on the next request.
  console.log("\n9. admin removes B from the group")
  await adminApi(`/api/groups/${groupId}/members/${B.id}`, { method: "DELETE" })
  const bAfterRemoval = await b(`/api/projects/${source}/corpus`)
  check(bAfterRemoval.status === 403, "B loses access immediately → 403", String(bAfterRemoval.status))

  console.log(`\n${failures === 0 ? "ALL CHECKS PASSED" : `${failures} CHECK(S) FAILED`}`)

  // Teardown
  await prisma.group.deleteMany({ where: { id: groupId } })
  const { cleanupProject } = await import("@/lib/testing/project-cleanup")
  for (const id of [...created].reverse()) await cleanupProject(id)
  for (const u of [admin, A, B, C]) await prisma.user.deleteMany({ where: { id: u.id } })
  process.exit(failures === 0 ? 0 : 1)
}

main().catch((e) => { console.error(e); process.exit(1) })
