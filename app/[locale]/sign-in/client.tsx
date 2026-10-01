"use client"

import { useState } from "react"
import { useForm } from "react-hook-form"
import { zodResolver } from "@hookform/resolvers/zod"
import { useLocale, useTranslations } from "next-intl"
import { Link, getPathname, useRouter } from "@/i18n/navigation"
import { apiFetch } from "@/lib/api-fetch"
import { authClient } from "@/lib/auth-client"
import { OAUTH_PROVIDER_ID, ROUTES } from "@/lib/constants"
import { signInSchema, type SignInInput } from "@/models/users/types"
import {
  Form,
  FormControl,
  FormField,
  FormItem,
  FormLabel,
  FormMessage,
} from "@/components/ui/form"
import { Input } from "@/components/ui/input"
import { Button } from "@/components/ui/button"
import {
  Card,
  CardContent,
  CardFooter,
  CardHeader,
  CardTitle,
} from "@/components/ui/card"
import { LayoutAuthShell } from "@/components/layouts/auth/shell"

interface SignInClientProps {
  ssoEnabled: boolean
  /**
   * Where to land after a successful sign-in. Already validated by the page
   * (lib/auth-redirect.ts safeNextPath): always an in-app, locale-less path.
   */
  nextPath: string
}

export function SignInClient({ ssoEnabled, nextPath }: SignInClientProps) {
  const t = useTranslations("auth.signIn")
  const tSignUp = useTranslations("auth.signUp")
  const locale = useLocale()
  const router = useRouter()
  const [serverError, setServerError] = useState<string | null>(null)
  const [ssoLoading, setSsoLoading] = useState(false)

  const form = useForm<SignInInput>({
    resolver: zodResolver(signInSchema),
    defaultValues: { email: "", password: "" },
  })

  async function handleSso() {
    setServerError(null)
    setSsoLoading(true)
    // Better Auth redirects the browser to Authentik; callbackURL is where it
    // lands after the round-trip. Same safe `next` as the email flow, with the
    // locale prefix applied here because this is a full-page hop, not an i18n
    // router navigation.
    const { error } = await authClient.signIn.oauth2({
      providerId: OAUTH_PROVIDER_ID,
      callbackURL: getPathname({ href: nextPath, locale }),
    })
    if (error) {
      setServerError(t("errorGeneric"))
      setSsoLoading(false)
    }
  }

  async function handleSubmit(values: SignInInput) {
    setServerError(null)
    const response = await apiFetch("/api/auth/sign-in/email", {
      method: "POST",
      body: JSON.stringify({ email: values.email, password: values.password }),
    })

    if (!response.ok) {
      const body = await response.json().catch(() => ({}))
      const code: string | undefined =
        (body as { code?: string }).code ??
        (body as { error?: string }).error

      const INVALID_CREDENTIAL_CODES = new Set([
        "INVALID_EMAIL_OR_PASSWORD",
        "INVALID_PASSWORD",
        "USER_NOT_FOUND",
      ])
      const message =
        code !== undefined && INVALID_CREDENTIAL_CODES.has(code)
          ? t("errorInvalidCredentials")
          : t("errorGeneric")

      setServerError(message)
      return
    }

    // `replace`, not `push`: Back should not return to a form the user has
    // already got past.
    router.replace(nextPath)
  }

  return (
    <LayoutAuthShell>
      <Card className="w-full">
        <CardHeader>
          <CardTitle>{t("title")}</CardTitle>
        </CardHeader>
        <CardContent>
          {serverError !== null && (
            <div
              role="alert"
              className="mb-4 rounded-md border border-destructive/30 bg-destructive/10 px-4 py-3 text-sm text-destructive"
            >
              {serverError}
            </div>
          )}
          {ssoEnabled && (
            <div className="mb-4 flex flex-col gap-4">
              <Button
                type="button"
                variant="outline"
                className="w-full"
                onClick={handleSso}
                disabled={ssoLoading}
              >
                {ssoLoading ? t("submitting") : t("ssoButton")}
              </Button>
              <div className="flex items-center gap-3 text-xs text-muted-foreground">
                <span className="h-px flex-1 bg-border" />
                <span>{t("or")}</span>
                <span className="h-px flex-1 bg-border" />
              </div>
            </div>
          )}
          <Form {...form}>
            <form
              onSubmit={form.handleSubmit(handleSubmit)}
              className="flex flex-col gap-4"
            >
              <FormField
                control={form.control}
                name="email"
                render={({ field }) => (
                  <FormItem>
                    <FormLabel>{t("emailLabel")}</FormLabel>
                    <FormControl>
                      <Input type="email" autoComplete="email" {...field} />
                    </FormControl>
                    <FormMessage />
                  </FormItem>
                )}
              />
              <FormField
                control={form.control}
                name="password"
                render={({ field }) => (
                  <FormItem>
                    <FormLabel>{t("passwordLabel")}</FormLabel>
                    <FormControl>
                      <Input
                        type="password"
                        autoComplete="current-password"
                        {...field}
                      />
                    </FormControl>
                    <FormMessage />
                  </FormItem>
                )}
              />
              <div className="flex justify-end">
                <Link
                  href="/forgot-password"
                  className="text-xs text-muted-foreground hover:text-foreground"
                >
                  {t("forgotPassword")}
                </Link>
              </div>
              <Button
                type="submit"
                className="w-full"
                disabled={form.formState.isSubmitting}
              >
                {form.formState.isSubmitting ? t("submitting") : t("submit")}
              </Button>
            </form>
          </Form>
        </CardContent>
        <CardFooter className="flex justify-center gap-1 text-sm text-muted-foreground">
          <span>{t("noAccount")}</span>
          <Link href={ROUTES.signUp} className="font-medium text-foreground underline">
            {tSignUp("title")}
          </Link>
        </CardFooter>
      </Card>
    </LayoutAuthShell>
  )
}
