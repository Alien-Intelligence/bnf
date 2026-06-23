import type { Metadata } from "next"
import { Geist, Geist_Mono } from "next/font/google"
import { NextIntlClientProvider } from "next-intl"
import { getMessages, setRequestLocale } from "next-intl/server"
import { notFound } from "next/navigation"
import { routing } from "@/i18n/routing"
import { QueryProvider } from "@/components/providers/query"
import { ThinkingProvider } from "@/components/providers/thinking"
// chat-sdk structural styles first, so globals.css's "BnF palette bridge"
// (the `--chat-sdk-*` overrides) wins the cascade.
import "@alien/chat-sdk/react/styles.css"
import "../globals.css"

const geistSans = Geist({
  variable: "--font-geist-sans",
  subsets: ["latin"],
})

const geistMono = Geist_Mono({
  variable: "--font-geist-mono",
  subsets: ["latin"],
})

export const metadata: Metadata = {
  title: "BnF Corpus Research",
  description: "Alien Intelligence × BnF — Espace de recherche sur corpus",
}

export function generateStaticParams() {
  return routing.locales.map((locale) => ({ locale }))
}

export default async function LocaleLayout({
  children,
  params,
}: {
  children: React.ReactNode
  params: Promise<{ locale: string }>
}) {
  const { locale } = await params

  if (!routing.locales.includes(locale as "fr" | "en")) {
    notFound()
  }

  setRequestLocale(locale)

  const messages = await getMessages()

  return (
    <html
      lang={locale}
      className={`${geistSans.variable} ${geistMono.variable} dark h-full antialiased`}
    >
      <body className="min-h-full flex flex-col">
        <NextIntlClientProvider messages={messages}>
          <QueryProvider>
            <ThinkingProvider>{children}</ThinkingProvider>
          </QueryProvider>
        </NextIntlClientProvider>
      </body>
    </html>
  )
}
