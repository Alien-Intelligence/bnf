import { getTranslations } from "next-intl/server"
import { SignOutButton } from "./sign-out-button"

interface WorkspaceHeaderProps {
  user: { name?: string; email: string }
}

export async function WorkspaceHeader({ user }: WorkspaceHeaderProps) {
  const tCommon = await getTranslations("common")

  const displayName = user.name ?? user.email

  return (
    <header className="flex items-center justify-between border-b px-6 py-3">
      <span className="text-sm font-semibold tracking-tight">
        Alien × BnF
      </span>
      <span className="text-sm text-muted-foreground">
        {tCommon("welcome", { name: displayName })}
      </span>
      <SignOutButton />
    </header>
  )
}
