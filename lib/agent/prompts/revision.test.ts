// lib/agent/prompts/revision.test.ts
// The prompt-text fingerprint. AppSession caches its rendered system prompt and
// serves it only at the current PROMPT_REVISION (lib/agent/prompts/builder.ts),
// so a prompt-text change reaches existing sessions ONLY if the revision moves
// (found bug B5).
//
// Every prompt branch is rendered from fixed fixtures — corpus and research,
// fr and en, with an empty corpus, an unresolved corpus (no facet, no period),
// a project without subtitle, a corpus never ingested, a derived source granted
// and revoked, empty memories, a cross-scope memory past its cap — and
// PromptBuilder.render itself over a fixed database fixture —
// and the sha256 of each is recorded in FINGERPRINT_HISTORY under the revision
// it ships at. The history is append-only and SEALED: each revision string ends
// with the first SEAL_LENGTH hex digits of the sha256 of its own fingerprints.
// So:
//   - a prompt change fails the test until a NEW revision is recorded;
//   - pasting new fingerprints under an EXISTING revision fails too (the seal
//     no longer matches its key) — the only way to green is a new revision
//     string, i.e. the bump that makes existing sessions re-render.
import "server-only"

import { after, before, test } from "node:test"
import assert from "node:assert/strict"
import { createHash } from "node:crypto"
import { Prisma, type Project } from "@/lib/generated/prisma/client"
import { CORPUS_SOURCE_STATE } from "@/lib/authz/corpus-source"
import { MEMORY_CROSS_SCOPE_MAX_ITEMS, PROMPT_REVISION } from "@/lib/constants"
import { MEMORY_ORIGIN, MEMORY_SCOPE } from "@/models/memory/schema"
import { prisma } from "@/lib/db"
import type { User } from "@/lib/generated/prisma/client"
import { createTestSession, createTestUser, deleteTestUser } from "@/lib/testing/fixtures"
import { markHeadIngested } from "@/lib/testing/mark-ingested"
import { cleanupProject } from "@/lib/testing/project-cleanup"
import { CorpusService } from "@/models/corpus/service"
import { ProjectService } from "@/models/projects/service"
import { SESSION_SCOPE } from "@/models/sessions/schema"
import { PromptBuilder } from "./builder"
import { renderCorpusPrompt } from "./corpus"
import { renderResearchPrompt } from "./research"
import type { MemorySnapshot } from "./shared"

const SEAL_LENGTH = 12

/**
 * Revision → the fingerprints of every rendered branch at that revision, in
 * the order the revisions shipped. NEVER edit an entry: add a new one (with a
 * new date/label and the seal the failure message prints) and set
 * PROMPT_REVISION (lib/constants.ts) to it, in the same commit as the prompt
 * change.
 */
const FINGERPRINT_HISTORY: ReadonlyArray<readonly [string, Readonly<Record<string, string>>]> = [
  [
    "2026-10-02.corpus-buffer-v2.6afc4a2fa3c7",
    {
      "corpus.base.fr": "6fd680b769e68d2d0269e4faf4cca0b7101ff3aeffb60b1919dfae74c0c2a5ec",
      "corpus.empty-corpus.fr": "c3e7ec18e10658504321354037d2543b6f34d856de2e865c27a14facb71c5a68",
      "corpus.empty-memory.fr": "16bffde31bfd7efebab8dbcbe810266ea7bf5c244aab5166ce8c5a5bb23d50e7",
      "corpus.over-cap.fr": "dc643eaeb70592a9def2246804754779653de5329e0836e008f9230c4b17cc11",
      "research.base.fr": "6af47f43d2a47aa4a85f40955d6c41d2bc1af512f69963bef67c545131bfded9",
      "research.not-ingested.fr": "71b428cfdd15f0b294335a9184eaacf400df432028f34d154ff17fb1a05337a9",
      "research.derived-shared.fr": "f0f570eb233352fb5843b27063625cc4098e574f8a844cb81934c7b70d8d6c15",
      "research.derived-shared-not-ingested.fr": "7be5c47149ef72bf9576442807e284c93abf25e2bdd3d30a3841795d98254556",
      "research.derived-revoked.fr": "c4e9748416aadfd4d4df7244ac359e89e807a53d09069545c38ad7eda5262f99",
      "research.empty-memory.fr": "305f835b109d95b3056743a6ea48cff93bc238120749eac7fb0ca2c1ad1297de",
      "research.over-cap.fr": "dc688a5f04537189888b47f2dac5829b38c03053d55edd8c22544d5d93fa3197",
      "corpus.base.en": "55c7bfed8a9817559b864600787501dbe7d9c2c551fac2e8bd249f983860b1ca",
      "corpus.empty-corpus.en": "5d69dca7a98b2e19c3438e91684b1763219ac77fd9b175b3863f02b6cf19f3db",
      "corpus.empty-memory.en": "86ba5f42207d37250ae3876de4f81434e1f7e5ab26d073bb269d7362b22541ac",
      "corpus.over-cap.en": "4ed431e2a6a753d3f6d0f6e88c9112854f6b51d6a3dd216311cdba62d8c965f4",
      "research.base.en": "76e50f22014ca5a8129edec5afb323b806769f10a98839520927bbcfc8c86cbc",
      "research.not-ingested.en": "4263b8973e3e58ea657d13682b2e7c33efdf014bb92a7899b53df149ae733d9a",
      "research.derived-shared.en": "20489e4c3b1c9c03d8fa4f93c32756acc10237d83335ea9c4a592a56e6c04f8b",
      "research.derived-shared-not-ingested.en": "100952b20966a2e362ffdc48c3bbf4c9d34e7fca2559e63e8f9d5683e305b2d2",
      "research.derived-revoked.en": "80ba029c2132e580551e7270bf2d89693c45fae80879668fa56e47702d2321bc",
      "research.empty-memory.en": "8ad7f06070d6c46c8dcb78c2ef00f6c007e0005a9e0564f9259babbe72d18257",
      "research.over-cap.en": "36a417b18462867d9865a618324037ba876f36aed908f2df48ab3b0c0b3e2d86",
    },
  ],
  [
    "2026-10-05.corpus-buffer-v2-not-rule.076905ddf460",
    {
      "corpus.base.fr": "ff9bffbb2c293ef11b5be2b681e13d3ca7e9767a03e7126dc4c11969f9ba0899",
      "corpus.empty-corpus.fr": "ac70dbbe5127fd085748f059e6ebc459121d431fdb6cd82bc48a4edd63b47ee3",
      "corpus.empty-memory.fr": "21f6348e0461b5a0b617bad8fe713ae8022c108c3e9323250b713fcf8b070f8a",
      "corpus.over-cap.fr": "453960583adab1897ddd9e8617a0c5f6b06f2e8d3a0fa9b8312b97babdaa8f28",
      "research.base.fr": "6af47f43d2a47aa4a85f40955d6c41d2bc1af512f69963bef67c545131bfded9",
      "research.not-ingested.fr": "71b428cfdd15f0b294335a9184eaacf400df432028f34d154ff17fb1a05337a9",
      "research.derived-shared.fr": "f0f570eb233352fb5843b27063625cc4098e574f8a844cb81934c7b70d8d6c15",
      "research.derived-shared-not-ingested.fr": "7be5c47149ef72bf9576442807e284c93abf25e2bdd3d30a3841795d98254556",
      "research.derived-revoked.fr": "c4e9748416aadfd4d4df7244ac359e89e807a53d09069545c38ad7eda5262f99",
      "research.empty-memory.fr": "305f835b109d95b3056743a6ea48cff93bc238120749eac7fb0ca2c1ad1297de",
      "research.over-cap.fr": "dc688a5f04537189888b47f2dac5829b38c03053d55edd8c22544d5d93fa3197",
      "corpus.base.en": "862c0c943dc7c18fb296404422751635875f104f2ff68545175857b7e3a1bf12",
      "corpus.empty-corpus.en": "67261eca81ae00394bbeb0a8a53466df9f89799a202ea5e250de064e88d3395b",
      "corpus.empty-memory.en": "e54a89dbc91471630f615050e72bdc5845ff97b137458c737bc286463dfeda3d",
      "corpus.over-cap.en": "90281f50a601793276eadada4cdcf9e21de0d35fb22cb517b8a1713157c45f45",
      "research.base.en": "76e50f22014ca5a8129edec5afb323b806769f10a98839520927bbcfc8c86cbc",
      "research.not-ingested.en": "4263b8973e3e58ea657d13682b2e7c33efdf014bb92a7899b53df149ae733d9a",
      "research.derived-shared.en": "20489e4c3b1c9c03d8fa4f93c32756acc10237d83335ea9c4a592a56e6c04f8b",
      "research.derived-shared-not-ingested.en": "100952b20966a2e362ffdc48c3bbf4c9d34e7fca2559e63e8f9d5683e305b2d2",
      "research.derived-revoked.en": "80ba029c2132e580551e7270bf2d89693c45fae80879668fa56e47702d2321bc",
      "research.empty-memory.en": "8ad7f06070d6c46c8dcb78c2ef00f6c007e0005a9e0564f9259babbe72d18257",
      "research.over-cap.en": "36a417b18462867d9865a618324037ba876f36aed908f2df48ab3b0c0b3e2d86",
    },
  ],
  [
    "2026-10-05.prompt-fingerprints-all-branches.679199805182",
    {
      "corpus.base.fr": "ff9bffbb2c293ef11b5be2b681e13d3ca7e9767a03e7126dc4c11969f9ba0899",
      "corpus.empty-corpus.fr": "ac70dbbe5127fd085748f059e6ebc459121d431fdb6cd82bc48a4edd63b47ee3",
      "corpus.empty-memory.fr": "21f6348e0461b5a0b617bad8fe713ae8022c108c3e9323250b713fcf8b070f8a",
      "corpus.over-cap.fr": "453960583adab1897ddd9e8617a0c5f6b06f2e8d3a0fa9b8312b97babdaa8f28",
      "corpus.unresolved-corpus.fr": "d7c9192c67fa39bd339c84d6a5eb457290a7f06153a69aa86b7a2fd63df42cb4",
      "corpus.no-subtitle.fr": "1dbf2bdaaeed564ef5f9fc34659c32a62569b302ac76623d7aeaa32ee2c580c2",
      "research.base.fr": "6af47f43d2a47aa4a85f40955d6c41d2bc1af512f69963bef67c545131bfded9",
      "research.not-ingested.fr": "71b428cfdd15f0b294335a9184eaacf400df432028f34d154ff17fb1a05337a9",
      "research.derived-shared.fr": "f0f570eb233352fb5843b27063625cc4098e574f8a844cb81934c7b70d8d6c15",
      "research.derived-shared-not-ingested.fr": "7be5c47149ef72bf9576442807e284c93abf25e2bdd3d30a3841795d98254556",
      "research.derived-revoked.fr": "c4e9748416aadfd4d4df7244ac359e89e807a53d09069545c38ad7eda5262f99",
      "research.empty-memory.fr": "305f835b109d95b3056743a6ea48cff93bc238120749eac7fb0ca2c1ad1297de",
      "research.over-cap.fr": "dc688a5f04537189888b47f2dac5829b38c03053d55edd8c22544d5d93fa3197",
      "research.no-subtitle.fr": "fa29140ea12de13a2aae0819783de8c7c57678b9916380d83afb158e74a0cbb0",
      "corpus.base.en": "862c0c943dc7c18fb296404422751635875f104f2ff68545175857b7e3a1bf12",
      "corpus.empty-corpus.en": "67261eca81ae00394bbeb0a8a53466df9f89799a202ea5e250de064e88d3395b",
      "corpus.empty-memory.en": "e54a89dbc91471630f615050e72bdc5845ff97b137458c737bc286463dfeda3d",
      "corpus.over-cap.en": "90281f50a601793276eadada4cdcf9e21de0d35fb22cb517b8a1713157c45f45",
      "corpus.unresolved-corpus.en": "5ae8f14fadc65b1aa2c8fa6668b2605d9c6f2c2c3ee4bfeed010c5d2a0d4bdb9",
      "corpus.no-subtitle.en": "220405dc6e599a9cd3a53058c371be44f94da8777f9ca9ba5d37cddf65e3aaf8",
      "research.base.en": "76e50f22014ca5a8129edec5afb323b806769f10a98839520927bbcfc8c86cbc",
      "research.not-ingested.en": "4263b8973e3e58ea657d13682b2e7c33efdf014bb92a7899b53df149ae733d9a",
      "research.derived-shared.en": "20489e4c3b1c9c03d8fa4f93c32756acc10237d83335ea9c4a592a56e6c04f8b",
      "research.derived-shared-not-ingested.en": "100952b20966a2e362ffdc48c3bbf4c9d34e7fca2559e63e8f9d5683e305b2d2",
      "research.derived-revoked.en": "80ba029c2132e580551e7270bf2d89693c45fae80879668fa56e47702d2321bc",
      "research.empty-memory.en": "8ad7f06070d6c46c8dcb78c2ef00f6c007e0005a9e0564f9259babbe72d18257",
      "research.over-cap.en": "36a417b18462867d9865a618324037ba876f36aed908f2df48ab3b0c0b3e2d86",
      "research.no-subtitle.en": "65501ea3bdfbac5338c1566e2bed64ee69984acf7c5b0b86d2baec56178291c3",
      "builder.corpus.fr": "520c535a56b84af5c8aa1eedf0472f19df6c1d8f69208e4b5d09f89cf6d9e3a2",
      "builder.research.fr": "0ced6140bdba122b6bc07c40b3e9a7ea6c73448976c55f2fbf5d7874c026b9ac",
      "builder.corpus.en": "e1d7b8b924003860f48d43dd0fd5b71b2d4dbb20d846a3372ae378ad10acbc41",
      "builder.research.en": "3fcb9de48cb054a153e8c02f2018d531a555f71ad69b84818f8b3e3c3ca83678",
    },
  ],
  [
    "2026-10-05.ocr-quality-and-quote-integrity.a0554f9d4835",
    {
      "corpus.base.fr": "ff9bffbb2c293ef11b5be2b681e13d3ca7e9767a03e7126dc4c11969f9ba0899",
      "corpus.empty-corpus.fr": "ac70dbbe5127fd085748f059e6ebc459121d431fdb6cd82bc48a4edd63b47ee3",
      "corpus.empty-memory.fr": "21f6348e0461b5a0b617bad8fe713ae8022c108c3e9323250b713fcf8b070f8a",
      "corpus.over-cap.fr": "453960583adab1897ddd9e8617a0c5f6b06f2e8d3a0fa9b8312b97babdaa8f28",
      "corpus.unresolved-corpus.fr": "d7c9192c67fa39bd339c84d6a5eb457290a7f06153a69aa86b7a2fd63df42cb4",
      "corpus.no-subtitle.fr": "1dbf2bdaaeed564ef5f9fc34659c32a62569b302ac76623d7aeaa32ee2c580c2",
      "research.base.fr": "47458893a2379cc76e541e18f16c4f65db194013eb2a0657b1b5981aa4253305",
      "research.not-ingested.fr": "f434521fb8883aff124bbfb1a682dcc3f578053d68c9d51a52bc54bdbed73ec8",
      "research.derived-shared.fr": "e3c7a0fc60de174cac3dc0f4ecf1633eeee7fd1c5d3293418cd38128ef83d411",
      "research.derived-shared-not-ingested.fr": "e5e7c5c08b5291925993e70177c2cbaa78141b0b9adf844f0822c520373265ab",
      "research.derived-revoked.fr": "29c99382a5614377b0f458147514f36a59e706f44092050a50ffb0361b16a39e",
      "research.empty-memory.fr": "3ca5f74109a291a9f26142507ace6672670a6885d164786c6db7bf09260e5df2",
      "research.over-cap.fr": "c0e2e9756610000f63f37c5ec3616a06bd6d5c7521822c5f21dd2554059d44fa",
      "research.no-subtitle.fr": "1d1d35f1efd673dc7b5e84693d95e3da18e3a848cfb53e591a5b69f58051de07",
      "corpus.base.en": "862c0c943dc7c18fb296404422751635875f104f2ff68545175857b7e3a1bf12",
      "corpus.empty-corpus.en": "67261eca81ae00394bbeb0a8a53466df9f89799a202ea5e250de064e88d3395b",
      "corpus.empty-memory.en": "e54a89dbc91471630f615050e72bdc5845ff97b137458c737bc286463dfeda3d",
      "corpus.over-cap.en": "90281f50a601793276eadada4cdcf9e21de0d35fb22cb517b8a1713157c45f45",
      "corpus.unresolved-corpus.en": "5ae8f14fadc65b1aa2c8fa6668b2605d9c6f2c2c3ee4bfeed010c5d2a0d4bdb9",
      "corpus.no-subtitle.en": "220405dc6e599a9cd3a53058c371be44f94da8777f9ca9ba5d37cddf65e3aaf8",
      "research.base.en": "8bf36bff1efadbeb0061eef24288d0c9b4288ba712cbaf16a76be689f4278d1b",
      "research.not-ingested.en": "18503f4e925540a2d58b1be0a535b5e36e0329fca5805ff684b4edbb6a3e6c56",
      "research.derived-shared.en": "ba847294039d4163d73f5b6696940c1c57c1011ee001a354514f1dc745f2285b",
      "research.derived-shared-not-ingested.en": "b3236af4724f6a7215e4b997caec97baae6e49b13f2f63deb943850b9e4becb6",
      "research.derived-revoked.en": "57a666728a3390c44fd79460c54e285555c59564757aaa59e343cec4689ca767",
      "research.empty-memory.en": "3a3bc8c24b7130fb634d3da6e01d4fb0643669e640e7b659678684698b104410",
      "research.over-cap.en": "7e7ad148ccc468b7ea6e69fd7d466f71cb2736fed136acc04a925aa820e8ab30",
      "research.no-subtitle.en": "3affb7c3dbf2751e143e36b21bc816b1c33e0e8eb6184664bb83eb63eea975a4",
      "builder.corpus.fr": "520c535a56b84af5c8aa1eedf0472f19df6c1d8f69208e4b5d09f89cf6d9e3a2",
      "builder.research.fr": "75e23451c65533a8a37401040616d74ccb44dfbb705f52b030f6b8218e1c7d0d",
      "builder.corpus.en": "e1d7b8b924003860f48d43dd0fd5b71b2d4dbb20d846a3372ae378ad10acbc41",
      "builder.research.en": "69f8d7d714dbfc1abd168488806c9e3067813833c801f2d08c315c985b4da4c9",
    },
  ],
  [
    "2026-10-05.quoting-rules.6e9149ff8048",
    {
      "corpus.base.fr": "be46ef2d641de7017a3ae0e4a58b562481faf7baa50569fc0adce709a821f32a",
      "corpus.empty-corpus.fr": "9f74d159dc010e2236e3602c7be09c3989d7ee7ea7b65b866a2cc5f4bc6ad3c5",
      "corpus.empty-memory.fr": "e1e146c2fbce9b1ffd83353d7b148e402e6affa4621f3dc8231400670b1664f4",
      "corpus.over-cap.fr": "3e0afd9b5dfa0080b6eb630404e943ae94a4a49af81c846c51a14244a5b7a2d8",
      "corpus.unresolved-corpus.fr": "547f09c92f04396bfd8d25a3b5e726e5062f1c82b1c698ca65ec84b99ad62d61",
      "corpus.no-subtitle.fr": "ca9f269a97642c2840e4718fc37de08c1521c2ef58b6d337b5c07b1889d8da43",
      "research.base.fr": "b57c7ec92f64ac9256e6ae5997ea6ccc9e6061cb05503c91586888b954a2b054",
      "research.not-ingested.fr": "1797b6e4209f10f2c36e16ac5a193b8dbd013cbc8dff9d94e59ba417c8a502a9",
      "research.derived-shared.fr": "c03eaad7bee1f79b984f9c4682a3f0a23cbed036564a434781a5cc003be8849a",
      "research.derived-shared-not-ingested.fr": "c836d4545b278dd42749837b4f9e8a00115bc5d6c69701da634a60385ea695af",
      "research.derived-revoked.fr": "0c145b8c147debb4d3f07b740dd665909d2e3e7ae0d5461e09cb0700a27f056b",
      "research.empty-memory.fr": "b19c24b79faf07faa3647553c64fb904cb5bc961dbc179d79b98f613ea9b7135",
      "research.over-cap.fr": "01e98a5622fa8993e132e7be097186010e7d92df75d9e69820d428c922ed48ea",
      "research.no-subtitle.fr": "7d411efea4cc09b175470afb98aa00a1d0fdc6e9af3aeb5fe08f49d1c488ab2f",
      "corpus.base.en": "f7a3701c06d714ceba5d628d89fdae0afb4bd4ba8e5c88aa8a3b36ab888793a3",
      "corpus.empty-corpus.en": "8b80f4e765c3cebef69efc570cc401395792b86ec8f90cfb6421d8473275118b",
      "corpus.empty-memory.en": "cc1af58f7166557b29b1c5ce6af29e6fe9bc8e74ec831fe5c612c5be877fcee5",
      "corpus.over-cap.en": "1268d3dc52001cf870830e98f4ab5a833c1571180b2600785a89ee57fe4f2df7",
      "corpus.unresolved-corpus.en": "4789c4684078bf67ac83cb9f95dd129360d0d10c5d9c9078347e7e817bf38063",
      "corpus.no-subtitle.en": "acef0c7edd7acdda4ff3e1d9e9caad58b6e535a542c6b3c15618e1af4bf3607d",
      "research.base.en": "44213ecc519fda8ffdc192e1c3a541f1a059cb5bca7bf02c3b75f5e9d30a32e1",
      "research.not-ingested.en": "65fa0769fa22e168e90621d95d93cb0670ada4de18365c03d863672536a4d3ca",
      "research.derived-shared.en": "0887bb2d9899b6b48df80a45beda3bce9bc01acd8c3e652508158f40bea2c6ec",
      "research.derived-shared-not-ingested.en": "ff75da10cf9c76077518277ef9c515bec52d84d1efa89e7399a577dc224d7491",
      "research.derived-revoked.en": "03bd87db9ab20d95d9385982d8d6a0ecec8912dc09777327feaf96dbb848b256",
      "research.empty-memory.en": "2b4ec3ff918bdbd0f2a0f0f8f63b581dc26b02a1ba4d84a87a7e9a02879b5212",
      "research.over-cap.en": "4563a07102320636d4de9dce4c8251907a431e2e38389767b76767109dadbc60",
      "research.no-subtitle.en": "7055774c78592d9320b0c6b84c15dfb48c58277328191ee0b8a5cb7174680fba",
      "builder.corpus.fr": "f210a3b7af5b5ceec06038763f8009febeab7cf31c8e255830d99fc1acf8fd8e",
      "builder.research.fr": "5c19eb148d4e03281b245cc1e16f567910ddc2cddcbac2d274b1a86a0bcf59a4",
      "builder.corpus.en": "47235fde0db914ba615ca55709a5581df75928eb0e81430205cf40a1a45d6221",
      "builder.research.en": "88c5575f29b055735779f2b7f6e06bc5e056cd231024a672157c6f056eac8305",
    },
  ],
]
const project: Project = {
  id: "fingerprint",
  ownerId: "owner",
  name: "Projet témoin",
  subtitle: "Empreinte des prompts",
  isPublic: false,
  headVersionId: null,
  ingestedVersionId: null,
  clusterDatasetId: null,
  paidOcrEnabled: true,
  paidOcrBudgetUsd: null,
  paidOcrSpentUsd: new Prisma.Decimal(0),
  corpusSourceId: null,
  corpusSourceShareId: null,
  createdAt: new Date(0),
  updatedAt: new Date(0),
}

const memory = (text: string): MemorySnapshot => ({
  sections: [{ title: "Périmètre", items: [{ id: "m1", text, origin: MEMORY_ORIGIN.CONSIGNE }] }],
})
const EMPTY_MEMORY: MemorySnapshot = { sections: [] }
const OVER_CAP_MEMORY: MemorySnapshot = {
  sections: [
    {
      title: "Lot",
      items: Array.from({ length: MEMORY_CROSS_SCOPE_MAX_ITEMS + 3 }, (_, i) => ({
        id: `m${i}`,
        text: `Fait de recherche numéro ${i}`,
        origin: MEMORY_ORIGIN.DEDUIT,
      })),
    },
  ],
}

const CORPUS = { versionSeq: 3, total: 12, facets: { type: { press: 12 }, lang: { fr: 12 }, period: { "1930s": 12 } } }
/** Members, but none resolved yet: no facet, no period. */
const UNRESOLVED_CORPUS = { versionSeq: 1, total: 4, facets: { type: {}, lang: {}, period: {} } }
const EMPTY_CORPUS = { versionSeq: 0, total: 0, facets: { type: {}, lang: {}, period: {} } }
const INGESTED = { ingested: true, seq: 3, total: 12 } as const
const NOT_INGESTED = { ingested: false } as const
const SHARED_SOURCE = { name: "Corpus source", state: CORPUS_SOURCE_STATE.SHARED }
const REVOKED_SOURCE = { name: "Corpus source", state: CORPUS_SOURCE_STATE.REVOKED }

const sha256 = (text: string) => createHash("sha256").update(text).digest("hex")

const NO_SUBTITLE: Project = { ...project, subtitle: null }

/** Every pure-render branch, by a stable key. */
function pureFingerprints(): Record<string, string> {
  const out: Record<string, string> = {}
  for (const locale of ["fr", "en"] as const) {
    const own = memory("Presse française, 1937.")
    const researchCross = { scope: MEMORY_SCOPE.RESEARCH, snapshot: memory("Source à risque : bpt6k1.") }
    const corpusCross = { scope: MEMORY_SCOPE.CORPUS, snapshot: memory("Presse française, 1937.") }
    const corpus = (key: string, ...args: Parameters<typeof renderCorpusPrompt>) => {
      out[`corpus.${key}.${locale}`] = sha256(renderCorpusPrompt(...args))
    }
    const research = (key: string, ...args: Parameters<typeof renderResearchPrompt>) => {
      out[`research.${key}.${locale}`] = sha256(renderResearchPrompt(...args))
    }
    corpus("base", project, own, researchCross, CORPUS, locale)
    corpus("empty-corpus", project, own, researchCross, EMPTY_CORPUS, locale)
    corpus("empty-memory", project, EMPTY_MEMORY, { scope: MEMORY_SCOPE.RESEARCH, snapshot: EMPTY_MEMORY }, CORPUS, locale)
    corpus("over-cap", project, own, { scope: MEMORY_SCOPE.RESEARCH, snapshot: OVER_CAP_MEMORY }, CORPUS, locale)
    corpus("unresolved-corpus", project, own, researchCross, UNRESOLVED_CORPUS, locale)
    corpus("no-subtitle", NO_SUBTITLE, own, researchCross, CORPUS, locale)
    research("base", project, own, corpusCross, INGESTED, locale)
    research("not-ingested", project, own, corpusCross, NOT_INGESTED, locale)
    research("derived-shared", project, own, corpusCross, INGESTED, locale, SHARED_SOURCE)
    research("derived-shared-not-ingested", project, own, corpusCross, NOT_INGESTED, locale, SHARED_SOURCE)
    research("derived-revoked", project, own, corpusCross, NOT_INGESTED, locale, REVOKED_SOURCE)
    research("empty-memory", project, EMPTY_MEMORY, { scope: MEMORY_SCOPE.CORPUS, snapshot: EMPTY_MEMORY }, INGESTED, locale)
    research("over-cap", project, own, { scope: MEMORY_SCOPE.CORPUS, snapshot: OVER_CAP_MEMORY }, INGESTED, locale)
    research("no-subtitle", NO_SUBTITLE, own, corpusCross, INGESTED, locale)
  }
  return out
}

// --- PromptBuilder.render, over a fixed database fixture --------------------
// The assembly (which memory, which snapshot, which ingest status reach the
// renderers) is prompt text too: a change there alters every cached prompt.

let owner: User
const builderSessions: Record<string, string> = {}
const builderProjects: string[] = []

before(async () => {
  owner = await createTestUser()
  const fixed = await ProjectService.create({
    name: "Projet témoin (assemblage)",
    subtitle: "Empreinte de PromptBuilder",
    ownerId: owner.id,
  })
  builderProjects.push(fixed.id)
  await prisma.document.createMany({
    data: [
      { ark: "ark:/12148/bpt6k9900001", title: "Numéro", docType: "press", lang: "fr", year: 1937 },
      { ark: "ark:/12148/bpt6k9900002", title: "Livre", docType: "book", lang: "de", year: 1897 },
    ].map((d) => ({ ...d, projectId: fixed.id, source: "gallica", resolveStatus: "resolved" })),
  })
  await CorpusService.addArks(fixed, owner, { arks: ["ark:/12148/bpt6k9900001", "ark:/12148/bpt6k9900002"], reason: "témoin" })
  await markHeadIngested(fixed.id)
  await prisma.memoryItem.createMany({
    data: [
      { projectId: fixed.id, scope: MEMORY_SCOPE.CORPUS, section: "Périmètre", text: "Presse et livres.", position: 0 },
      { projectId: fixed.id, scope: MEMORY_SCOPE.RESEARCH, section: "Question", text: "La réception.", position: 0 },
    ],
  })
  builderSessions.corpus = await createTestSession(fixed.id, SESSION_SCOPE.CORPUS)
  builderSessions.research = await createTestSession(fixed.id, SESSION_SCOPE.RESEARCH)
})

after(async () => {
  for (const id of builderProjects) await cleanupProject(id)
  await deleteTestUser(owner.id)
})

/** Every branch: the pure renders plus PromptBuilder.render over the fixture. */
async function fingerprints(): Promise<Record<string, string>> {
  const out = pureFingerprints()
  for (const locale of ["fr", "en"] as const) {
    for (const [scope, id] of Object.entries(builderSessions)) {
      const session = await prisma.appSession.findUniqueOrThrow({ where: { id } })
      out[`builder.${scope}.${locale}`] = sha256(await PromptBuilder.renderForTests(session, locale))
    }
  }
  return out
}

/** The seal of a fingerprint set: order-independent, content-addressed. */
function seal(prints: Readonly<Record<string, string>>): string {
  const canonical = JSON.stringify(Object.keys(prints).sort().map((k) => [k, prints[k]]))
  return sha256(canonical).slice(0, SEAL_LENGTH)
}

test("every recorded revision is sealed by its own fingerprints (entries are never edited)", () => {
  for (const [revision, prints] of FINGERPRINT_HISTORY) {
    assert.ok(
      revision.endsWith(`.${seal(prints)}`),
      `The fingerprints recorded under ${revision} were changed after it was sealed. Restore them, ` +
        "and record the new prompt text under a NEW revision instead.",
    )
  }
  const revisions = FINGERPRINT_HISTORY.map(([r]) => r)
  assert.equal(new Set(revisions).size, revisions.length, "a revision is recorded twice")
})

test("PROMPT_REVISION is the latest recorded revision and matches the rendered prompts", async () => {
  const actual = await fingerprints()
  const latest = FINGERPRINT_HISTORY.at(-1)
  const proposal = `${new Date().toISOString().slice(0, 10)}.<label>.${seal(actual)}`
  assert.ok(
    latest !== undefined && latest[0] === PROMPT_REVISION,
    `PROMPT_REVISION (${PROMPT_REVISION}) must be the last entry of FINGERPRINT_HISTORY. ` +
      `To record the current prompts, append [${JSON.stringify(proposal)}, ${JSON.stringify(actual)}] ` +
      "and set PROMPT_REVISION to that revision.",
  )
  assert.deepEqual(
    actual,
    latest[1],
    "A prompt changed since PROMPT_REVISION was recorded. Do NOT edit that entry: append " +
      `[${JSON.stringify(proposal)}, ${JSON.stringify(actual)}] to FINGERPRINT_HISTORY and set ` +
      "PROMPT_REVISION (lib/constants.ts) to the new revision, so existing sessions re-render.",
  )
})

test("rendering is deterministic, and every branch renders a distinct prompt", async () => {
  const prints = await fingerprints()
  assert.deepEqual(prints, await fingerprints())
  const byHash = new Map<string, string>()
  for (const [key, hash] of Object.entries(prints)) {
    assert.ok(!byHash.has(hash), `${key} renders the same prompt as ${byHash.get(hash)} — a branch is not exercised`)
    byHash.set(hash, key)
  }
})
