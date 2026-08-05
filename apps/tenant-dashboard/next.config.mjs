// Conditionally import observability wrappers.
// In local dev without credentials, skip the wrappers to reduce startup overhead.
//
// Error-reporting toggle: mirrors resolveErrorReportingConfig() in
// @repo/error-reporting-core. This file runs under plain Node before TS
// compilation, so it can't import the package — the logic below is a faithful
// hand port (parse-boolean + first-non-empty DSN) kept in sync with config.ts.
// Sentry's build-time plugin is enabled exactly when runtime reporting is.
const trimmed = (value) => (value ?? "").trim();
const firstNonEmpty = (...values) => values.map(trimmed).find((v) => v !== "");
// Mirror of parseEnvBoolean: true/1/yes/on → true; false/0/no/off/"" → false;
// unset or unrecognized → undefined (defer to DSN-presence default).
const parseEnvBoolean = (value) => {
  if (value === undefined) return undefined;
  const n = value.trim().toLowerCase();
  if (n === "") return false;
  if (["true", "1", "yes", "on"].includes(n)) return true;
  if (["false", "0", "no", "off"].includes(n)) return false;
  return undefined;
};
const errorReportingDsn = firstNonEmpty(
  process.env.ERROR_REPORTING_DSN,
  process.env.NEXT_PUBLIC_ERROR_REPORTING_DSN,
  process.env.BETTERSTACK_ERRORS_DSN,
  process.env.NEXT_PUBLIC_BETTERSTACK_ERRORS_DSN
);
const errorReportingBackendNone =
  trimmed(process.env.ERROR_REPORTING_BACKEND).toLowerCase() === "none";
const errorReportingWantEnabled =
  parseEnvBoolean(process.env.ERROR_REPORTING_ENABLED) ??
  errorReportingDsn !== undefined;
const enableSentry =
  errorReportingWantEnabled && !errorReportingBackendNone && !!errorReportingDsn;
const enableLogtail = !!process.env.NEXT_PUBLIC_BETTER_STACK_SOURCE_TOKEN;

const { withLogtail } = enableLogtail
  ? await import("@logtail/next")
  : { withLogtail: (config) => config };
const { withSentryConfig } = enableSentry
  ? await import("@sentry/nextjs")
  : { withSentryConfig: (config) => config };

// Note: Environment validation is handled by @t3-oss/env-nextjs in src/env.ts
// which runs during the build process when any app code imports it.
// No need to import here - next.config.mjs loads before TS compilation.

const baseConfig = {
  reactStrictMode: true,
  typescript: {
    // Type-checking is handled by CI (typecheck job).
    // Running it again during the Next.js build causes OOM on large monorepos.
    ignoreBuildErrors: true,
  },
  images: {
    remotePatterns: [
      {
        hostname: "**",
      },
    ],
  },
  // Transpile ESM packages that don't provide CJS builds
  // Env-overridable build dir so multiple instances can run from one checkout
  // (Next 16 locks one dev server per distDir) — the selfhost e2e projects
  // boot extra dashboards with OUTERLAYER_SELF_HOSTED set.
  ...(process.env.NEXT_DIST_DIR ? { distDir: process.env.NEXT_DIST_DIR } : {}),
  transpilePackages: [
    'marked',
    '@react-email/components',
    '@react-email/markdown',
    '@react-email/render',
  ],
  webpack: (config) => {
    config.resolve.extensionAlias = {
      ...config.resolve.extensionAlias,
      ".mjs": [".mts", ".mjs"],
    };
    return config;
  },
  turbopack: {},
  // Optimize package imports to prevent unnecessary CSS preloading
  experimental: {
    optimizePackageImports: ['notistack'],
    // Reuse the client router cache for 30s on dynamic segments: tab
    // switches inside an app re-render from cache instantly instead of
    // refetching the RSC payload (and flashing loading.tsx) on every click.
    // App tab pages are client components that fetch their data via SWR, so
    // a 30s-stale RSC shell is invisible to users.
    staleTimes: {
      dynamic: 30,
    },
  },
  async redirects() {
    return [
      {
        source: "/",
        destination: "/orgs",
        permanent: true,
      },
      // Old /evals links resolve to the current /benchmarks page.
      {
        source: "/orgs/:orgName/apps/:appName/env/:envName/evals",
        destination: "/orgs/:orgName/apps/:appName/env/:envName/benchmarks",
        permanent: true,
      },
    ];
  },
  async headers() {
    return [
      {
        source: "/:path*",
        headers: [
          { key: "X-Frame-Options", value: "DENY" },
          { key: "X-Content-Type-Options", value: "nosniff" },
          { key: "Strict-Transport-Security", value: "max-age=31536000; includeSubDomains" },
          { key: "X-XSS-Protection", value: "1; mode=block" },
        ],
      },
    ];
  },
};

// Wrap with Logtail for Better Stack log ingestion
const configWithLogtail = withLogtail(baseConfig);

// Wrap with Sentry config
export default withSentryConfig(
  configWithLogtail,
  {
    // Only print logs for uploading source maps in CI
    silent: !process.env.CI,

    // For all available options, see:
    // https://docs.sentry.io/platforms/javascript/guides/nextjs/manual-setup/

    // Upload a larger set of source maps for prettier stack traces (increases build time)
    widenClientFileUpload: true,

    // Uncomment to route browser requests to Sentry through a Next.js rewrite to circumvent ad-blockers.
    // This can increase your server load as well as your hosting bill.
    // Note: Check that the configured route will not match with your Next.js middleware, otherwise reporting of client-
    // side errors will fail.
    // tunnelRoute: "/monitoring",

    // Automatically tree-shake Sentry logger statements to reduce bundle size
    disableLogger: true,

    // Enables automatic instrumentation of Vercel Cron Monitors. (Does not yet work with App Router route handlers.)
    // See the following for more information:
    // https://docs.sentry.io/product/crons/
    // https://vercel.com/docs/cron-jobs
    automaticVercelMonitors: true,
  }
);
