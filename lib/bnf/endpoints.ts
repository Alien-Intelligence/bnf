// lib/bnf/endpoints.ts
// URL builders for the BnF partner APIs the resolver calls. Pure: no env, no
// I/O — lib/bnf/direct.ts passes the configured base, so every builder is
// unit-tested against the BnF Swagger paths.

/**
 * The IIIF v3 manifest of a Gallica document on the Presentation API
 * (PRESENTATION_IIIF_GALLICA, Swagger 2026-09-30):
 * `<base>/presentation/v3/<fullArk>/manifest.json`. `presentationBaseUrl`
 * carries the API version (`…/presentation/iiif/gallica/1.0.0`); a trailing
 * slash is ignored. `fullArk` is the opaque `ark:/12148/…` identity.
 */
export function presentationManifestUrl(presentationBaseUrl: string, fullArk: string): string {
  return `${presentationBaseUrl.replace(/\/+$/, "")}/presentation/v3/${fullArk}/manifest.json`
}
