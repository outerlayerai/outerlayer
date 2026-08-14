/**
 * Pins the classifier's contract: wrapper-stripping produces a stable
 * command identity, classification stays conservative (unknown → `other`,
 * unproven scope → `unknown`), and bypass detection reads the RAW command
 * so an env-prefix normalization can never hide `HUSKY=0`.
 */
import { describe, expect, it } from "vitest";
import {
  classifyCommand,
  extractCommandText,
  hasBypassFlag,
  isTestFilePath,
  normalizeCommand,
} from "../classify";

describe("extractCommandText", () => {
  it("unwraps Claude Code's JSON Bash input to the command string", () => {
    expect(extractCommandText('{"command":"yarn ci:unit","description":"run tests"}')).toEqual(
      "yarn ci:unit",
    );
  });

  it("passes plain strings through and rejects empty/incompatible payloads", () => {
    expect(extractCommandText("vitest run")).toEqual("vitest run");
    expect(extractCommandText("   ")).toEqual(null);
    expect(extractCommandText('{"file_path":"/tmp/x"}')).toEqual(null);
    expect(extractCommandText('["not","a","command"]')).toEqual(null);
  });
});

describe("normalizeCommand", () => {
  it("strips cd prefixes, env assignments, and runner wrappers", () => {
    expect(normalizeCommand("cd apps/tenant-dashboard && npx vitest run")).toEqual("vitest run");
    expect(normalizeCommand("cd a && cd b && yarn run test")).toEqual("test");
    expect(normalizeCommand("CI=1 NODE_ENV=test pnpm test")).toEqual("test");
    expect(normalizeCommand("  yarn   ci:unit  ")).toEqual("ci:unit");
  });
});

describe("classifyCommand", () => {
  it("classifies this repo's canonical commands with exact scope", () => {
    expect(classifyCommand("yarn ci:unit")).toEqual({
      normalized: "ci:unit",
      kind: "test",
      suiteScope: "full",
      bypass: false,
    });
    expect(classifyCommand("cd apps/x && npx vitest run src/foo.test.ts")).toEqual({
      normalized: "vitest run src/foo.test.ts",
      kind: "test",
      suiteScope: "partial",
      bypass: false,
    });
    expect(classifyCommand("npx supabase migration up")).toEqual({
      normalized: "supabase migration up",
      kind: "migration",
      suiteScope: "unknown",
      bypass: false,
    });
    expect(classifyCommand("git commit -m x --no-verify")).toEqual({
      normalized: "git commit -m x --no-verify",
      kind: "vcs",
      suiteScope: "unknown",
      bypass: true,
    });
    expect(classifyCommand("echo hello")).toEqual({
      normalized: "echo hello",
      kind: "other",
      suiteScope: "unknown",
      bypass: false,
    });
  });

  it("never grants full scope to filtered or pathed test runs", () => {
    expect(classifyCommand("vitest run").suiteScope).toEqual("full");
    expect(classifyCommand("vitest run -t 'renders'").suiteScope).toEqual("partial");
    expect(classifyCommand("yarn test:mutate").suiteScope).toEqual("unknown");
  });
});

describe("hasBypassFlag", () => {
  it("sees bypasses on raw commands even when normalization would hide them", () => {
    expect(hasBypassFlag("HUSKY=0 git push")).toEqual(true);
    expect(hasBypassFlag("git commit --no-verify -m x")).toEqual(true);
    expect(hasBypassFlag("git commit -m 'mention --no-verify'")).toEqual(false);
    expect(hasBypassFlag("yarn test --no-verify-fixtures")).toEqual(false);
    expect(hasBypassFlag("git push")).toEqual(false);
  });
});

describe("isTestFilePath", () => {
  it("matches the repo's test-file conventions and nothing else", () => {
    expect(isTestFilePath("src/lib/system/verdict/__tests__/classify.test.ts")).toEqual(true);
    expect(isTestFilePath("packages/cli/src/sync-cmd.test.ts")).toEqual(true);
    expect(isTestFilePath("apps/e2e/tests/signup.spec.ts")).toEqual(true);
    expect(isTestFilePath("src/lib/system/verdict/classify.ts")).toEqual(false);
  });
});
