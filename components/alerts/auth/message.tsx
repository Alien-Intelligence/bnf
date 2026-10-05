// components/alerts/auth/message.tsx
// AlertAuthMessage — the one-line notices on the auth pages: « Vous êtes
// déconnecté. » (info, announced politely) and failures such as a refused
// sign-in or an Alien session that could not be closed (error, announced at
// once). Built on the shadcn Alert so the auth pages carry no hand-styled
// bordered boxes.

import { CircleAlert, Info } from "lucide-react"
import { Alert, AlertDescription } from "@/components/ui/alert"

export const AUTH_MESSAGE_TONE = { INFO: "info", ERROR: "error" } as const
export type AuthMessageTone = (typeof AUTH_MESSAGE_TONE)[keyof typeof AUTH_MESSAGE_TONE]

interface AlertAuthMessageProps {
  tone: AuthMessageTone
  message: string
}

export function AlertAuthMessage({ tone, message }: AlertAuthMessageProps) {
  if (tone === AUTH_MESSAGE_TONE.INFO) {
    return (
      <Alert role="status" className="mb-4">
        <Info aria-hidden />
        <AlertDescription>{message}</AlertDescription>
      </Alert>
    )
  }
  return (
    <Alert variant="destructive" className="mb-4">
      <CircleAlert aria-hidden />
      <AlertDescription>{message}</AlertDescription>
    </Alert>
  )
}
