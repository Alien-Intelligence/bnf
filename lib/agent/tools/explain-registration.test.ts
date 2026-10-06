// lib/agent/tools/explain-registration.test.ts
// The plain-French explanation a staging tool returns whenever `added` is
// below what the search found (Track E Phase 6). Session (b) read
// `added: 0, refreshed: 50, buffered: 0` as a malfunction and looped for ten
// minutes; these strings are what it should have read instead.
import { test } from "node:test"
import assert from "node:assert/strict"
import { explainRegistration, type BufferRegisterResult } from "@/models/buffer/service"

const base: BufferRegisterResult = {
  requested: 50,
  added: 0,
  restaged: 0,
  refreshed: 0,
  alreadyInCorpus: 0,
  previouslyDiscarded: 0,
  skipped: 0,
  unresolved: 0,
  total: 0,
}

test("nothing to explain when every hit became a candidate", () => {
  assert.equal(explainRegistration(50, { ...base, added: 50, total: 50 }), null)
})

test("all already in the corpus: not a malfunction, do not clear and retry", () => {
  const s = explainRegistration(50, { ...base, alreadyInCorpus: 50 })
  assert.ok(s)
  assert.match(s, /^0 nouveau candidat/)
  assert.match(s, /50 sont déjà dans le corpus \(validés plus tôt\)/)
  assert.match(s, /ce n'est pas une panne/)
  assert.match(s, /Inutile de vider le tampon ou de relancer cette recherche/)
})

test("every other bucket gets its own clause", () => {
  const s = explainRegistration(10, {
    ...base,
    added: 3,
    restaged: 2,
    refreshed: 2,
    previouslyDiscarded: 2,
    skipped: 1,
    alreadyInCorpus: 2,
  })
  assert.ok(s)
  assert.match(s, /^3 nouveaux candidats/)
  assert.match(s, /2 sont déjà dans le corpus/)
  assert.match(s, /2 étaient déjà dans le tampon/)
  assert.match(s, /2 ont été écartés plus tôt, non réintroduits/)
  assert.match(s, /2 retirés du corpus depuis, de nouveau candidats/)
  assert.match(s, /1 n'est pas un document/)
})
