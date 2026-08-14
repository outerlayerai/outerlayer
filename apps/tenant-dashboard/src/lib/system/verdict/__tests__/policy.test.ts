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

  it("rejects unsupported condition shapes with messages that name the problem", () => {
    const cases: Array<[string, RegExp]> = [
      [`id: x\nrow: "r"\nrequire:\n  session.ran: { command: "t", status: error }`, /supports only "ok"/],
      [`id: x\nrow: "r"\nrequire:\n  wished: hard`, /is not a condition/],
      [`id: x\nrow: "r"\nrequire:\n  any: []`, /non-empty list/],
      [`id: x\nrow: "r"\nwhen:\n  issue.type: bug\nrequire:\n  session.ran: { command: "t" }`, /not supported yet/],
      [`id: x\nrow: "r"`, /`require` is required/],
      [`id: x\nrequire:\n  session.ran: { command: "t" }`, /`row` is required/],
    ];
    for (const [content, expected] of cases) {
      const policy = parseEvidencePolicy({
        policyYaml: null,
        validatorFiles: [file("v.yaml", content)],
      });
      expect(policy.customs).toEqual([]);
      expect(policy.errors).toHaveLength(1);
      expect(policy.errors[0]!.message).toMatch(expected);
    }
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
