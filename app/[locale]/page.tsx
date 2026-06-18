import { redirect } from "@/i18n/navigation"

export default function RootPage() {
  redirect({ href: "/sign-in", locale: "fr" })
}
