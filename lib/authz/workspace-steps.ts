// lib/authz/workspace-steps.ts
//
// Which workspace steps a user may be offered for a project.
//
// This is an access decision wearing a UI hat, so it belongs here rather than
// in the pages: "may I see Constituer and Ingérer?" has exactly the same answer
// as "would those pages let me in?", and the two must not be able to disagree.
// Both `constituer/page.tsx` and `ingerer/page.tsx` bounce a caller who fails
// this test — a read-only member gets notFound(), a derived workspace gets
// redirected — so a header that offered the step anyway would be advertising a
// dead end.
//
// It lived inline in two pages before, copy-pasted, with the second carrying a
// comment reading "Mirrors the Rechercher page". That is the drift this module
// exists to prevent: the next state added to the access table has one place to
// be handled, not two that must be remembered together.

import { canWriteProject } from "./project-access"
import { CORPUS_SOURCE_STATE, corpusSourceState } from "./corpus-source"
import { RESEARCH_ONLY_STEPS, WORKSPACE_STEPS, type WorkspaceStep } from "@/lib/constants"
import type { PolicyUser } from "@/models/users/schema"
import type { ProjectWithShares } from "@/models/projects/schema"

/**
 * The full three-step workspace for someone who may write to a project that
 * owns its corpus; Rechercher alone for everyone else — a read-only member, and
 * the owner of a derived workspace, who has no corpus of their own to build or
 * ingest.
 */
export function workspaceStepsFor(
  user: PolicyUser,
  project: ProjectWithShares,
): readonly WorkspaceStep[] {
  const ownsItsCorpus = corpusSourceState(project) === CORPUS_SOURCE_STATE.OWN
  return canWriteProject(user, project) && ownsItsCorpus
    ? WORKSPACE_STEPS
    : RESEARCH_ONLY_STEPS
}
