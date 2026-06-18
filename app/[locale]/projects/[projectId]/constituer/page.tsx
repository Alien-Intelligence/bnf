// app/[locale]/projects/[projectId]/constituer/page.tsx
// Server component. Authenticates, resolves the project, fetches the head
// corpus snapshot, and hands everything to ConstituerClient as initial* props.
// No interactivity — see client.tsx.

import { notFound } from "next/navigation"
import { requireSessionUser } from "@/lib/auth-helpers"
import { ProjectQueries } from "@/models/projects/queries"
import { CorpusQueries } from "@/models/corpus/queries"
import { ConstituerClient } from "./client"

type RouteParams = { locale: string; projectId: string }

export default async function ConstituerPage({
  params,
}: {
  params: Promise<RouteParams>
}) {
  const { projectId } = await params

  const user = await requireSessionUser(`/projects/${projectId}/constituer`)

  const project = await ProjectQueries.get(projectId)
  if (!project || project.ownerId !== user.id) notFound()

  const initialCorpus = await CorpusQueries.snapshot(projectId, "head")

  return (
    <ConstituerClient
      projectId={projectId}
      initialCorpus={initialCorpus}
      initialUser={{ name: user.name, email: user.email }}
    />
  )
}
