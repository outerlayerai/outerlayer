/**
 * Pins the policy loader: adopting and leveling the registry, custom
 * validator files loading whole-or-not-at-all, and every cross-reference
 * failing loudly at load — never silently at check time.
 */
import { describe, expect, it } from "vitest";
import {
  RECOMMENDED_LEVELS,
  defaultPolicy,
  parsePolicy,
  type CustomValidatorDef,
} from "../policy";

const POLICY_PATH = ".outerlayer/policy.yaml";

function policyFile(content: string) {
  return { path: POLICY_PATH, content };
}

function validatorFile(name: string, content: string) {
  return { path: `.outerlayer/validators/${name}`, content };
}

const MIGRATION_VALIDATOR = validatorFile(
  "migration-must-run.yaml",
  [
    "id: migration-must-run",
    "kind: validation",
    'row: "Migrations ran against a local database"',
    "when:",
    '  paths: ["supabase/migrations/**"]',
    "require:",
    '  session.ran: { command: "supabase migration up", status: ok }',
    "needs: [tool-calls.commands]",
  ].join("\n"),
);

describe("parsePolicy — the policy file", () => {
  it("returns the recommended defaults for a repo with no files at all", () => {
    expect(parsePolicy(null, [])).toEqual(defaultPolicy());
    expect(defaultPolicy().levels).toEqual({
      "commits-from-sessions": "warn",
      "red-then-green": "warn",
      "no-test-tampering": "warn",
    });
  });

  // proves AC-085-01
  it("applies extends plus per-validator levels, off included", () => {
    const loaded = parsePolicy(
      policyFile(
        [
          "extends: outerlayer:recommended@v1",
          "validators:",
          "  red-then-green: off",
          "  commits-from-sessions: info",
        ].join("\n"),
      ),
      [],
    );
    expect(loaded.problems).toEqual([]);
    expect(loaded.levels).toEqual({
      "commits-from-sessions": "info",
      "red-then-green": "off",
      "no-test-tampering": "warn",
    });
  });

  // proves AC-085-13
  it("reports an unknown extends as a problem naming the file, and keeps the defaults", () => {
    const loaded = parsePolicy(policyFile("extends: outerlayer:strict@v9"), []);
    expect(loaded.problems).toEqual([
      {
        file: POLICY_PATH,
        problem:
          'unknown extends "outerlayer:strict@v9" — the only supported registry is outerlayer:recommended@v1',
      },
    ]);
    expect(loaded.levels).toEqual(RECOMMENDED_LEVELS);
  });

  it("rejects a policy with no extends, an unknown key, or a bad level — voiding its overrides", () => {
    const missing = parsePolicy(policyFile("validators:\n  red-then-green: off"), []);
    expect(missing.problems).toEqual([
      {
        file: POLICY_PATH,
        problem: 'missing "extends" — adopt the registry with extends: outerlayer:recommended@v1',
      },
    ]);
    expect(missing.levels).toEqual(RECOMMENDED_LEVELS);

    const unknownKey = parsePolicy(
      policyFile("extends: outerlayer:recommended@v1\nchecks: {}"),
      [],
    );
    expect(unknownKey.problems).toEqual([{ file: POLICY_PATH, problem: 'unknown key "checks"' }]);

    const badLevel = parsePolicy(
      policyFile("extends: outerlayer:recommended@v1\nvalidators:\n  red-then-green: loud"),
      [],
    );
    expect(badLevel.problems).toEqual([
      {
        file: POLICY_PATH,
        problem: 'validator "red-then-green" has level "loud" — use warn, info, or off',
      },
    ]);
    expect(badLevel.levels).toEqual(RECOMMENDED_LEVELS);
  });

  it("reports a level entry naming a validator that does not exist", () => {
    const loaded = parsePolicy(
      policyFile("extends: outerlayer:recommended@v1\nvalidators:\n  no-such-check: off"),
      [],
    );
    expect(loaded.problems).toEqual([
      { file: POLICY_PATH, problem: 'policy levels unknown validator "no-such-check"' },
    ]);
    expect(loaded.levels).toEqual(RECOMMENDED_LEVELS);
  });

  it("does not treat YAML that fails to parse as an empty policy", () => {
    const loaded = parsePolicy(policyFile("extends: [unclosed"), []);
    expect(loaded.problems).toHaveLength(1);
    expect(loaded.problems[0]!.file).toBe(POLICY_PATH);
    expect(loaded.problems[0]!.problem).toMatch(/^not valid YAML — /);
    expect(loaded.levels).toEqual(RECOMMENDED_LEVELS);
  });
});

describe("parsePolicy — custom validator files", () => {
  it("loads a session.ran custom whole, mapping the namespaced fact family", () => {
    const loaded = parsePolicy(null, [MIGRATION_VALIDATOR]);
    expect(loaded.problems).toEqual([]);
    expect(loaded.customs).toEqual([
      {
        id: "migration-must-run",
        row: "Migrations ran against a local database",
        level: "warn",
        whenPaths: ["supabase/migrations/**"],
        requireAny: [
          { type: "session-ran", command: "supabase migration up", status: "ok" },
        ],
        needs: ["commands"],
        declaresEmit: null,
      } satisfies CustomValidatorDef,
    ]);
    expect(loaded.levels["migration-must-run"]).toBe("warn");
  });

  it("normalizes run: {where: ci, emit} into a self-declared emitted requirement", () => {
    const loaded = parsePolicy(null, [
      validatorFile(
        "smoke-test.yaml",
        [
          "id: smoke-test",
          "kind: validation",
          'row: "Smoke test passed on the preview deploy"',
          "level: info",
          "run:",
          "  where: ci",
          "  emit: smoke.pass",
        ].join("\n"),
      ),
    ]);
    expect(loaded.problems).toEqual([]);
    expect(loaded.customs).toEqual([
      {
        id: "smoke-test",
        row: "Smoke test passed on the preview deploy",
        level: "info",
        whenPaths: null,
        requireAny: [{ type: "emitted", name: "smoke.pass" }],
        needs: [],
        declaresEmit: "smoke.pass",
      },
    ]);
  });

  it("accepts require.any alternatives and a validator reference to a built-in", () => {
    const loaded = parsePolicy(null, [
      validatorFile(
        "either.yaml",
        [
          "id: either-proof",
          "kind: validation",
          'row: "Migration proven in session or CI"',
          "require:",
          "  any:",
          '    - session.ran: { command: "supabase migration up" }',
          "    - emitted: migration.executed",
        ].join("\n"),
      ),
      validatorFile(
        "runner.yaml",
        [
          "id: migration-ci",
          "kind: validation",
          'row: "Migration executed in CI"',
          "run: { where: ci, emit: migration.executed }",
        ].join("\n"),
      ),
      validatorFile(
        "composed.yaml",
        [
          "id: bugs-need-repro",
          "kind: validation",
          'row: "The bug was reproduced before the fix"',
          "require: { validator: red-then-green }",
        ].join("\n"),
      ),
    ]);
    expect(loaded.problems).toEqual([]);
    expect(loaded.customs.map((c) => c.id)).toEqual([
      "bugs-need-repro",
      "either-proof",
      "migration-ci",
    ]);
    const either = loaded.customs.find((c) => c.id === "either-proof")!;
    expect(either.requireAny).toEqual([
      { type: "session-ran", command: "supabase migration up", status: "ok" },
      { type: "emitted", name: "migration.executed" },
    ]);
  });

  // proves AC-085-15
  it("accepts a signal file but yields no definition for it — a signal can never render as a validation row", () => {
    const loaded = parsePolicy(null, [
      validatorFile(
        "hunch.yaml",
        ["id: big-diff-hunch", "kind: signal"].join("\n"),
      ),
    ]);
    expect(loaded.problems).toEqual([]);
    expect(loaded.customs).toEqual([]);
    expect("big-diff-hunch" in loaded.levels).toBe(false);
  });

  it("rejects an unknown kind loudly instead of guessing", () => {
    const loaded = parsePolicy(null, [
      validatorFile("odd.yaml", 'id: odd-kind\nkind: check\nrow: "x"\nrequire: { emitted: x }'),
    ]);
    expect(loaded.customs).toEqual([]);
    expect(loaded.problems).toEqual([
      { file: ".outerlayer/validators/odd.yaml", problem: '"odd-kind" has kind "check" — use validation or signal' },
    ]);
  });

  // proves AC-085-13
  it("reports a dangling require.validator id and drops the referencing validator", () => {
    const loaded = parsePolicy(null, [
      validatorFile(
        "dangling.yaml",
        [
          "id: needs-ghost",
          "kind: validation",
          'row: "Composed on nothing"',
          "require: { validator: ghost-check }",
        ].join("\n"),
      ),
    ]);
    expect(loaded.customs).toEqual([]);
    expect(loaded.problems).toEqual([
      {
        file: ".outerlayer/validators/dangling.yaml",
        problem: '"needs-ghost" requires validator "ghost-check" — no such validator exists',
      },
    ]);
  });

  // proves AC-085-13
  it("reports an emitted requirement no validator declares and drops the referencing validator", () => {
    const loaded = parsePolicy(null, [
      validatorFile(
        "undeclared.yaml",
        [
          "id: wants-emit",
          "kind: validation",
          'row: "Requires an unheard-of emit"',
          "require: { emitted: never.declared }",
        ].join("\n"),
      ),
    ]);
    expect(loaded.customs).toEqual([]);
    expect(loaded.problems).toEqual([
      {
        file: ".outerlayer/validators/undeclared.yaml",
        problem:
          '"wants-emit" requires emitted "never.declared" but no validator declares emit: never.declared',
      },
    ]);
  });

  it("cascades drops: losing the declaring validator invalidates its dependents too", () => {
    const loaded = parsePolicy(null, [
      // Broken declarer: bad level, so the file contributes nothing…
      validatorFile(
        "declarer.yaml",
        [
          "id: smoke-test",
          "kind: validation",
          'row: "Smoke test passed"',
          "level: loudest",
          "run: { where: ci, emit: smoke.pass }",
        ].join("\n"),
      ),
      // …which strands this one's emitted reference.
      validatorFile(
        "dependent.yaml",
        [
          "id: deploy-check",
          "kind: validation",
          'row: "Deploy verified"',
          "require: { emitted: smoke.pass }",
        ].join("\n"),
      ),
    ]);
    expect(loaded.customs).toEqual([]);
    expect(loaded.problems).toEqual([
      {
        file: ".outerlayer/validators/declarer.yaml",
        problem: '"smoke-test" has level "loudest" — use warn, info, or off',
      },
      {
        file: ".outerlayer/validators/dependent.yaml",
        problem:
          '"deploy-check" requires emitted "smoke.pass" but no validator declares emit: smoke.pass',
      },
    ]);
  });

  it("drops validator-reference cycles as unresolvable", () => {
    const loaded = parsePolicy(null, [
      validatorFile(
        "a.yaml",
        'id: check-a\nkind: validation\nrow: "A"\nrequire: { validator: check-b }',
      ),
      validatorFile(
        "b.yaml",
        'id: check-b\nkind: validation\nrow: "B"\nrequire: { validator: check-a }',
      ),
    ]);
    expect(loaded.customs).toEqual([]);
    expect(loaded.problems.map((p) => p.problem).sort()).toEqual([
      '"check-a" is part of a validator-reference cycle and cannot be evaluated',
      '"check-b" is part of a validator-reference cycle and cannot be evaluated',
    ]);
  });

  it("rejects duplicate ids, built-in collisions, and unreferenceable built-ins", () => {
    const duplicate = parsePolicy(null, [
      validatorFile("one.yaml", 'id: same-id\nkind: validation\nrow: "x"\nrequire: { validator: red-then-green }'),
      validatorFile("two.yaml", 'id: same-id\nkind: validation\nrow: "y"\nrequire: { validator: red-then-green }'),
    ]);
    expect(duplicate.customs.map((c) => c.id)).toEqual(["same-id"]);
    expect(duplicate.problems).toEqual([
      { file: ".outerlayer/validators/two.yaml", problem: 'duplicate validator id "same-id"' },
    ]);

    const collision = parsePolicy(null, [
      validatorFile("shadow.yaml", 'id: red-then-green\nkind: validation\nrow: "x"\nrequire: { emitted: x.y }'),
    ]);
    expect(collision.customs).toEqual([]);
    expect(collision.problems).toEqual([
      {
        file: ".outerlayer/validators/shadow.yaml",
        problem: '"red-then-green" collides with a built-in validator id',
      },
    ]);

    const unreferenceable = parsePolicy(null, [
      validatorFile(
        "prov.yaml",
        'id: full-provenance\nkind: validation\nrow: "x"\nrequire: { validator: commits-from-sessions }',
      ),
    ]);
    expect(unreferenceable.customs).toEqual([]);
    expect(unreferenceable.problems).toEqual([
      {
        file: ".outerlayer/validators/prov.yaml",
        problem:
          '"full-provenance" requires validator "commits-from-sessions" — that built-in cannot be referenced',
      },
    ]);
  });

  it("levels a custom from the policy file above its own declared level — on the definition the evaluator reads, not only the levels map", () => {
    const loaded = parsePolicy(
      policyFile(
        [
          "extends: outerlayer:recommended@v1",
          "validators:",
          "  migration-must-run: info",
        ].join("\n"),
      ),
      [MIGRATION_VALIDATOR],
    );
    expect(loaded.problems).toEqual([]);
    expect(loaded.levels["migration-must-run"]).toBe("info");
    expect(loaded.customs.map((c) => ({ id: c.id, level: c.level }))).toEqual([
      { id: "migration-must-run", level: "info" },
    ]);
  });

  it("turns a custom off from the policy file — the definition carries the off level the evaluator skips on", () => {
    const loaded = parsePolicy(
      policyFile(
        [
          "extends: outerlayer:recommended@v1",
          "validators:",
          "  migration-must-run: off",
        ].join("\n"),
      ),
      [MIGRATION_VALIDATOR],
    );
    expect(loaded.problems).toEqual([]);
    expect(loaded.customs.map((c) => ({ id: c.id, level: c.level }))).toEqual([
      { id: "migration-must-run", level: "off" },
    ]);
  });

  it("caps when.paths glob count and glob length, refusing the file loudly", () => {
    const manyGlobs = parsePolicy(null, [
      validatorFile(
        "many.yaml",
        [
          "id: many-globs",
          "kind: validation",
          'row: "x"',
          "when:",
          `  paths: [${Array.from({ length: 21 }, (_, i) => `"p${i}/**"`).join(", ")}]`,
          "require: { validator: red-then-green }",
        ].join("\n"),
      ),
    ]);
    expect(manyGlobs.customs).toEqual([]);
    expect(manyGlobs.problems).toEqual([
      {
        file: ".outerlayer/validators/many.yaml",
        problem: '"many-globs" when.paths lists 21 globs — the cap is 20',
      },
    ]);

    const longGlob = parsePolicy(null, [
      validatorFile(
        "long.yaml",
        [
          "id: long-glob",
          "kind: validation",
          'row: "x"',
          "when:",
          `  paths: ["${"a*".repeat(101)}"]`,
          "require: { validator: red-then-green }",
        ].join("\n"),
      ),
    ]);
    expect(longGlob.customs).toEqual([]);
    expect(longGlob.problems).toEqual([
      {
        file: ".outerlayer/validators/long.yaml",
        problem: '"long-glob" when.paths has a 202-character glob — the cap is 200',
      },
    ]);
  });

  it("keeps loading valid files when a sibling file is broken", () => {
    const loaded = parsePolicy(null, [
      validatorFile("broken.yaml", "id: [nope"),
      MIGRATION_VALIDATOR,
    ]);
    expect(loaded.customs.map((c) => c.id)).toEqual(["migration-must-run"]);
    expect(loaded.problems).toHaveLength(1);
    expect(loaded.problems[0]!.file).toBe(".outerlayer/validators/broken.yaml");
  });

  it("is order-independent: shuffled file input loads an identical policy", () => {
    const files = [
      MIGRATION_VALIDATOR,
      validatorFile("runner.yaml", 'id: migration-ci\nkind: validation\nrow: "CI"\nrun: { where: ci, emit: migration.executed }'),
    ];
    const forward = parsePolicy(null, files);
    const reversed = parsePolicy(null, [...files].reverse());
    expect(reversed).toEqual(forward);
  });
});
