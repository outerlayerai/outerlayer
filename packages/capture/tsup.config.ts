import { defineConfig } from "tsup";

export default defineConfig({
  entry: ["src/index.ts"],
  format: ["cjs", "esm"],
  dts: true,
  splitting: false,
  // No sourcemap in the published bundle: tsup inlines `sourcesContent`, which
  // would ship the full source of every bundled dependency, including private
  // workspace packages. A map without that content cannot resolve
  // `../src/*.ts` on a consumer's disk anyway.
  sourcemap: false,
  clean: true,
  target: "es2019",
  treeshake: true,
  // Vendor the price table INTO the dist: @repo/model-registry is a
  // monorepo-internal package (TS-source exports, never published) — leaving
  // it external makes the published capture unresolvable on install and the
  // built CLI unrunnable outside the workspace.
  noExternal: ["@repo/model-registry"],
  outExtension({ format }) {
    return { js: format === "cjs" ? ".cjs" : ".js" };
  },
  esbuildOptions(options) {
    options.mainFields = ["module", "main"];
    options.platform = "node";
  },
});
