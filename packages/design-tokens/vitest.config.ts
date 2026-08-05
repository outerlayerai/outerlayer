import { defineConfig } from "vitest/config";

export default defineConfig({
  test: {
    name: "design-tokens",
    globals: true,
    include: ["*.{test,spec}.ts"],
    exclude: ["**/node_modules/**"],
    testTimeout: 5000,
  },
});
