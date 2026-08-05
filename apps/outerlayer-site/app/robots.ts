import type { MetadataRoute } from "next"

import { IS_INDEXABLE_DEPLOY, SITE_URL } from "@/lib/site"

/**
 * Generates /robots.txt. The canonical deployment explicitly welcomes the major
 * AI answer-engine crawlers alongside traditional search bots — being crawlable
 * is a precondition for being cited. Every other deployment refuses all
 * crawlers so no *.vercel.app URL competes with the real site in the index.
 */
export default function robots(): MetadataRoute.Robots {
  if (!IS_INDEXABLE_DEPLOY) {
    return { rules: [{ userAgent: "*", disallow: "/" }] }
  }

  return {
    rules: [
      {
        userAgent: [
          "*",
          "GPTBot",
          "OAI-SearchBot",
          "ChatGPT-User",
          "ClaudeBot",
          "Claude-Web",
          "Claude-User",
          "Claude-SearchBot",
          "anthropic-ai",
          "PerplexityBot",
          "Perplexity-User",
          "Google-Extended",
          "Applebot-Extended",
          "CCBot",
        ],
        allow: "/",
      },
    ],
    sitemap: `${SITE_URL}/sitemap.xml`,
    host: SITE_URL,
  }
}
