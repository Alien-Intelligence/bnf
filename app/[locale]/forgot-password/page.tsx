import { getTranslations } from "next-intl/server"
import type { Metadata } from "next"
import { Link } from "@/i18n/navigation"
import {
  Card,
  CardContent,
  CardFooter,
  CardHeader,
  CardTitle,
} from "@/components/ui/card"
import { LayoutAuthShell } from "@/components/layouts/auth/shell"

export async function generateMetadata(): Promise<Metadata> {
  const t = await getTranslations("auth.forgotPassword")
  return { title: t("title") }
}

export default async function ForgotPasswordPage() {
  const t = await getTranslations("auth.forgotPassword")
  const tSignIn = await getTranslations("auth.signIn")

  return (
    <LayoutAuthShell>
      <Card className="w-full">
        <CardHeader>
          <CardTitle>{t("title")}</CardTitle>
        </CardHeader>
        <CardContent>
          <p className="text-sm text-muted-foreground">{t("body")}</p>
        </CardContent>
        <CardFooter className="flex justify-center">
          <Link href="/sign-in" className="text-sm font-medium text-foreground underline">
            {tSignIn("title")}
          </Link>
        </CardFooter>
      </Card>
    </LayoutAuthShell>
  )
}
