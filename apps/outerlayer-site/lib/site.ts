/**
 * Canonical production origin. Pinned rather than derived from Vercel's
 * per-deployment URL so canonical tags, sitemap entries and OG URLs point at
 * the real site from every environment — a preview build that canonicalises
 * itself would compete with production in the index.
 */
export const SITE_URL = "https://outerlayer.ai"

export const SITE_NAME = "Outerlayer"

// The locked category claim — the same line the hero and the README carry.
export const SITE_TITLE = "Outerlayer · The open-source platform for coding-agent fleets"

export const SITE_DESCRIPTION =
  "Trace every coding-agent session, mine the corrections, version the context, benchmark the gain. The evidence loop that lets you hand your fleet more of the work. Open source and local-first: one command, no account, nothing uploaded."

/**
 * Every custom domain attached to the production project. The retired-brand
 * domains are here because they are connected purely to be 308-redirected
 * (see next.config.mjs) — but Vercel sets VERCEL_PROJECT_PRODUCTION_URL to the
 * SHORTEST production custom domain, so any of these can be the value the
 * indexability check sees. Matching only the canonical host would deindex the
 * site the moment a shorter redirect-only domain is attached.
 */
const PRODUCTION_HOSTS = new Set([
  new URL(SITE_URL).host,
  `www.${new URL(SITE_URL).host}`,
  "agentmark.co",
  "www.agentmark.co",
])

/**
 * Whether this build is allowed into search indexes.
 *
 * Gated on the deployment actually being served behind a real custom domain,
 * not merely on VERCEL_ENV: a production build still reachable at its
 * *.vercel.app URL would otherwise invite crawlers to a host whose every page
 * canonicalises somewhere else. Until a custom domain is attached, production,
 * preview and local builds all stay out.
 *
 * VERCEL_PROJECT_PRODUCTION_URL is the project's production domain, preferring
 * a custom domain over the *.vercel.app fallback.
 */
export const IS_INDEXABLE_DEPLOY =
  process.env.VERCEL_ENV === "production" &&
  PRODUCTION_HOSTS.has(process.env.VERCEL_PROJECT_PRODUCTION_URL ?? "")
