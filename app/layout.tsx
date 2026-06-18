// Root layout — intentionally minimal.
// Language, fonts, providers, and metadata are all handled by
// app/[locale]/layout.tsx which Next.js nests inside this one.
// Do not add <html lang> here — that belongs to the locale layout.
export default function RootLayout({
  children,
}: Readonly<{
  children: React.ReactNode
}>) {
  return children
}
