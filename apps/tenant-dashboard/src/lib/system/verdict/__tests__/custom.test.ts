/**
 * Pins the custom-validator evaluator: `when.paths` scoping, the
 * `session.ran` matcher over classified runs, emitted-result and
 * validator-reference requirements, the needs doctrine, and the structural
 * amber cap. Facts are built through the real extraction pass so matcher
 * behavior is proven against the same normalization production uses.
 */
import { describe, expect, it } from "vitest";
import {
  evaluateCustomValidators,
  pathGlobToRegExp,
  type EmittedResultRecord,
} from "../custom";
import { extractFacts } from "../facts";
import type { CustomValidatorDef } from "../policy";
import type { RuleResult, TimelineSpan } from "../types";

function run(command: string, status: "ok" | "error" = "ok", turnIndex = 0): TimelineSpan {
  return {
    sessionIndex: 0,
    turnIndex,
    toolName: "Bash",
    status,
    isEdit: false,
    command: JSON.stringify({ command }),
  };
}

function def(over: Partial<CustomValidatorDef> = {}): CustomValidatorDef {
  return {
    id: "migration-must-run",
    row: "Migrations ran against a local database",
    level: "warn",
    whenPaths: ["supabase/migrations/**"],
    requireAny: [{ type: "session-ran", command: "supabase migration up", status: "ok" }],
    needs: ["commands"],
    declaresEmit: null,
    ...over,
  };
}

function evaluate(over: {
  defs?: CustomValidatorDef[];
  spans?: TimelineSpan[];
  changedPaths?: readonly string[] | null;
  emitted?: ReadonlyMap<string, EmittedResultRecord>;
  builtinResults?: ReadonlyMap<string, Pick<RuleResult, "status" | "refs">>;
}) {
  return evaluateCustomValidators({
    defs: over.defs ?? [def()],
    facts: extractFacts(over.spans ?? []),
    changedPaths:
      "changedPaths" in over ? (over.changedPaths ?? null) : ["supabase/migrations/20260101_add.sql"],
    emitted: over.emitted ?? new Map(),
    builtinResults: over.builtinResults ?? new Map(),
  });
}

describe("pathGlobToRegExp", () => {
  it("matches whole paths with **, *, and ? semantics", () => {
    const deep = pathGlobToRegExp("supabase/migrations/**");
    expect(deep.test("supabase/migrations/20260101_add.sql")).toBe(true);
    expect(deep.test("supabase/migrations/sub/dir.sql")).toBe(true);
    expect(deep.test("supabase/migrations")).toBe(false);
    expect(deep.test("src/supabase/migrations/x.sql")).toBe(false);

    const single = pathGlobToRegExp("src/*.ts");
    expect(single.test("src/index.ts")).toBe(true);
    expect(single.test("src/lib/index.ts")).toBe(false);

    // Regex specials in the glob are literals, not metacharacters.
    expect(pathGlobToRegExp("a.b/c").test("axb/c")).toBe(false);
  });
});

describe("evaluateCustomValidators — scoping", () => {
  // proves AC-085-07
  it("produces no row at all when when.paths matches nothing in the diff", () => {
    expect(evaluate({ changedPaths: ["src/app/page.tsx", "README.md"] })).toEqual([]);
  });

  it("suppresses a path-scoped validator when the diff was unreadable, never guessing", () => {
    expect(evaluate({ changedPaths: null })).toEqual([]);
  });

  it("applies an unscoped validator to every PR", () => {
    const results = evaluate({
      defs: [def({ whenPaths: null })],
      spans: [run("vitest run", "ok", 1)],
      changedPaths: ["docs/README.md"],
    });
    expect(results.map((r) => ({ id: r.id, status: r.status }))).toEqual([
      { id: "migration-must-run", status: "flag" },
    ]);
  });

  it("skips a validator leveled off entirely", () => {
    expect(evaluate({ defs: [def({ level: "off" })] })).toEqual([]);
  });
});

describe("evaluateCustomValidators — session.ran", () => {
  // proves AC-085-05
  it("flags with the row copy verbatim when the scope matched and no run did", () => {
    expect(evaluate({ spans: [run("vitest run", "ok", 3)] })).toEqual([
      {
        id: "migration-must-run",
        status: "flag",
        row: "Migrations ran against a local database",
        level: "warn",
        refs: [],
        source: null,
      },
    ]);
  });

  // proves AC-085-06
  it("passes with the matched run's position as its proof", () => {
    const results = evaluate({
      spans: [run("vitest run", "ok", 2), run("supabase migration up --local", "ok", 7)],
    });
    expect(results).toEqual([
      {
        id: "migration-must-run",
        status: "pass",
        row: "Migrations ran against a local database",
        level: "warn",
        refs: [{ sessionIndex: 0, turnIndex: 7 }],
        source: null,
      },
    ]);
  });

  // proves AC-085-08
  it("matches through the classifier's own normalization — wrappers and argument tails do not defeat it", () => {
    const wrapped = evaluate({
      spans: [run("cd apps/tenant-dashboard && npx supabase migration up --local", "ok", 9)],
    });
    expect(wrapped.map((r) => r.status)).toEqual(["pass"]);

    // Whole-word prefix: a longer command that merely shares the prefix
    // characters is not the same command.
    const lookalike = evaluate({
      defs: [def({ requireAny: [{ type: "session-ran", command: "playwright", status: "ok" }] })],
      spans: [run("playwright-report-server", "ok", 1)],
    });
    expect(lookalike.map((r) => r.status)).toEqual(["flag"]);
  });

  // proves AC-085-08
  it("holds the declared status against the run's status", () => {
    const failedRun = [run("supabase migration up", "error", 4)];
    expect(evaluate({ spans: failedRun }).map((r) => r.status)).toEqual(["flag"]);
    const wantsError = def({
      requireAny: [{ type: "session-ran", command: "supabase migration up", status: "error" }],
    });
    expect(evaluate({ defs: [wantsError], spans: failedRun }).map((r) => r.status)).toEqual([
      "pass",
    ]);
  });

  // proves AC-085-09
  it("renders not checkable when the needed fact family was not captured", () => {
    // A span timeline with no command content covers `edits` but not
    // `commands` — the session.ran channel is blind, and the answer says so.
    const noCommandContent: TimelineSpan[] = [
      { sessionIndex: 0, turnIndex: 1, toolName: "Bash", status: "ok", isEdit: false },
    ];
    expect(evaluate({ spans: noCommandContent })).toEqual([
      {
        id: "migration-must-run",
        status: "not_checkable",
        row: "Migrations ran against a local database",
        level: "warn",
        refs: [],
        source: null,
      },
    ]);
  });
});

describe("evaluateCustomValidators — emitted results", () => {
  const emitDef = def({
    id: "smoke-test",
    row: "Smoke test passed on the preview deploy",
    whenPaths: null,
    requireAny: [{ type: "emitted", name: "smoke.pass" }],
    needs: [],
    declaresEmit: "smoke.pass",
  });

  // proves AC-085-10
  it("passes on a recorded pass, carrying the provenance and run link", () => {
    const results = evaluate({
      defs: [emitDef],
      spans: [],
      emitted: new Map([
        [
          "smoke.pass",
          { name: "smoke.pass", result: "pass", link: "https://ci.example/run/42", provenance: "ci" },
        ],
      ]),
    });
    expect(results).toEqual([
      {
        id: "smoke-test",
        status: "pass",
        row: "Smoke test passed on the preview deploy",
        level: "warn",
        refs: [],
        source: { provenance: "ci", link: "https://ci.example/run/42" },
      },
    ]);
  });

  it("flags on a recorded fail, keeping the failing run's source", () => {
    const results = evaluate({
      defs: [emitDef],
      emitted: new Map([
        [
          "smoke.pass",
          { name: "smoke.pass", result: "fail", link: "https://ci.example/run/43", provenance: "ci" },
        ],
      ]),
    });
    expect(results.map((r) => ({ status: r.status, source: r.source }))).toEqual([
      { status: "flag", source: { provenance: "ci", link: "https://ci.example/run/43" } },
    ]);
  });

  it("flags when no result was ever emitted — the record channel is checkable and empty", () => {
    expect(evaluate({ defs: [emitDef] }).map((r) => r.status)).toEqual(["flag"]);
  });

  // proves AC-085-11
  it("surfaces nothing for an emit no validator declares", () => {
    const results = evaluate({
      defs: [emitDef],
      emitted: new Map([
        [
          "smoke.pass",
          { name: "smoke.pass", result: "pass", link: "https://ci.example/run/1", provenance: "ci" },
        ],
        [
          "surprise.emit",
          { name: "surprise.emit", result: "pass", link: "https://ci.example/run/2", provenance: "ci" },
        ],
      ]),
    });
    // Exactly the declaring validator's row — the undeclared emit adds no
    // fact, no row, nothing.
    expect(results.map((r) => r.id)).toEqual(["smoke-test"]);
  });
});

describe("evaluateCustomValidators — composition and any-of", () => {
  it("resolves a built-in reference: pass passes through with its refs, absence flags", () => {
    const composed = def({
      id: "bugs-need-repro",
      row: "The bug was reproduced before the fix",
      whenPaths: null,
      requireAny: [{ type: "validator", id: "red-then-green" }],
      needs: [],
    });
    const passRef = new Map([
      [
        "red-then-green",
        { status: "pass" as const, refs: [{ sessionIndex: 0, turnIndex: 12 }] },
      ],
    ]);
    expect(evaluate({ defs: [composed], builtinResults: passRef })).toEqual([
      {
        id: "bugs-need-repro",
        status: "pass",
        row: "The bug was reproduced before the fix",
        level: "warn",
        refs: [{ sessionIndex: 0, turnIndex: 12 }],
        source: null,
      },
    ]);

    // A required validator whose own result is absent means the demanded
    // proof does not exist: that is a flag, not silence.
    const absentRef = new Map([["red-then-green", { status: "absent" as const, refs: [] }]]);
    expect(
      evaluate({ defs: [composed], builtinResults: absentRef }).map((r) => r.status),
    ).toEqual(["flag"]);

    const blindRef = new Map([
      ["red-then-green", { status: "not_checkable" as const, refs: [] }],
    ]);
    expect(
      evaluate({ defs: [composed], builtinResults: blindRef }).map((r) => r.status),
    ).toEqual(["not_checkable"]);
  });

  it("evaluates a custom→custom reference in dependency order regardless of definition order", () => {
    const base = def({ id: "base-check", whenPaths: null });
    const dependent = def({
      id: "and-then-some",
      row: "Base check held",
      whenPaths: null,
      requireAny: [{ type: "validator", id: "base-check" }],
      needs: [],
    });
    const results = evaluate({
      // Dependent listed first: evaluation must still see base-check's result.
      defs: [dependent, base],
      spans: [run("supabase migration up", "ok", 5)],
    });
    expect(results.map((r) => ({ id: r.id, status: r.status }))).toEqual([
      { id: "and-then-some", status: "pass" },
      { id: "base-check", status: "pass" },
    ]);
  });

  it("any-of: the first passing alternative wins; all-blind is not checkable, otherwise a miss flags", () => {
    const either = def({
      id: "either-proof",
      row: "Migration proven in session or CI",
      whenPaths: null,
      requireAny: [
        { type: "session-ran", command: "supabase migration up", status: "ok" },
        { type: "emitted", name: "migration.executed" },
      ],
      needs: [],
    });
    const viaEmit = evaluate({
      defs: [either],
      spans: [run("vitest run", "ok", 1)],
      emitted: new Map([
        [
          "migration.executed",
          { name: "migration.executed", result: "pass", link: "https://ci.example/r/9", provenance: "ci" },
        ],
      ]),
    });
    expect(viaEmit.map((r) => ({ status: r.status, source: r.source }))).toEqual([
      { status: "pass", source: { provenance: "ci", link: "https://ci.example/r/9" } },
    ]);

    // Session channel blind + emit channel empty: the emit channel WAS
    // checkable and unmet, so the requirement flags.
    const halfBlind = evaluate({
      defs: [either],
      spans: [{ sessionIndex: 0, turnIndex: 1, toolName: "Bash", status: "ok", isEdit: false }],
    });
    expect(halfBlind.map((r) => r.status)).toEqual(["flag"]);

    const sessionOnly = def({
      id: "session-only",
      row: "Runs in session",
      whenPaths: null,
      requireAny: [{ type: "session-ran", command: "supabase migration up", status: "ok" }],
    });
    const allBlind = evaluate({
      defs: [sessionOnly],
      spans: [{ sessionIndex: 0, turnIndex: 1, toolName: "Bash", status: "ok", isEdit: false }],
    });
    expect(allBlind.map((r) => r.status)).toEqual(["not_checkable"]);
  });
});

describe("evaluateCustomValidators — the rails", () => {
  // proves AC-085-14
  it("has no way to express a red-class result", () => {
    const flagged = evaluate({ spans: [run("vitest run", "ok", 1)] });
    expect(flagged).toHaveLength(1);
    // The result shape carries no red-class channel at all: nothing a
    // definition can contain makes this anything but amber downstream.
    expect(Object.keys(flagged[0]!).sort()).toEqual([
      "id",
      "level",
      "refs",
      "row",
      "source",
      "status",
    ]);
  });

  // proves AC-085-16
  it("is deterministic: identical inputs evaluate to deeply equal results", () => {
    const inputs = {
      defs: [def(), def({ id: "second-check", whenPaths: null })],
      spans: [run("supabase migration up", "ok", 3), run("vitest run", "error", 4)],
      changedPaths: ["supabase/migrations/x.sql"],
      emitted: new Map<string, EmittedResultRecord>(),
    };
    expect(evaluate(inputs)).toEqual(evaluate(inputs));
  });
});
