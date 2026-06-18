"use client"

import { useState } from "react"
import { useForm } from "react-hook-form"
import { zodResolver } from "@hookform/resolvers/zod"
import { useRouter, useSearchParams } from "next/navigation"
import { useTranslations } from "next-intl"
import { Link } from "@/i18n/navigation"
import { apiFetch } from "@/lib/api-fetch"
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

export function SignInClient() {
  const t = useTranslations("auth.signIn")
  const tSignUp = useTranslations("auth.signUp")
  const router = useRouter()
  const searchParams = useSearchParams()
  const [serverError, setServerError] = useState<string | null>(null)

  const form = useForm<SignInInput>({
    resolver: zodResolver(signInSchema),
    defaultValues: { email: "", password: "" },
  })

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

    const next = searchParams.get("next")
    router.push(next ?? "/projects")
  }

  return (
    <div className="flex min-h-screen items-center justify-center p-4">
      <Card className="w-full max-w-sm">
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
          <Link href="/sign-up" className="font-medium text-foreground underline">
            {tSignUp("title")}
          </Link>
        </CardFooter>
      </Card>
    </div>
  )
}
