// lib/agent/prompts/shared.test.ts
// The cross-scope memory cap (Track E Phase 11): the OTHER step's memory is
// capped at MEMORY_CROSS_SCOPE_MAX_CHARS for the WHOLE rendered block —
// headings, newlines and the "not shown" tail included — and rendering stops
// at the first item that does not fit, across sections.
import "server-only"

import { test } from "node:test"
import assert from "node:assert/strict"
import { MEMORY_CROSS_SCOPE_MAX_CHARS, MEMORY_CROSS_SCOPE_MAX_ITEMS } from "@/lib/constants"
import { MEMORY_SCOPE } from "@/models/memory/schema"
import { renderCrossScopeMemory, type MemorySnapshot } from "./shared"

const fact = (n: number, length: number) => ({ id: `m${n}`, text: `${n} `.padEnd(length, "x") })

function snapshot(sections: Array<{ title: string; lengths: number[] }>): MemorySnapshot {
  let n = 0
  return {
    sections: sections.map((s) => ({ title: s.title, items: s.lengths.map((len) => fact(n++, len)) })),
  }
}

const render = (snap: MemorySnapshot) => renderCrossScopeMemory({ scope: MEMORY_SCOPE.RESEARCH, snapshot: snap })

test("the whole rendered block, tail included, never exceeds the character cap", () => {
  // Many sections of mid-size items: headings and separators add up.
  const snap = snapshot(
    Array.from({ length: 18 }, (_, i) => ({ title: `Section ${i} au titre assez long`, lengths: [180] })),
  )
  const out = render(snap)
  assert.ok(out.length <= MEMORY_CROSS_SCOPE_MAX_CHARS, `rendered ${out.length} chars`)
  assert.match(out, /éléments non affichés — memory_read scope="research"\)$/)
})

test("an item that does not fit stops rendering across sections", () => {
  const snap = snapshot([
    { title: "A", lengths: [100, MEMORY_CROSS_SCOPE_MAX_CHARS] },
    { title: "B", lengths: [20, 20] },
  ])
  const out = render(snap)
  assert.match(out, /### A/)
  assert.doesNotMatch(out, /### B/, "a later, shorter item never jumps the queue")
  assert.match(out, /\(\+3 éléments non affichés/)
})

test("the item cap holds, and a block under both caps renders whole without a tail", () => {
  const many = render(snapshot([{ title: "Lot", lengths: Array(MEMORY_CROSS_SCOPE_MAX_ITEMS + 5).fill(10) }]))
  assert.match(many, /\(\+5 éléments non affichés/)
  const few = render(snapshot([{ title: "Lot", lengths: [10, 10] }]))
  assert.doesNotMatch(few, /non affichés/)
  assert.equal(render({ sections: [] }), "(aucun élément)")
})

test("a first item larger than the cap leaves only the tail", () => {
  const out = render(snapshot([{ title: "A", lengths: [MEMORY_CROSS_SCOPE_MAX_CHARS + 10] }]))
  assert.equal(out, '(+1 éléments non affichés — memory_read scope="research")')
})
