// Plain config object (no `vitest/config` import) so this file typechecks
// cleanly under the package's `types: []` / `typeRoots: []` tsconfig.
export default {
  test: {
    name: "locales",
    // Node (no `window`/`localStorage`) reproduces a Next.js server render —
    // the environment where the i18n hydration mismatch (React #418) originated.
    environment: "node",
    include: ["**/*.test.ts"],
    exclude: ["**/node_modules/**", "**/dist/**"],
    server: {
      deps: {
        // i18n.ts -> config-lang.ts imports MUI locale data; let vitest
        // transform those packages rather than importing them raw.
        inline: [/@mui\//],
      },
    },
  },
};
