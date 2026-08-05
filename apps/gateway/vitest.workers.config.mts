import { cloudflareTest } from "@cloudflare/vitest-pool-workers";
import { defineConfig } from "vitest/config";

export default defineConfig({
  plugins: [
    cloudflareTest({
      wrangler: {
        configPath: "./wrangler.toml",
      },
      // Test-only bindings — not present in wrangler.toml so they never leak
      // to dev/staging/production. Needed for happy-path integration tests
      // that require a known secret value.
      miniflare: {
        bindings: {
          ALERT_AGENT_CALLBACK_SECRET: "test-callback-secret",
        },
      },
    }),
  ],
  test: {
    name: "workers",
    include: ["src/index.test.ts"],
    passWithNoTests: false,
    deps: {
      optimizer: {
        ssr: {
          enabled: true,
          // Pre-bundle packages with broken CJS/ESM dual publishing.
          // These packages ship CJS files containing ESM syntax, which
          // workerd can't parse. The SSR optimizer bundles them via
          // esbuild first, resolving the format issues.
          include: [
            "@supabase/postgrest-js",
            "@supabase/supabase-js",
            "@supabase/node-fetch",
            "@supabase/realtime-js",
            "@supabase/storage-js",
            "@supabase/functions-js",
            "@supabase/auth-js",
          ],
        },
      },
    },
  },
});
