import { Suspense } from "react"
import { SignInClient } from "./client"

export default function SignInPage() {
  return (
    <Suspense>
      <SignInClient />
    </Suspense>
  )
}
