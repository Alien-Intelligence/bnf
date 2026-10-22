// lib/bnf/wire.ts
// Pure helpers for the BnF wire formats, shared by the transport
// (lib/bnf/direct.ts, server-only) and the pure OAI record parser
// (lib/bnf/oai-record.ts). No I/O and no `server-only`, so both can import it.

import { XMLParser } from "fast-xml-parser"

// removeNSPrefix turns <dc:title> into "title" and <oai_dc:dc> into "dc", so
// callers navigate by local name. Attributes are kept (xml:lang on <dc:type>
// picks the French label). Values stay strings: an ARK-like or numeric-looking
// text must not be coerced.
export const bnfXmlParser = new XMLParser({
  ignoreAttributes: false,
  attributeNamePrefix: "@_",
  removeNSPrefix: true,
  trimValues: true,
  parseTagValue: false,
})

export type XmlNode = unknown

/** Coerce a parsed node (string | number | {#text, attrs} | array) to trimmed text, or null. */
export function nodeText(node: XmlNode): string | null {
  if (node === null || node === undefined) return null
  if (typeof node === "string") return node.trim() || null
  if (typeof node === "number") return String(node)
  if (Array.isArray(node)) {
    for (const n of node) {
      const t = nodeText(n)
      if (t) return t
    }
    return null
  }
  if (typeof node === "object" && "#text" in (node as Record<string, unknown>)) {
    return nodeText((node as Record<string, unknown>)["#text"])
  }
  return null
}

/** ARK short form, as BnF URLs and records key it: strip the `ark:/<naan>/` prefix. */
export function localArk(ark: string): string {
  return ark.replace(/^ark:\/\d+\//, "")
}

/** Full canonical ARK form, as the OAI identifier and Gallica URLs need it. */
export function fullArk(ark: string): string {
  return ark.startsWith("ark:/") ? ark : `ark:/12148/${ark}`
}
