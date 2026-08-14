/**
 * Pins the classifier's contract: wrapper-stripping produces a stable
 * command identity, classification stays conservative (unknown → `other`,
 * unproven scope → `unknown`), and bypass detection reads the RAW command
 * so an env-prefix normalization can never hide `HUSKY=0`.
 */
import { describe, expect, it } from "vitest";
import {
  classifyCommand,
  commandPairKey,
  detectTestResult,
  extractCommandText,
  hasBypassFlag,
  isTestFilePath,
  normalizeCommand,
  splitCommandSegments,
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
  // AC-083-08
  it("sees bypasses on raw commands even when normalization would hide them", () => {
    expect(hasBypassFlag("HUSKY=0 git push")).toEqual(true);
    expect(hasBypassFlag("git commit --no-verify -m x")).toEqual(true);
    expect(hasBypassFlag("git commit -m 'mention --no-verify'")).toEqual(false);
    expect(hasBypassFlag("yarn test --no-verify-fixtures")).toEqual(false);
    expect(hasBypassFlag("git push")).toEqual(false);
  });
});

describe("commandPairKey", () => {
  it("strips pipe tails and stderr redirects so reruns pair", () => {
    expect(commandPairKey("vitest run src/lib 2>&1 | tail -25")).toEqual("vitest run src/lib");
    expect(commandPairKey("vitest run src/lib 2>&1 | tail -5")).toEqual("vitest run src/lib");
    expect(commandPairKey("vitest run src/lib 2>&1")).toEqual("vitest run src/lib");
    expect(commandPairKey("ci:unit")).toEqual("ci:unit");
  });
});

describe("detectTestResult", () => {
  it("trusts output first, exit status only for unpiped commands", () => {
    expect(detectTestResult("vitest run | tail -5", "ok", " Tests  1 failed | 19 passed")).toEqual("fail");
    expect(detectTestResult("vitest run | tail -5", "ok", " Tests  20 passed (20)")).toEqual("pass");
    expect(detectTestResult("vitest run | tail -5", "ok", undefined)).toEqual(undefined);
    expect(detectTestResult("vitest run", "error", undefined)).toEqual("fail");
    expect(detectTestResult("vitest run", "ok", undefined)).toEqual("pass");
    expect(detectTestResult("vitest run", "ok", " Tests  0 failed, 20 passed")).toEqual("pass");
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

describe("extractCommandText edge discipline", () => {
  it("trims the extracted command and rejects whitespace-only ones", () => {
    expect(extractCommandText('{"command":"  vitest run  "}')).toEqual("vitest run");
    expect(extractCommandText('{"command":"   "}')).toEqual(null);
  });

  it("passes scalar-looking plain text through instead of JSON-parsing it", () => {
    expect(extractCommandText("42")).toEqual("42");
  });

  it("yields no command for a JSON-shaped payload truncated mid-envelope", () => {
    const envelope = JSON.stringify([{ role: "user", content: '{"command":"vitest run"}' }]);
    expect(extractCommandText(envelope.slice(0, 40))).toEqual(null);
    expect(extractCommandText('{"command":"vitest ru')).toEqual(null);
  });
});

describe("suite scope stays out of non-test kinds", () => {
  it("never assigns a suite scope to lint or vcs commands", () => {
    expect(classifyCommand("eslint src/lib")).toEqual({
      normalized: "eslint src/lib",
      kind: "lint",
      suiteScope: "unknown",
      bypass: false,
    });
    expect(classifyCommand("git add src/a.test.ts")).toEqual({
      normalized: "git add src/a.test.ts",
      kind: "vcs",
      suiteScope: "unknown",
      bypass: false,
    });
  });
});

describe("commandPairKey trims the split residue", () => {
  it("leaves no trailing space when the pipe is cut without a redirect", () => {
    expect(commandPairKey("vitest run | tail -5")).toEqual("vitest run");
  });
});

describe("detectTestResult refuses to guess on rejection", () => {
  it("returns undefined for a rejected run with no output", () => {
    expect(detectTestResult("vitest run", "rejected", undefined)).toEqual(undefined);
  });
});

describe("splitCommandSegments", () => {
  it("splits on every statement separator and trims each segment", () => {
    expect(splitCommandSegments("a &&  b ; c\nd")).toEqual(["a", "b", "c", "d"]);
  });

  it("drops empty segments and heredoc bodies wholesale", () => {
    expect(splitCommandSegments("a && ; b")).toEqual(["a", "b"]);
    expect(
      splitCommandSegments("python3 - <<'EOF'\nvitest run inside\nEOF\nyarn vitest run x"),
    ).toEqual(["python3 -", "yarn vitest run x"]);
  });
});
