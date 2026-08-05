import type { MetadataRoute } from "next"

import { SITE_URL } from "@/lib/site"

/**
 * Generates /sitemap.xml. The site is a single page today; every route added
 * here must also exist under app/ or crawlers will log 404s against us.
 *
 * lastModified uses build time (SITE_BUILD_DATE when the deploy supplies it,
 * otherwise today) — that signals freshness without claiming daily change.
 */
export default function sitemap(): MetadataRoute.Sitemap {
  const buildDate = process.env.SITE_BUILD_DATE ?? new Date().toISOString().split("T")[0]

  return [{ url: SITE_URL, lastModified: buildDate, changeFrequency: "weekly", priority: 1 }]
}
