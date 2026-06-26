/**
 * Live Describer — vision lane, wrapping V1's proven two-provider client
 * (Scaleway Holo2 + Google Gemma) verbatim.
 *
 * The V2 seam hands us the folio image as a Buffer (already fetched into S3 by
 * the fetch stage) rather than a URL. V1's `describeImage(url)` fetches the URL
 * itself via `fetchImage`. We bridge the two WITHOUT touching V1: we pack the
 * Buffer into a `data:` URL and hand THAT to `describeImage`. A `data:` URL has
 * an empty hostname, so V1's `fetchImage` takes neither the broker, relay, nor
 * Gallica-rate-limit branch — it falls through to a plain `fetch(dataUrl)`,
 * which Node resolves locally (no network, no BnF quota). Every provider, retry,
 * and parse path in V1 is reused unchanged.
 *
 * `describeImage` returns a structured `ImageDescription` (parsed) plus the raw
 * text. The describe stage wants page text (markdown/plain) for embedding, so we
 * render the structured fields into a French markdown block rich in the keywords
 * the prompt was tuned to produce; if the provider returned unparseable JSON we
 * fall back to the raw text so nothing is silently lost.
 */
import {
  describeImage,
  type DocumentContext,
  type ImageDescription,
} from "./vendor/vision.js";
import type { DocMeta } from "../domain/types.js";
import type { Describer } from "../ports.js";

/** Build the data URL V1's fetchImage path produces (see finalizeImage). */
export function imageBufferToDataUrl(image: Buffer, mimeType = "image/jpeg"): string {
  return `data:${mimeType};base64,${image.toString("base64")}`;
}

/** Map the V2 DocMeta onto the catalogue context V1 hands the model as truth. */
export function metaToContext(ark: string, meta: DocMeta): DocumentContext {
  return {
    ark,
    title: meta.title ?? undefined,
    creator: meta.creator ?? undefined,
    date: meta.date ?? undefined,
    docType: meta.docType ?? undefined,
  };
}

/**
 * Render a structured image description into French markdown for the RAG index.
 * Exported for unit testing — pure, deterministic, no I/O. Mirrors the field
 * vocabulary the V1 prompt emits so the embedded text stays keyword-rich.
 */
export function renderDescription(desc: ImageDescription): string {
  const lines: string[] = [];
  if (desc.titreApparent) lines.push(`# ${desc.titreApparent}`);
  if (desc.typeVisuel) lines.push(`**Type visuel :** ${desc.typeVisuel}`);
  if (desc.sujet) lines.push(`**Sujet :** ${desc.sujet}`);
  if (desc.echelle) lines.push(`**Échelle :** ${desc.echelle}`);
  if (desc.scenesEtElements?.length) {
    lines.push("**Scènes et éléments :**");
    for (const s of desc.scenesEtElements) lines.push(`- ${s}`);
  }
  if (desc.legendes?.length) {
    lines.push("**Légendes et inscriptions :**");
    for (const l of desc.legendes) lines.push(`- ${l}`);
  }
  if (desc.motsCles?.length) {
    lines.push(`**Mots-clés :** ${desc.motsCles.join(", ")}`);
  }
  if (desc.descriptionLongue) {
    lines.push("");
    lines.push(desc.descriptionLongue);
  }
  return lines.join("\n").trim();
}

export class LiveDescriber implements Describer {
  async describe(input: {
    ark: string;
    ordre: number;
    image: Buffer;
    meta: DocMeta;
  }): Promise<string> {
    const dataUrl = imageBufferToDataUrl(input.image);
    const result = await describeImage(dataUrl, {
      context: metaToContext(input.ark, input.meta),
    });
    // Prefer the structured render (keyword-rich); fall back to raw text so a
    // provider that returned prose-not-JSON still yields a usable page.
    const text = result.parsed
      ? renderDescription(result.parsed)
      : result.raw.trim();
    return text;
  }
}
