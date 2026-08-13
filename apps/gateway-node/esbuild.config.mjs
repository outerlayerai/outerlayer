/**
 * Bundle the node self-host gateway into a single runnable ESM file.
 *
 * Why bundle (rather than run the TS graph directly with tsx): the gateway pulls
 * workspace packages that are published as CommonJS using dynamic export
 * patterns (`Object.defineProperty(exports, ...)`), which Node's ESM loader can't
 * statically resolve as named imports — the same interop the Cloudflare Worker's
 * bundler handles. esbuild bundles the whole graph and resolves that interop.
 *
 * The banner shims the CJS globals (`require`, `__dirname`, `__filename`) that a
 * few bundled CJS deps reference at module top level (e.g. node-cron computes a
 * daemon path from `__dirname`; it's unused for our in-process schedule).
 *
 * PREREQUISITE: the workspace packages must be built first (they ship `dist/`,
 * consumed here as CJS) — `turbo build --filter='{./packages/*}'`.
 *
 * Usage: `node esbuild.config.mjs` (build) or `node esbuild.config.mjs --watch`.
 */
import { build, context } from "esbuild";

// `require` shim — bundled CJS deps (e.g. node-cron) call `require()` at runtime.
const requireBanner = [
  "import{createRequire as __cr}from'module';",
  "const require=__cr(import.meta.url);",
].join("");

// Top-level `__filename`/`__dirname` shims — a few bundled CJS deps read them at
// module scope.
const gatewayBanner = [
  requireBanner,
  "import{fileURLToPath as __f2p}from'url';",
  "import{dirname as __dn}from'path';",
  "const __filename=__f2p(import.meta.url);",
  "const __dirname=__dn(__filename);",
].join("");

/** @type {import('esbuild').BuildOptions} */
const gatewayOptions = {
  bundle: true,
  platform: "node",
  format: "esm",
  // Match the repo's declared engine floor (root package.json `engines.node`
  // ">=22") so the self-host bundle isn't emitted with syntax a supported Node
  // 22 runtime can't parse.
  target: "node22",
  // @repo/gateway-core's management-email adapter bundles @repo/transactional's
  // email templates straight from .tsx source (no dist, no `import React` —
  // automatic-runtime source). esbuild's own default is the classic transform
  // (`React.createElement`, expects React in scope), which throws
  // `ReferenceError: React is not defined` the first time a template renders.
  jsx: "automatic",
  outdir: "dist",
  outExtension: { ".js": ".mjs" },
  logLevel: "warning",
  // `ws` optionally requires these native speedups at runtime; they are not
  // installed and `ws` degrades gracefully without them. `esbuild` spawns its own
  // platform-native binary and can't be bundled. Mark external so esbuild doesn't
  // fail resolving them into the bundle.
  external: ["bufferutil", "utf-8-validate", "esbuild"],
  // The gateway itself — `dist/index.mjs`, standalone.
  entryPoints: { index: "src/index.ts" },
  banner: { js: gatewayBanner },
};

if (process.argv.includes("--watch")) {
  const gatewayCtx = await context(gatewayOptions);
  await gatewayCtx.watch();
  // eslint-disable-next-line no-console
  console.log("[gateway-node] esbuild watching…");
} else {
  await build(gatewayOptions);
}
