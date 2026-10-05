// lib/documents/ark-kind.ts
// The record-kind LOGIC: the classifier (classifyArkKind) and its SQL mirror
// over Document (arkKindWhere), side by side so they cannot drift. The
// vocabulary itself (ARK_KIND and the prefix/type lists both read) is a domain
// constant of models/documents/schema.ts.
//
// Pure — no server-only import.
//
// WHAT a BnF record is, as opposed to what its content is (docType).
//
// dc:type cannot tell a press issue from a monograph: Gallica marks both as
// plain `text`. The signals that can are structural — the identifier form and
// the type the search was run with:
//
//   - A Gallica SRU search with `collapsing: true` (the default) returns a
//     matching periodical as its COLLECTION entry, `cb…/date`. With
//     `collapsing: false` it returns the individual ISSUES, `bpt6k…`. Collapsing
//     decides which identifier comes back; it does not change what an
//     identifier is, so the kind is read from the identifier form plus the
//     type, and collapsing is recorded in provenance only
//     (BufferItem.searchCollapsing).
//   - `cb…` is a catalogue notice. Typed `press` it is a periodical title
//     (collection); otherwise a notice of whatever it describes.
//   - `bpt6k…`, `btv1b…`, `bd6t…` are digitized documents whose kind follows
//     the canonical docType.
//
// Seven values. Leo's list named five; `other_document` (digitized maps,
// manuscripts, scores, audio, video, objects) and `unknown` (a digitized ARK
// whose type is `text`, `other` or null) are added because forcing those into
// the five would be false data.
// ---------------------------------------------------------------------------

import type { Prisma } from "@/lib/generated/prisma/client"
import {
  ARK_KIND,
  ARK_KIND_IMAGE_TYPES,
  ARK_KIND_OTHER_DOCUMENT_TYPES,
  ARK_KIND_VALUES,
  CATALOGUE_ARK_PREFIX,
  DOC_TYPE_CODE,
  GALLICA_ARK_PREFIXES,
  type ArkKind,
} from "@/models/documents/schema"

const IMAGE_TYPES = new Set<string>(ARK_KIND_IMAGE_TYPES)
const OTHER_DOCUMENT_TYPES = new Set<string>(ARK_KIND_OTHER_DOCUMENT_TYPES)

/**
 * Classify a record's kind. Rules, in order:
 *   1. `collectionEntry` (the raw hit identifier ended in `/date`, read BEFORE
 *      toFullArk strips it) → periodical_collection.
 *   2. The id starts with `cb`: `press` → periodical_collection; otherwise →
 *      catalogue_notice.
 *   3. The id starts with `bpt6k`, `btv1b` or `bd6t`: press → periodical_issue;
 *      book → monograph; image-like → image; map/manuscript/score/audio/video/
 *      object/charte → other_document; text/other/null → unknown.
 *   4. Anything else → unknown.
 *
 * `ark` may be the full `ark:/12148/<id>` form or the bare id. arkKindWhere()
 * below is its SQL mirror over Document, built from the same lists; a parity
 * test (tests/models/corpus/filters.test.ts) pins the two together.
 */
export function classifyArkKind(d: {
  ark: string
  collectionEntry: boolean
  docType: string | null
}): ArkKind {
  if (d.collectionEntry) return ARK_KIND.PERIODICAL_COLLECTION
  const id = d.ark.replace(/^ark:\/\d+\//, "")
  if (id.startsWith(CATALOGUE_ARK_PREFIX)) {
    return d.docType === DOC_TYPE_CODE.PRESS ? ARK_KIND.PERIODICAL_COLLECTION : ARK_KIND.CATALOGUE_NOTICE
  }
  if (GALLICA_ARK_PREFIXES.some((p) => id.startsWith(p))) {
    if (d.docType === DOC_TYPE_CODE.PRESS) return ARK_KIND.PERIODICAL_ISSUE
    if (d.docType === DOC_TYPE_CODE.BOOK) return ARK_KIND.MONOGRAPH
    if (d.docType !== null && IMAGE_TYPES.has(d.docType)) return ARK_KIND.IMAGE
    if (d.docType !== null && OTHER_DOCUMENT_TYPES.has(d.docType)) return ARK_KIND.OTHER_DOCUMENT
    return ARK_KIND.UNKNOWN
  }
  return ARK_KIND.UNKNOWN
}


/** True for one of the seven record kinds (input validation). */
export function isArkKind(value: string): value is ArkKind {
  return (ARK_KIND_VALUES as readonly string[]).includes(value)
}

/** The "id starts with <prefix>" test over a full ARK. An ARK is
 *  `ark:/<NAAN>/<id>` with no slash inside the id (arkSchema), so `/<prefix>`
 *  can only occur at the start of the id. */
function arkIdStartsWith(prefix: string): Prisma.DocumentWhereInput {
  return { ark: { contains: `/${prefix}` } }
}

/**
 * Prisma WHERE fragment matching one record kind — the SQL mirror of
 * classifyArkKind over Document, which has no collection-entry form: `cb…` +
 * press is a periodical title, other `cb…` a catalogue notice, a digitized
 * prefix takes its kind from docType.
 *
 * Every type test is two-valued: `doc_type = 'press'` is NULL on a NULL type,
 * and `NOT(NULL)` would drop the row from both sides of a `not.kind`, where
 * classifyArkKind reads a null type as "not press" / unknown.
 */
export function arkKindWhere(kind: ArkKind): Prisma.DocumentWhereInput {
  const cb = arkIdStartsWith(CATALOGUE_ARK_PREFIX)
  const digitized: Prisma.DocumentWhereInput = { OR: GALLICA_ARK_PREFIXES.map(arkIdStartsWith) }
  const known: string[] = [DOC_TYPE_CODE.PRESS, DOC_TYPE_CODE.BOOK, ...ARK_KIND_IMAGE_TYPES, ...ARK_KIND_OTHER_DOCUMENT_TYPES]
  const typeIs = (types: readonly string[]): Prisma.DocumentWhereInput => ({ docType: { not: null, in: [...types] } })
  switch (kind) {
    case ARK_KIND.PERIODICAL_COLLECTION:
      return { AND: [cb, typeIs([DOC_TYPE_CODE.PRESS])] }
    case ARK_KIND.CATALOGUE_NOTICE:
      return { AND: [cb, { OR: [{ docType: null }, { docType: { not: DOC_TYPE_CODE.PRESS } }] }] }
    case ARK_KIND.PERIODICAL_ISSUE:
      return { AND: [digitized, typeIs([DOC_TYPE_CODE.PRESS])] }
    case ARK_KIND.MONOGRAPH:
      return { AND: [digitized, typeIs([DOC_TYPE_CODE.BOOK])] }
    case ARK_KIND.IMAGE:
      return { AND: [digitized, typeIs(ARK_KIND_IMAGE_TYPES)] }
    case ARK_KIND.OTHER_DOCUMENT:
      return { AND: [digitized, typeIs(ARK_KIND_OTHER_DOCUMENT_TYPES)] }
    case ARK_KIND.UNKNOWN:
      return {
        OR: [
          { AND: [digitized, { OR: [{ docType: null }, { docType: { notIn: known } }] }] },
          { AND: [{ NOT: cb }, { NOT: digitized }] },
        ],
      }
  }
}
