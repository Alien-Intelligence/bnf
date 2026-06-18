import "server-only"

import { prisma } from "@/lib/db"
import type { Project } from "./schema"
import type { CreateProjectInput } from "./types"

export class ProjectService {
  /**
   * Creates a project and atomically initialises its empty head CorpusVersion
   * (seq=1, status="sealed", parentId=null).
   *
   * Invariant 1 from playbook/corpus-versioning.md: "A project always has a
   * head. If a project has no corpus, head is a sealed empty version
   * (seq=1, total=0). This avoids null checks everywhere."
   *
   * The two writes are wrapped in a single $transaction so the project never
   * exists without a head version and the head pointer never points at nothing.
   */
  static async create(input: CreateProjectInput): Promise<Project> {
    return prisma.$transaction(async (tx) => {
      // 1. Create the project row (headVersionId null initially; updated below).
      const project = await tx.project.create({
        data: {
          name: input.name,
          subtitle: input.subtitle,
          ownerId: input.ownerId,
        },
      })

      // 2. Create the initial empty corpus version (seq=1, sealed, no parent).
      const headVersion = await tx.corpusVersion.create({
        data: {
          projectId: project.id,
          seq: 1,
          status: "sealed",
          parentId: null,
          createdBy: `user:${input.ownerId}`,
          note: "initial empty corpus",
        },
      })

      // 3. Point the project's headVersionId at the new version.
      //    Done as a separate update so the FK constraint is satisfied
      //    (CorpusVersion must exist before Project can reference it).
      const updated = await tx.project.update({
        where: { id: project.id },
        data: { headVersionId: headVersion.id },
      })

      return updated
    })
  }
}
