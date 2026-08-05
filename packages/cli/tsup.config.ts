import { defineConfig } from "tsup";

export default defineConfig({
  entry: ["src/index.ts"],
  format: ["esm"],
  dts: true,
  // splitting ON so the dynamically-imported cli/capture/commander code lands
  // in separate chunks the hook fast-path never loads (<50ms budget)
  splitting: true,
  // No sourcemap in the published bundle: tsup inlines `sourcesContent`, which
  // would ship the full source of every bundled dependency, including private
  // workspace packages. A map without that content cannot resolve
  // `../src/*.ts` on a consumer's disk anyway.
  sourcemap: false,
  clean: true,
  target: "es2022",
  treeshake: true,
  // Inline the workspace packages and all pure-JS deps so the published dist
  // runs from a directory with no node_modules — a copy-anywhere install. SQLite
  // (Cursor chats + the one-time watermark migration) is read through the
  // node:sqlite BUILTIN, so there is NO native addon to keep external: the
  // bundle carries zero third-party runtime dependencies.
  // tsup auto-externalizes this package's OWN listed dependencies, so the
  // pure-JS direct deps (commander) must be named here or the published dist
  // can't resolve them. Transitive deps of the inlined workspace packages are
  // not auto-externalized, so they bundle on their own.
  noExternal: [/^@outerlayer\//, "commander"],
  // Bundling CommonJS deps (commander) into an ESM output leaves their
  // internal `require(...)` calls to esbuild's shim, which throws on any
  // dynamic require ("events", etc.). Defining a real createRequire-backed
  // `require` in the banner is esbuild's documented fix: the shim finds it and
  // delegates instead of throwing. The shebang must stay the first line so the
  // built entry is directly executable.
  banner: {
    js: [
      "#!/usr/bin/env node",
      "import { createRequire as __ol_createRequire } from 'node:module';",
      "const require = __ol_createRequire(import.meta.url);",
    ].join("\n"),
  },
  esbuildOptions(options) {
    options.platform = "node";
  },
});
