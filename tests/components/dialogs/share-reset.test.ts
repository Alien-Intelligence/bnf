// tests/components/dialogs/share-reset.test.ts
// DialogProjectShare resets its transient state (pending revoke, errors) by
// UNMOUNTING ShareDialogBody when the dialog closes: the body sits inside
// DialogContent, whose Base UI popup is removed on close unless `keepMounted`
// is set. That is the accepted reset form where react-hooks/set-state-in-effect
// forbids useEffect([open]) (playbook/client-patterns.md §2). This test parses
// the two files (TypeScript AST, not text search) and fails if the mechanism
// is broken: a `keepMounted` anywhere on the dialog's parts, or the body moved
// outside DialogContent.

import { test } from "node:test"
import assert from "node:assert/strict"
import { readFileSync } from "node:fs"
import path from "node:path"
import ts from "typescript"

const ROOT = path.resolve(import.meta.dirname, "../../..")

function parse(rel: string): ts.SourceFile {
  const file = path.join(ROOT, rel)
  return ts.createSourceFile(file, readFileSync(file, "utf8"), ts.ScriptTarget.Latest, true, ts.ScriptKind.TSX)
}

type Jsx = ts.JsxElement | ts.JsxSelfClosingElement

function tagOf(node: Jsx): string {
  const opening = ts.isJsxElement(node) ? node.openingElement : node
  return opening.tagName.getText()
}

function attributeNames(node: Jsx): string[] {
  const opening = ts.isJsxElement(node) ? node.openingElement : node
  return opening.attributes.properties.flatMap((p) => (ts.isJsxAttribute(p) ? [p.name.getText()] : []))
}

function jsxElements(root: ts.Node): Jsx[] {
  const found: Jsx[] = []
  const visit = (n: ts.Node) => {
    if (ts.isJsxElement(n) || ts.isJsxSelfClosingElement(n)) found.push(n)
    ts.forEachChild(n, visit)
  }
  visit(root)
  return found
}

test("no part of the share dialog or the dialog primitive sets keepMounted", () => {
  for (const rel of ["components/dialogs/projects/share.tsx", "components/ui/dialog.tsx"]) {
    const offenders = jsxElements(parse(rel)).filter((el) => attributeNames(el).includes("keepMounted"))
    assert.deepEqual(offenders.map(tagOf), [], `${rel} sets keepMounted`)
  }
})

test("ShareDialogBody is rendered inside DialogContent, so closing unmounts it", () => {
  const contents = jsxElements(parse("components/dialogs/projects/share.tsx")).filter(
    (el) => tagOf(el) === "DialogContent",
  )
  assert.equal(contents.length, 1)
  const inside = jsxElements(contents[0]).map(tagOf)
  assert.ok(inside.includes("ShareDialogBody"), "ShareDialogBody must sit inside DialogContent")
})
