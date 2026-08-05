/**
 * The retired-brand domains (agentmark.co, www.agentmark.co) are attached to
 * this Vercel project so their traffic can be claimed here. Every legacy path
 * lands on the homepage: no legacy page has an equivalent on this site, and a
 * path-preserving redirect would turn old links (blog posts, /terms, /pricing)
 * into 404s. When an equivalent page ships (e.g. /terms), add its specific
 * mapping above the catch-all.
 */
const LEGACY_HOSTS = ["agentmark.co", "www.agentmark.co"]

/** @type {import('next').NextConfig} */
const nextConfig = {
  devIndicators: false,
  transpilePackages: ["@repo/design-tokens"],
  typescript: {
    ignoreBuildErrors: true,
  },
  async redirects() {
    return LEGACY_HOSTS.map((host) => ({
      source: "/:path*",
      has: [{ type: "host", value: host }],
      destination: "https://www.outerlayer.ai/",
      permanent: true,
    }))
  },
}

export default nextConfig
