/**
 * Pins the policy parser's contract: definitions are data (parsing never
 * executes), errors are collected per file and never thrown, dangling names
 * fail at load, and the level map composes built-in defaults → custom
 * levels → policy-file overrides in that order.
 */
import { describe, expect, it } from "vitest";
import { parseEvidencePolicy } from "../policy";

const MIGRATION_CUSTOM = `
id: migration-must-run
kind: validation
row: "The migration was actually run"
when:
  paths: ["supabase/migrations/**"]
require:
  any:
    - session.ran: { command: "supabase migration up", status: ok }
`;

function file(path: string, content: string) {
  return { path, content };
}

describe("parseEvidencePolicy", () => {
  it("yields the built-in defaults from an empty source", () => {
    const policy = parseEvidencePolicy({ policyYaml: null, validatorFiles: [] });
    expect(policy.customs).toEqual([]);
    expect(policy.errors).toEqual([]);
    expect(policy.levels).toEqual(
      new Map([
        ["red-then-green", "warn"],
        ["no-test-tampering", "warn"],
        ["commits-from-sessions", "warn"],
      ]),
    );
  });

  // AC-085-01
  it("applies policy-file level overrides over defaults and custom levels", () => {
    const policy = parseEvidencePolicy({
      policyYaml: file(
        ".outerlayer/policy.yaml",
        `extends: outerlayer:recommended@v1
validators:
  red-then-green: off
  commits-from-sessions: info
  migration-must-run: info
`,
      ),
      validatorFiles: [file(".outerlayer/validators/migration-must-run.yaml", MIGRATION_CUSTOM)],
    });
    expect(policy.errors).toEqual([]);
    expect(policy.levels).toEqual(
      new Map([
        ["red-then-green", "off"],
        ["no-test-tampering", "warn"],
        ["commits-from-sessions", "info"],
        ["migration-must-run", "info"],
      ]),
    );
  });

  it("parses a full custom validator into its exact shape", () => {
    const policy = parseEvidencePolicy({
      policyYaml: null,
      validatorFiles: [file(".outerlayer/validators/migration-must-run.yaml", MIGRATION_CUSTOM)],
    });
    expect(policy.errors).toEqual([]);
    expect(policy.customs).toEqual([
      {
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
      },
    ]);
  });

  // AC-085-07
  it("collects dangling names as load errors instead of silent no-ops", () => {
    const policy = parseEvidencePolicy({
      policyYaml: file(
        ".outerlayer/policy.yaml",
        `extends: someone-else:strict@v9
validators:
  does-not-exist: warn
`,
      ),
      validatorFiles: [
        file(
          ".outerlayer/validators/needs-ghost.yaml",
          `id: needs-ghost
row: "Ghost was consulted"
require:
  validator: ghost-validator
`,
        ),
        file(
          ".outerlayer/validators/undeclared-emit.yaml",
          `id: undeclared-emit
row: "Smoke test passed"
require:
  emitted: smoke.pass
`,
        ),
      ],
    });
    expect(policy.customs).toEqual([]);
    expect(policy.errors).toEqual([
      {
        file: ".outerlayer/validators/needs-ghost.yaml",
        message:
          "`validator: ghost-validator` cannot be required — only red-then-green and no-test-tampering can, for now",
      },
      {
        file: ".outerlayer/validators/undeclared-emit.yaml",
        message: "`emitted: smoke.pass` — no validator declares `run.emit: smoke.pass`",
      },
      {
        file: ".outerlayer/policy.yaml",
        message:
          'unknown preset "someone-else:strict@v9" — this engine ships outerlayer:recommended@v1',
      },
      {
        file: ".outerlayer/policy.yaml",
        message: "`validators.does-not-exist` does not name a validator",
      },
    ]);
  });

  // AC-085-10
  it("accepts an emitted requirement only when a validator declares the name", () => {
    const declared = parseEvidencePolicy({
      policyYaml: null,
      validatorFiles: [
        file(
          ".outerlayer/validators/smoke.yaml",
          `id: smoke-test
row: "Smoke test passed on the preview deploy"
run: { where: ci, emit: smoke.pass }
require:
  emitted: smoke.pass
`,
        ),
      ],
    });
    expect(declared.errors).toEqual([]);
    expect(declared.customs[0]!.require.conditions).toEqual([
      { kind: "emitted", name: "smoke.pass" },
    ]);
  });

  it("excludes a broken file wholly while keeping the rest of the policy", () => {
    const policy = parseEvidencePolicy({
      policyYaml: null,
      validatorFiles: [
        file(".outerlayer/validators/broken.yaml", "id: [not-a-slug\n  row: {{{"),
        file(".outerlayer/validators/ok.yaml", MIGRATION_CUSTOM),
      ],
    });
    expect(policy.customs.map((custom) => custom.id)).toEqual(["migration-must-run"]);
    expect(policy.errors).toHaveLength(1);
    expect(policy.errors[0]!.file).toEqual(".outerlayer/validators/broken.yaml");
    expect(policy.errors[0]!.message).toMatch(/not valid YAML/);
  });

  it("rejects ids that collide with built-ins or other customs", () => {
    const policy = parseEvidencePolicy({
      policyYaml: null,
      validatorFiles: [
        file(
          ".outerlayer/validators/shadow.yaml",
          `id: red-then-green
row: "Impostor"
require:
  session.ran: { command: "true" }
`,
        ),
      ],
    });
    expect(policy.customs).toEqual([]);
    expect(policy.errors).toEqual([
      { file: ".outerlayer/validators/shadow.yaml", message: 'id "red-then-green" is already taken' },
    ]);
  });

  it("rejects every malformed shape with the exact message that names the problem", () => {
    const REQUIRE = `require:\n  session.ran: { command: "t" }`;
    const cases: Array<[string, string]> = [
      [`row: "r"\n${REQUIRE}`, "`id` must be a lowercase-dashed slug"],
      [`id: Bad_Slug\nrow: "r"\n${REQUIRE}`, "`id` must be a lowercase-dashed slug"],
      [`id: x\nkind: gate\nrow: "r"\n${REQUIRE}`, '`kind` must be "validation" or "signal", got "gate"'],
      [`id: x\n${REQUIRE}`, "`row` is required — it is the sentence the comment renders"],
      [`id: x\nrow: "${"y".repeat(141)}"\n${REQUIRE}`, "`row` is longer than 140 characters"],
      [`id: x\nrow: "r"\nlevel: blocking\n${REQUIRE}`, '`level` must be warn, info, or off — got "blocking"'],
      [`id: x\nrow: "r"\nwhen: 5\n${REQUIRE}`, "`when` must be a mapping"],
      [`id: x\nrow: "r"\nwhen:\n  paths: "x"\n${REQUIRE}`, "`when.paths` must be a list of non-empty path globs"],
      [`id: x\nrow: "r"\nwhen:\n  paths: [""]\n${REQUIRE}`, "`when.paths` must be a list of non-empty path globs"],
      [`id: x\nrow: "r"\nwhen:\n  issue.type: bug\n${REQUIRE}`, "`when.issue.type` is not supported yet — only `when.paths`"],
      [`id: x\nrow: "r"\nrun: { where: local, emit: a }\n${REQUIRE}`, "`run` must be `{ where: ci, emit: <name> }`"],
      [`id: x\nrow: "r"\nrun: { where: ci, emit: "Bad Name" }\n${REQUIRE}`, "`run.emit` must be a dotted lowercase name (like `smoke.pass`)"],
      [`id: x\nrow: "r"\nneeds: commands\n${REQUIRE}`, "`needs` must be a list"],
      [`id: x\nrow: "r"\nneeds: [wishes]\n${REQUIRE}`, '`needs` entry "wishes" is not a fact family'],
      [`id: x\nrow: "r"`, "`require` is required for a validation"],
      [`id: x\nrow: "r"\nrequire: 5`, "`require` must be a mapping"],
      [
        `id: x\nrow: "r"\nrequire:\n  any: [{ session.ran: { command: "t" } }]\n  all: [{ session.ran: { command: "t" } }]`,
        "`require` may use `any` or `all`, not both",
      ],
      [`id: x\nrow: "r"\nrequire:\n  all: "x"`, "`require.all` must be a non-empty list of conditions"],
      [`id: x\nrow: "r"\nrequire:\n  any: []`, "`require.any` must be a non-empty list of conditions"],
      [`id: x\nrow: "r"\nrequire:\n  any: [5]`, "each condition must be a mapping with one key"],
      [
        `id: x\nrow: "r"\nrequire:\n  any: [{ session.ran: { command: "t" }, emitted: a.b }]`,
        "a condition takes exactly one of session.ran / validator / emitted",
      ],
      [`id: x\nrow: "r"\nrequire:\n  session.ran: { status: ok }`, "`session.ran` needs a `command`"],
      [`id: x\nrow: "r"\nrequire:\n  session.ran: { command: "  " }`, "`session.ran` needs a `command`"],
      [
        `id: x\nrow: "r"\nrequire:\n  session.ran: { command: "t", status: error }`,
        '`session.ran.status` supports only "ok" — got "error"',
      ],
      [`id: x\nrow: "r"\nrequire:\n  session.ran: { command: "t", shell: bash }`, "`session.ran.shell` is not supported yet"],
      [`id: x\nrow: "r"\nrequire:\n  wished: hard`, '"wished" is not a condition — use session.ran, validator, or emitted'],
      [`id: x\nrow: "r"\nrequire:\n  emitted: "Bad!"`, "`emitted` must be a dotted lowercase name (like `smoke.pass`)"],
      [`- a\n- b`, "expected a YAML mapping at the top level"],
    ];
    for (const [content, expected] of cases) {
      const policy = parseEvidencePolicy({
        policyYaml: null,
        validatorFiles: [file("v.yaml", content)],
      });
      expect(policy.customs).toEqual([]);
      expect(policy.errors).toEqual([{ file: "v.yaml", message: expected }]);
    }
  });

  it("rejects malformed policy files with exact messages, and accepts empty ones", () => {
    const policyCases: Array<[string, string]> = [
      [`- a`, "expected a YAML mapping at the top level"],
      [`validators: [a, b]`, "`validators` must map validator ids to levels"],
      [`validators:\n  red-then-green: 5`, '`validators.red-then-green` must be warn, info, or off — got "5"'],
    ];
    for (const [content, expected] of policyCases) {
      const policy = parseEvidencePolicy({
        policyYaml: file(".outerlayer/policy.yaml", content),
        validatorFiles: [],
      });
      expect(policy.errors).toEqual([{ file: ".outerlayer/policy.yaml", message: expected }]);
    }
    const empty = parseEvidencePolicy({
      policyYaml: file(".outerlayer/policy.yaml", "# nothing adopted yet\n"),
      validatorFiles: [],
    });
    expect(empty.errors).toEqual([]);
    expect(empty.levels.get("red-then-green")).toEqual("warn");
  });

  it("parses require.all, unions explicit needs, and trims row and command", () => {
    const policy = parseEvidencePolicy({
      policyYaml: null,
      validatorFiles: [
        file(
          "v.yaml",
          `id: x
row: "  Proven twice  "
level: off
needs: [tool-calls.edits, commands]
require:
  all:
    - session.ran: { command: "  supabase migration up  " }
    - session.ran: { command: "yarn ci:unit" }
`,
        ),
      ],
    });
    expect(policy.errors).toEqual([]);
    expect(policy.customs).toEqual([
      {
        id: "x",
        kind: "validation",
        row: "Proven twice",
        level: "off",
        whenPaths: null,
        require: {
          mode: "all",
          conditions: [
            { kind: "session-ran", command: "supabase migration up" },
            { kind: "session-ran", command: "yarn ci:unit" },
          ],
        },
        needs: ["commands", "edits"],
      },
    ]);
    expect(policy.levels.get("x")).toEqual("off");
  });

  // AC-085-11
  it("is deterministic: identical sources parse to deeply equal policies", () => {
    const source = {
      policyYaml: file(".outerlayer/policy.yaml", "extends: outerlayer:recommended@v1\n"),
      validatorFiles: [file(".outerlayer/validators/m.yaml", MIGRATION_CUSTOM)],
    };
    expect(parseEvidencePolicy(source)).toEqual(parseEvidencePolicy(source));
  });
});
