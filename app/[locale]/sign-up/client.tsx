"use client"

import { useState } from "react"
import { useForm } from "react-hook-form"
import { zodResolver } from "@hookform/resolvers/zod"
import { useRouter } from "next/navigation"
import { useTranslations } from "next-intl"
import { Link } from "@/i18n/navigation"
import { apiFetch } from "@/lib/api-fetch"
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

export function SignUpClient() {
  const t = useTranslations("auth.signUp")
  const tCommon = useTranslations("common")
  const router = useRouter()
  const [serverError, setServerError] = useState<string | null>(null)

  const form = useForm<SignUpInput>({
    resolver: zodResolver(signUpSchema),
    defaultValues: { name: "", email: "", password: "" },
  })

  async function handleSubmit(values: SignUpInput) {
    setServerError(null)
    const response = await apiFetch("/api/auth/sign-up/email", {
      method: "POST",
      body: JSON.stringify({
        name: values.name,
        email: values.email,
        password: values.password,
      }),
    })

    if (!response.ok) {
      const body = await response.json().catch(() => ({}))
      const code: string | undefined =
        (body as { code?: string }).code ??
        (body as { error?: string }).error

      // Map known better-auth error codes to localized messages; fall back to generic.
      const EMAIL_TAKEN_CODES = new Set([
        "USER_ALREADY_EXISTS",
        "EMAIL_ALREADY_EXISTS",
      ])
      const message =
        code !== undefined && EMAIL_TAKEN_CODES.has(code)
          ? t("errorEmailTaken")
          : tCommon("error")

      setServerError(message)
      return
    }

    router.push("/projects")
  }

  return (
    <div className="flex min-h-screen items-center justify-center p-4">
      <Card className="w-full max-w-sm">
        <CardHeader>
          <CardTitle>{t("title")}</CardTitle>
        </CardHeader>
        <CardContent>
          {serverError !== null && (
            <p className="mb-4 text-sm font-medium text-destructive">
              {serverError}
            </p>
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
                {form.formState.isSubmitting ? tCommon("loading") : t("submit")}
              </Button>
            </form>
          </Form>
        </CardContent>
        <CardFooter className="flex justify-center gap-1 text-sm text-muted-foreground">
          <span>{t("hasAccount")}</span>
          <Link href="/sign-in" className="font-medium text-foreground underline">
            {tCommon("signIn")}
          </Link>
        </CardFooter>
      </Card>
    </div>
  )
}
