import { cssVarsBlock } from "@repo/design-tokens"
import type { Metadata } from "next"
import { Geist, JetBrains_Mono } from "next/font/google"
import type React from "react"

import { IS_INDEXABLE_DEPLOY, SITE_DESCRIPTION, SITE_NAME, SITE_TITLE, SITE_URL } from "@/lib/site"

import "./globals.css"

const geist = Geist({
  subsets: ["latin"],
  weight: ["400", "500", "600", "700"],
  variable: "--font-sans",
  display: "swap",
})

const jetBrainsMono = JetBrains_Mono({
  subsets: ["latin"],
  weight: ["400", "500", "600"],
  variable: "--font-mono",
  display: "swap",
})

export const metadata: Metadata = {
  // metadataBase is what turns the file-convention OG image and every relative
  // URL below into the absolute URLs crawlers and social unfurlers require.
  metadataBase: new URL(SITE_URL),
  title: SITE_TITLE,
  description: SITE_DESCRIPTION,
  applicationName: SITE_NAME,
  alternates: { canonical: "/" },
  openGraph: {
    type: "website",
    siteName: SITE_NAME,
    url: SITE_URL,
    title: SITE_TITLE,
    description: SITE_DESCRIPTION,
  },
  twitter: {
    card: "summary_large_image",
    title: SITE_TITLE,
    description: SITE_DESCRIPTION,
  },
  // Only the deployment served as the canonical domain opts into the index.
  robots: IS_INDEXABLE_DEPLOY
    ? { index: true, follow: true }
    : { index: false, follow: false },
}

// Both color schemes come from @repo/design-tokens — the same source the
// product theme composes from — so the site and the app share one voice.
const tokenStyles = `:root {\n${cssVarsBlock("light")}\n}\n.dark {\n${cssVarsBlock("dark")}\n}`

// Applied before paint so a stored or system dark preference never flashes light.
const themeScript = `(function(){try{var t=localStorage.getItem("ol-theme");var d=t?t==="dark":matchMedia("(prefers-color-scheme: dark)").matches;document.documentElement.classList.toggle("dark",d)}catch(e){}})()`

export default function RootLayout({ children }: { children: React.ReactNode }) {
  return (
    <html lang="en" className={`${geist.variable} ${jetBrainsMono.variable}`} suppressHydrationWarning>
      <head>
        <style dangerouslySetInnerHTML={{ __html: tokenStyles }} />
        <script dangerouslySetInnerHTML={{ __html: themeScript }} />
      </head>
      <body className="font-sans antialiased">{children}</body>
    </html>
  )
}
