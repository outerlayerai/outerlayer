/**
 * Pins the custom-validator evaluator: scope by paths (no match → no row),
 * doctrine inheritance (missing facts → no row, never a false verdict),
 * honest flag copy ("— not proven"), unknowns suppressing rather than
 * failing, and the amber cap by construction.
 */
import { describe, expect, it } from "vitest";
import { customValidationFacts, globToRegExp } from "../custom";
import type { CustomValidator } from "../policy";
import type { TimelineSpan } from "../types";

const TRACES = ["trace-a"] as const;

function run(command: string, turnIndex: number, status: "ok" | "error" = "ok"): TimelineSpan {
  return {
    sessionIndex: 0,
    turnIndex,
    toolName: "Bash",
    status,
    isEdit: false,
    command: JSON.stringify({ command }),
  };
}

function custom(over: Partial<CustomValidator> = {}): CustomValidator {
  return {
    id: "migration-must-run",
    kind: "validation",
    row: "The migration was actually run",
    level: "warn",
    whenPaths: ["supabase/migrations/**"],
    require: {
      mode: "any",
      conditions: [{ kind: "session-ran", command: "supabase migration up" }],
    },
    needs: ["commands"],
    ...over,
  };
}

const MIGRATION_FILES = ["supabase/migrations/20260815_add_flag.sql"];

describe("customValidationFacts", () => {
  // AC-085-03
  it("passes with the matched run as its proof when the required command ran", () => {
    const spans = [run("git status", 3), run("cd repo && npx supabase migration up", 7)];
    expect(customValidationFacts([custom()], spans, TRACES, MIGRATION_FILES, null)).toEqual([
      {
        id: "custom",
        validatorId: "migration-must-run",
        status: "pass",
        class: "amber",
        sentence: "The migration was actually run",
        refs: [{ traceId: "trace-a", turnIndex: 7 }],
      },
    ]);
  });

  it("matches the required command through wrappers and prefixes", () => {
    const spans = [run("cd repo && npx supabase migration up --local", 7)];
    expect(customValidationFacts([custom()], spans, TRACES, MIGRATION_FILES, null)).toEqual([
      {
        id: "custom",
        validatorId: "migration-must-run",
        status: "pass",
        class: "amber",
        sentence: "The migration was actually run",
        refs: [{ traceId: "trace-a", turnIndex: 7 }],
      },
    ]);
  });

  // AC-085-04
  it("flags '— not proven' when the scope matched and no proof exists", () => {
    const spans = [run("yarn ci:unit", 4)];
    expect(customValidationFacts([custom()], spans, TRACES, MIGRATION_FILES, null)).toEqual([
      {
        id: "custom",
        validatorId: "migration-must-run",
        status: "flag",
        class: "amber",
        sentence: "The migration was actually run — not proven",
        refs: [],
      },
    ]);
  });

  // AC-085-05
  it("renders no row when when.paths does not match the diff — or cannot be known", () => {
    const spans = [run("yarn ci:unit", 4)];
    expect(customValidationFacts([custom()], spans, TRACES, ["src/app/page.tsx"], null)).toEqual([]);
    expect(customValidationFacts([custom()], spans, TRACES, null, null)).toEqual([]);
  });

  // AC-085-06
  it("renders no row when the needed fact families were not captured", () => {
    const noContent: TimelineSpan[] = [
      { sessionIndex: 0, turnIndex: 1, toolName: "Bash", status: "ok", isEdit: false },
    ];
    expect(customValidationFacts([custom()], noContent, TRACES, MIGRATION_FILES, null)).toEqual([]);
  });

  // AC-085-10
  it("suppresses the row when the only unmet condition could not have arrived", () => {
    const withEmitted = custom({
      require: {
        mode: "any",
        conditions: [
          { kind: "session-ran", command: "supabase migration up" },
          { kind: "emitted", name: "migration.executed" },
        ],
      },
    });
    const spans = [run("yarn ci:unit", 4)];
    // The command did not run and the emitted result has no channel yet:
    // unknown suppresses, it never flags.
    expect(customValidationFacts([withEmitted], spans, TRACES, MIGRATION_FILES, null)).toEqual([]);
    // A satisfied sibling still passes regardless of the unknown.
    const ranSpans = [run("supabase migration up", 9)];
    expect(
      customValidationFacts([withEmitted], ranSpans, TRACES, MIGRATION_FILES, null),
    ).toEqual([
      {
        id: "custom",
        validatorId: "migration-must-run",
        status: "pass",
        class: "amber",
        sentence: "The migration was actually run",
        refs: [{ traceId: "trace-a", turnIndex: 9 }],
      },
    ]);
  });

  it("evaluates require.all: one definitive miss flags even beside an unknown", () => {
    const all = custom({
      require: {
        mode: "all",
        conditions: [
          { kind: "session-ran", command: "supabase migration up" },
          { kind: "emitted", name: "migration.executed" },
        ],
      },
    });
    const spans = [run("yarn ci:unit", 4)];
    expect(customValidationFacts([all], spans, TRACES, MIGRATION_FILES, null)).toEqual([
      {
        id: "custom",
        validatorId: "migration-must-run",
        status: "flag",
        class: "amber",
        sentence: "The migration was actually run — not proven",
        refs: [],
      },
    ]);
    // All conditions met except an unknown → suppressed, not passed.
    const ranSpans = [run("supabase migration up", 9)];
    expect(customValidationFacts([all], ranSpans, TRACES, MIGRATION_FILES, null)).toEqual([]);
  });

  it("resolves require.validator against the built-ins' real results", () => {
    const needsRepro = custom({
      id: "bugs-need-repro",
      row: "The bug was reproduced before the fix",
      whenPaths: null,
      require: { mode: "any", conditions: [{ kind: "validator", id: "red-then-green" }] },
      needs: ["commands", "edits"],
    });
    const redGreen = [
      run("vitest run", 61, "error"),
      { sessionIndex: 0, turnIndex: 62, toolName: "Edit", status: "ok" as const, isEdit: true, file: "src/a.ts" },
      run("vitest run", 63),
    ];
    expect(customValidationFacts([needsRepro], redGreen, TRACES, null, true)).toEqual([
      {
        id: "custom",
        validatorId: "bugs-need-repro",
        status: "pass",
        class: "amber",
        sentence: "The bug was reproduced before the fix",
        refs: [
          { traceId: "trace-a", turnIndex: 61 },
          { traceId: "trace-a", turnIndex: 63 },
        ],
      },
    ]);
    // The same requirement over a session that never showed the failure is
    // an ask without its proof — unmet, flagged.
    const bornGreen = [run("vitest run", 5)];
    expect(customValidationFacts([needsRepro], bornGreen, TRACES, null, true)).toEqual([
      {
        id: "custom",
        validatorId: "bugs-need-repro",
        status: "flag",
        class: "amber",
        sentence: "The bug was reproduced before the fix — not proven",
        refs: [],
      },
    ]);
  });

  // AC-085-08
  it("never renders a signal as a validation row", () => {
    const signal = custom({ id: "vibes", kind: "signal", whenPaths: null });
    const spans = [run("supabase migration up", 9)];
    expect(customValidationFacts([signal], spans, TRACES, MIGRATION_FILES, null)).toEqual([]);
  });

  // AC-085-11
  it("is deterministic: identical inputs yield deeply equal facts", () => {
    const spans = [run("supabase migration up", 9)];
    const first = customValidationFacts([custom()], spans, TRACES, MIGRATION_FILES, null);
    const second = customValidationFacts([custom()], spans, TRACES, MIGRATION_FILES, null);
    expect(second).toEqual(first);
  });
});

describe("globToRegExp", () => {
  it("matches within segments with * and across segments with **", () => {
    expect(globToRegExp("supabase/migrations/**").test("supabase/migrations/2026/a.sql")).toEqual(true);
    expect(globToRegExp("supabase/migrations/**").test("supabase/schemas/a.sql")).toEqual(false);
    expect(globToRegExp("**/*.test.ts").test("a/b/c.test.ts")).toEqual(true);
    expect(globToRegExp("**/*.test.ts").test("c.test.ts")).toEqual(true);
    expect(globToRegExp("src/*.ts").test("src/a.ts")).toEqual(true);
    expect(globToRegExp("src/*.ts").test("src/deep/a.ts")).toEqual(false);
    expect(globToRegExp("a.b").test("axb")).toEqual(false);
  });
});
