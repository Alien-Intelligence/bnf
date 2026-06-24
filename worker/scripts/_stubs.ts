/**
 * SANDBOX STUBS for Tracks 1 and 3.
 *
 * Once real implementations land (src/prepare/* and src/embed|cluster/*),
 * swap the imports in scripts/04-worker.ts. The interfaces are exactly the
 * frozen ones in src/types.ts — drop-in.
 */

import { createHash } from "node:crypto";
import type {
  ClusterSink,
  DocPipeline,
  PreparedDoc,
  SkipReason,
  UpsertResult,
} from "../src/types.js";

function sha256(s: string): string {
  return createHash("sha256").update(s).digest("hex");
}

function arkSlug(ark: string): string {
  return ark.replace(/\//g, "-");
}

const SLEEP_MS = 200;
const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));

/**
 * Stub DocPipeline. Returns a deterministic PreparedDoc unless the ARK
 * contains the substring "skip-" (then it returns a SkipReason) or "fail-"
 * (then it throws — exercises the runner's failure path).
 */
export class StubDocPipeline implements DocPipeline {
  async prepare(input: {
    projectId: string;
    ark: string;
  }): Promise<PreparedDoc | SkipReason> {
    await sleep(SLEEP_MS);

    if (input.ark.includes("fail-")) {
      throw new Error(`stub: simulated prepare failure for ${input.ark}`);
    }
    if (input.ark.includes("skip-")) {
      return {
        skip: true,
        reason: "no_ocr_and_not_single_image",
        arkInfo: {
          ark: input.ark,
          title: "Stubbed untitled",
          creator: null,
          date: null,
          docType: null,
          ocrAvailable: false,
          pageCount: null,
          iiifManifestUrl: null,
          raw: {},
        },
      };
    }

    const slug = arkSlug(input.ark);
    const body = `# Stub document for ${input.ark}\n\nLorem ipsum.\n`;
    return {
      projectId: input.projectId,
      pipeline: "text_with_ocr",
      metadata: {
        ark: input.ark,
        arkSlug: slug,
        title: `Stub ${input.ark}`,
        creator: null,
        date: null,
        docType: null,
        lang: "fr",
        source: "gallica",
        iiifManifestUrl: null,
        pageCount: 1,
        ocrAvailable: true,
      },
      markdown: body,
      chunks: [
        {
          chunkIndex: 0,
          text: body,
          charStart: 0,
          charEnd: body.length,
          metadata: { ark: input.ark, arkSlug: slug, folio: 1 },
        },
      ],
      contentHash: sha256(`${input.projectId}|${input.ark}|stub-v1`),
      blobKeys: {
        docMd: `projects/${input.projectId}/docs/${slug}/doc.md`,
        docJson: `projects/${input.projectId}/docs/${slug}/doc.json`,
        chunksJsonl: `projects/${input.projectId}/docs/${slug}/chunks.jsonl`,
      },
    };
  }
}

/**
 * Stub ClusterSink. Returns a deterministic fake entryId derived from the
 * ARK so repeat runs are easy to eyeball.
 */
export class StubClusterSink implements ClusterSink {
  private counter = 1000;

  async ensureDataset(_input: {
    projectId: string;
    name: string;
    slug: string;
  }): Promise<{ datasetId: number }> {
    void _input;
    return { datasetId: 1 };
  }

  async removeEntry(_input: {
    datasetId: number;
    arkSlug: string;
  }): Promise<{ removed: boolean }> {
    void _input;
    return { removed: true };
  }

  async upsert(input: {
    datasetId: number;
    prepared: PreparedDoc;
  }): Promise<UpsertResult> {
    await sleep(SLEEP_MS);
    const entryId = this.counter++;
    return {
      entryId,
      chunksWritten: input.prepared.chunks.length,
      timings: {
        embed: SLEEP_MS / 4,
        createEntry: SLEEP_MS / 4,
        uploadFile: SLEEP_MS / 4,
        saveProcessed: SLEEP_MS / 4,
        indexChunks: SLEEP_MS / 4,
        total: SLEEP_MS,
      },
    };
  }
}
