// lib/bnf/oai-record.ts
// Pure parser for one Gallica OAI-PMH `GetRecord` response (oai_dc).
//
// No I/O: the transport (lib/bnf/direct.ts) fetches the XML, this module turns
// it into a BnfMcpDocumentDetail. Keeping it pure lets the fixtures under
// tests/fixtures/bnf/oai/ pin every branch.
//
// Fields are read ONLY from GetRecord/record/{header, metadata/dc} by direct
// path, never by a tree-wide search, so an unrelated element elsewhere in the
// envelope (an HTML proxy page's <title>, an <error>) can never be mistaken for
// record metadata.
import "server-only"

import { XMLValidator } from "fast-xml-parser"

import type { BnfMcpDocumentDetail } from "@/lib/bnf/types"
import {
  assertFullArk,
  bnfXmlParser,
  localArk,
  nodeText,
  XML_ATTR_PREFIX,
  type XmlNode,
} from "@/lib/bnf/wire"
import { GALLICA_ITEM_URL } from "@/lib/constants"
import { BnfMcpError, BnfMcpNotFoundError } from "@/lib/mcp/errors"
import { GALLICA_DOC_TYPE, PRESS_MARKER } from "@/lib/mcp/vocab"

const OAI_ROOT = "OAI-PMH"
const OAI_ERROR_ID_DOES_NOT_EXIST = "idDoesNotExist"
const OAI_HEADER_STATUS_DELETED = "deleted"
const TYPEDOC_SET_SPEC = /^gallica:typedoc:(.+)$/
const TEXT_MODE = /mode\s+texte/i
const TOTAL_VIEWS = /Nombre total de vues\s*:\s*(\d+)/i
const FRENCH_LANG = "fre"
// The page-level viewer URL is the stable link (the bare document URL 403s).
const FIRST_FOLIO = 1

function asObject(node: XmlNode): Record<string, unknown> | undefined {
  return node !== null && typeof node === "object" && !Array.isArray(node)
    ? (node as Record<string, unknown>)
    : undefined
}

/** A child as a list: absent → [], single → [x], repeated → the array. */
function children(node: XmlNode, key: string): XmlNode[] {
  const child = asObject(node)?.[key]
  if (child === undefined || child === null) return []
  return Array.isArray(child) ? child : [child]
}

/** Every non-empty text of the repeated child `key`, in document order. */
function texts(node: XmlNode, key: string): string[] {
  return children(node, key).flatMap((c) => {
    const t = nodeText(c)
    return t === null ? [] : [t]
  })
}

function attribute(node: XmlNode, name: string): string | undefined {
  const v = asObject(node)?.[`${XML_ATTR_PREFIX}${name}`]
  return typeof v === "string" ? v : undefined
}

/**
 * The Gallica typedoc tail from the record header <setSpec> values
 * ("gallica:typedoc:periodiques:fascicules" → "periodiques:fascicules"), or
 * undefined when absent. The authoritative docType discriminator: <dc:type>
 * values are generic physical-form labels that collapse periodicals to "book".
 * Drives docType and Document.subtype via mapGallicaTypedoc / gallicaSubtype.
 *
 * `header` is the record's <header> node.
 */
export function pickTypedoc(header: XmlNode): string | undefined {
  for (const spec of texts(header, "setSpec")) {
    const m = TYPEDOC_SET_SPEC.exec(spec)
    if (m) return m[1]
  }
  return undefined
}

/**
 * True if any <dc:description> announces a text layer ("Avec mode texte").
 * OAI marks OCR'd documents this way. Precision is 100 % (0 false positives
 * over 276 sampled records) but recall is not: every OCR'd press issue lacks
 * it, so absence proves nothing (see the SDS-945 G0 parity result).
 *
 * `dc` is the record's <dc> metadata node.
 */
export function hasTextMode(dc: XmlNode): boolean {
  return texts(dc, "description").some((t) => TEXT_MODE.test(t))
}

/**
 * Total view count from <dc:format>"Nombre total de vues : N", or undefined.
 * It is collection-level for periodical issues (bpt6k268418n: 4 real folios,
 * the note says 3197), so callers must treat it as a raw figure, never as a
 * page count.
 *
 * `dc` is the record's <dc> metadata node.
 */
export function totalViews(dc: XmlNode): number | undefined {
  for (const t of texts(dc, "format")) {
    const m = TOTAL_VIEWS.exec(t)
    if (m) return Number(m[1])
  }
  return undefined
}

/**
 * Choose a doc_type from the (often multi-valued, multi-lingual) <dc:type>
 * elements. A value that is itself a known Gallica enum key ("fascicule",
 * "monographie", …) wins over the generic French physical-form label; then a
 * press label ("publication en série imprimée"), which a record without a
 * typedoc setSpec carries after the generic "texte" and which the page rule
 * needs to see; then the French label; then the first value. The typedoc setSpec stays authoritative
 * (see pickTypedoc); this is the safety net for records without one.
 */
function pickDocType(dc: XmlNode): string | undefined {
  const types = children(dc, "type")
  for (const t of types) {
    const v = nodeText(t)?.toLowerCase()
    if (v !== undefined && v in GALLICA_DOC_TYPE) return v
  }
  for (const t of types) {
    const v = nodeText(t)
    if (v && PRESS_MARKER.test(v.toLowerCase())) return v
  }
  const french = types.find(
    (t) => (attribute(t, "xml:lang") ?? attribute(t, "lang")) === FRENCH_LANG,
  )
  return nodeText(french) ?? nodeText(types[0]) ?? undefined
}

/** Trimmed, deduplicated <dc:subject> values in document order. */
function pickSubjects(dc: XmlNode): string[] {
  return [...new Set(texts(dc, "subject"))]
}

/** Parse the XML, turning every failure into a transient BnfMcpError. */
function parseEnvelope(xml: string, ark: string): Record<string, unknown> {
  const validation = XMLValidator.validate(xml)
  if (validation !== true) {
    throw new BnfMcpError(
      `Gallica OAI response for ${ark} is not well-formed XML: ${validation.err.msg}`,
      validation.err,
    )
  }
  let parsed: unknown
  try {
    parsed = bnfXmlParser.parse(xml)
  } catch (e) {
    throw new BnfMcpError(
      `Gallica OAI response for ${ark} could not be parsed: ${e instanceof Error ? e.message : String(e)}`,
      e,
    )
  }
  const root = asObject(asObject(parsed)?.[OAI_ROOT])
  if (root === undefined) {
    // Well-formed XML without an <OAI-PMH> root: a proxy / captcha / error
    // page. Never a document, and not the ARK's fault, so it stays retryable.
    throw new BnfMcpError(
      `Gallica OAI response for ${ark} has no <${OAI_ROOT}> root (proxy or error page?)`,
    )
  }
  return root
}

/**
 * Parse one Gallica OAI-PMH GetRecord (oai_dc) response into the shape
 * normalize.ts consumes.
 *
 * Output contract (SDS-945 hybrid resolver):
 *   - `gallica_typedoc`   from the header setSpec.
 *   - `oai_total_views`   the raw view count. `pages` is deliberately NOT set:
 *                         the page decision belongs to normalize.
 *   - `ocr_available`     `true` when OAI says "mode texte"; otherwise the key
 *                         is left UNSET, because OAI silence is not evidence of
 *                         no text layer. The resolver decides.
 *   - `subject`           deduplicated; omitted when the record has none.
 *
 * Throws:
 *   - BnfMcpNotFoundError  <error code="idDoesNotExist">, a deleted header, or
 *                          a record without a title. Terminal.
 *   - BnfMcpError          any other <error>, a response that is not OAI-PMH,
 *                          malformed XML, or a record missing its header /
 *                          metadata. Transient: the caller may retry.
 */
export function parseGallicaOaiRecord(xml: string, ark: string): BnfMcpDocumentDetail {
  assertFullArk(ark)
  const root = parseEnvelope(xml, ark)

  for (const error of children(root, "error")) {
    const code = attribute(error, "code")
    const message = nodeText(error) ?? "no message"
    if (code === OAI_ERROR_ID_DOES_NOT_EXIST) {
      throw new BnfMcpNotFoundError(`Gallica OAI record not found for ${ark}: ${message}`)
    }
    throw new BnfMcpError(`Gallica OAI error ${code ?? "(no code)"} for ${ark}: ${message}`)
  }

  const record = asObject(children(asObject(root.GetRecord), "record")[0])
  const header = asObject(record?.header)
  if (record === undefined || header === undefined) {
    throw new BnfMcpError(`Gallica OAI response for ${ark} has no GetRecord/record/header`)
  }
  if (attribute(header, "status") === OAI_HEADER_STATUS_DELETED) {
    throw new BnfMcpNotFoundError(`Gallica OAI record is deleted for ${ark}`)
  }
  const dc = asObject(asObject(record.metadata)?.dc)
  if (dc === undefined) {
    throw new BnfMcpError(`Gallica OAI record for ${ark} has no metadata/oai_dc:dc`)
  }

  const title = texts(dc, "title")[0]
  if (title === undefined) {
    // A live record always carries a title; its absence means the ARK is not a
    // digitized Gallica document. Terminal.
    throw new BnfMcpNotFoundError(`Gallica OAI record has no title for ${ark}`)
  }

  const subject = pickSubjects(dc)
  const views = totalViews(dc)

  return {
    ark: localArk(ark),
    title,
    creator: texts(dc, "creator")[0],
    date: texts(dc, "date")[0],
    doc_type: pickDocType(dc),
    gallica_typedoc: pickTypedoc(header),
    language: texts(dc, "language")[0],
    publisher: texts(dc, "publisher")[0],
    ...(subject.length > 0 ? { subject } : {}),
    ...(views !== undefined ? { oai_total_views: views } : {}),
    ...(hasTextMode(dc) ? { ocr_available: true } : {}),
    gallica_url: GALLICA_ITEM_URL(ark, FIRST_FOLIO),
  }
}
