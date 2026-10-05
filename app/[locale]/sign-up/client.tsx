"use client"

import { useState } from "react"
import { useForm } from "react-hook-form"
import { zodResolver } from "@hookform/resolvers/zod"
import { AUTH_MESSAGE_TONE, AlertAuthMessage } from "@/components/alerts/auth/message"
import { useTranslations } from "next-intl"
import { Link, useRouter } from "@/i18n/navigation"
import { apiFetch } from "@/lib/api-fetch"
import { AUTH_ENDPOINT, ROUTES } from "@/lib/constants"
import { EMAIL_TAKEN_CODES, betterAuthErrorCode } from "@/lib/auth-error"
import { signUpSchema, type SignUpInput } from "@/models/users/types"
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

export function SignUpClient() {
  const t = useTranslations("auth.signUp")
  const tCommon = useTranslations("common")
  const tSignIn = useTranslations("auth.signIn")
  const router = useRouter()
  const [serverError, setServerError] = useState<string | null>(null)

  const form = useForm<SignUpInput>({
    resolver: zodResolver(signUpSchema),
    defaultValues: { name: "", email: "", password: "" },
  })

  async function handleSubmit(values: SignUpInput) {
    setServerError(null)
    let response: Response
    try {
      response = await apiFetch(AUTH_ENDPOINT.SIGN_UP_EMAIL, {
        method: "POST",
        body: JSON.stringify({
          name: values.name,
          email: values.email,
          password: values.password,
        }),
      })
    } catch (e) {
      console.error("[sign-up] request failed", e)
      setServerError(tCommon("error"))
      return
    }

    if (!response.ok) {
      const code = await betterAuthErrorCode(response)
      setServerError(
        code !== null && EMAIL_TAKEN_CODES.has(code) ? t("errorEmailTaken") : tCommon("error"),
      )
      return
    }

    // Locale-aware, and `replace` so Back does not return to the form.
    router.replace(ROUTES.projects)
  }

  return (
    <LayoutAuthShell>
      <Card className="w-full">
        <CardHeader>
          <CardTitle>{t("title")}</CardTitle>
        </CardHeader>
        <CardContent>
          {serverError !== null && (
            <AlertAuthMessage tone={AUTH_MESSAGE_TONE.ERROR} message={serverError} />
          )}
          <Form {...form}>
            <form
              onSubmit={form.handleSubmit(handleSubmit)}
              className="flex flex-col gap-4"
            >
              <FormField
                control={form.control}
                name="name"
                render={({ field }) => (
                  <FormItem>
                    <FormLabel>{t("nameLabel")}</FormLabel>
                    <FormControl>
                      <Input type="text" autoComplete="name" {...field} />
                    </FormControl>
                    <FormMessage />
                  </FormItem>
                )}
              />
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
                        autoComplete="new-password"
                        {...field}
                      />
                    </FormControl>
                    <FormMessage />
                  </FormItem>
                )}
              />
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
          <span>{t("hasAccount")}</span>
          <Link href={ROUTES.signIn} className="font-medium text-foreground underline">
            {tSignIn("title")}
          </Link>
        </CardFooter>
      </Card>
    </LayoutAuthShell>
  )
}
