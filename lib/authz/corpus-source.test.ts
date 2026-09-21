// lib/authz/corpus-source.test.ts
// The three-state model of read-only corpus consumption. `corpusProjectId` is
// the only way to resolve which project's corpus to read, and missing one call
// site is the main failure mode of the feature — so the resolution and the
// revoked state both get explicit coverage here.

import { test } from "node:test"
import assert from "node:assert/strict"

import {
  CORPUS_SOURCE_STATE,
  canReachCorpus,
  corpusProjectId,
  corpusSourceState,
  isDerived,
} from "./corpus-source"

const own = { id: "p1", corpusSourceId: null, corpusSourceShareId: null }
const shared = { id: "p2", corpusSourceId: "p1", corpusSourceShareId: "s1" }
const revoked = { id: "p3", corpusSourceId: "p1", corpusSourceShareId: null }

test("a normal project reads its own corpus", () => {
  assert.equal(corpusProjectId(own), "p1")
  assert.equal(isDerived(own), false)
  assert.equal(corpusSourceState(own), CORPUS_SOURCE_STATE.OWN)
  assert.equal(canReachCorpus(own), true)
})

test("a derived project reads its source's corpus", () => {
  assert.equal(corpusProjectId(shared), "p1")
  assert.equal(isDerived(shared), true)
  assert.equal(corpusSourceState(shared), CORPUS_SOURCE_STATE.SHARED)
  assert.equal(canReachCorpus(shared), true)
})

test("a revoked derived project still points at its source but cannot reach it", () => {
  // The id stays coherent on purpose: callers get a real project id and the
  // denial comes from canReachCorpus, never from a silently-swapped id that
  // would serve the workspace's own empty corpus as if it were the source's.
  assert.equal(corpusProjectId(revoked), "p1")
  assert.equal(isDerived(revoked), true)
  assert.equal(corpusSourceState(revoked), CORPUS_SOURCE_STATE.REVOKED)
  assert.equal(canReachCorpus(revoked), false)
})

test("the three states are mutually exclusive and exhaustive", () => {
  const states = [own, shared, revoked].map(corpusSourceState)
  assert.deepEqual(states, [
    CORPUS_SOURCE_STATE.OWN,
    CORPUS_SOURCE_STATE.SHARED,
    CORPUS_SOURCE_STATE.REVOKED,
  ])
  assert.equal(new Set(states).size, 3)
})
