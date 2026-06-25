/**
 * Schema definition for BnF datasets.
 *
 * One dataset per BnF project; slug is `bnf-<projectId>`. The schema mirrors
 * the BnF DocMetadata shape so the cluster can validate ingested entries.
 */

export function bnfDatasetSlug(projectId: string): string {
  return `bnf-${projectId}`;
}

export function bnfDatasetSchema(projectId: string): Record<string, unknown> {
  const schemaId = `bnf_${projectId.replace(/[^a-zA-Z0-9]/g, "_")}`;
  return {
    schema_id: schemaId,
    version: "v1",
    description: `Schema for BnF project ${projectId} documents`,
    original: {
      required_files: ["doc.md"],
      optional_files: ["doc.json"],
      metadata_schema: {
        type: "object",
        properties: {
          ark: { type: "string" },
          arkSlug: { type: "string" },
          title: { type: ["string", "null"] },
          creator: { type: ["string", "null"] },
          date: { type: ["string", "null"] },
          docType: { type: ["string", "null"] },
          subtype: { type: ["string", "null"] },
          lang: { type: ["string", "null"] },
          source: { type: "string" },
          iiifManifestUrl: { type: ["string", "null"] },
          pageCount: { type: ["integer", "null"] },
          ocrAvailable: { type: "boolean" },
          pipeline: { type: "string" },
          content_hash: { type: "string" },
        },
        required: ["ark", "arkSlug", "source", "ocrAvailable"],
      },
    },
    processed: {
      content_schema: {
        type: "object",
        properties: {
          text: { type: "string" },
        },
      },
      required_files: [],
      optional_files: [],
    },
    processing: {
      intermediate_files: [],
      retention_days: 7,
    },
  };
}
