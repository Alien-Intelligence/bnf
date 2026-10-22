// lib/bnf/wire.ts
// Pure helpers for the BnF wire formats, shared by the transport
// (lib/bnf/direct.ts, server-only) and the pure OAI record parser
// (lib/bnf/oai-record.ts). No I/O and no `server-only`, so both can import it.

import { XMLParser } from "fast-xml-parser"

import { BnfMcpNotFoundError } from "@/lib/mcp/errors"
import { arkSchema } from "@/lib/validation/ark"

/** Prefix fast-xml-parser puts on attribute keys; every attribute read uses it. */
export const XML_ATTR_PREFIX = "@_"

// removeNSPrefix turns <dc:title> into "title" and <oai_dc:dc> into "dc", so
// callers navigate by local name. Attributes are kept (xml:lang on <dc:type>
// picks the French label). Values stay strings: an ARK-like or numeric-looking
// text must not be coerced.
export const bnfXmlParser = new XMLParser({
  ignoreAttributes: false,
  attributeNamePrefix: XML_ATTR_PREFIX,
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

/**
 * Validate that `ark` is a full ARK (`ark:/<naan>/<name>`) and return it
 * untouched. ARKs are opaque: never constructed from a bare id, so a bare or
 * malformed value fails here instead of becoming a plausible wrong identifier.
 * Terminal for that ARK (not retryable).
 */
export function assertFullArk(ark: string): string {
  if (!arkSchema.safeParse(ark).success) {
    throw new BnfMcpNotFoundError(`Not a full ARK (expected ark:/<naan>/<name>): ${ark}`)
  }
  return ark
}

/** ARK short form, as BnF records key it: the name after the last `/` of a full ARK. */
export function localArk(ark: string): string {
  return assertFullArk(ark).slice(ark.lastIndexOf("/") + 1)
}
