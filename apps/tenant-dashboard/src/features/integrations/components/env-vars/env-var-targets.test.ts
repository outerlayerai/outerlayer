import { describe, expect, it } from "vitest";
import { envVarRowTargetLabel, scopesFromChoices } from "./env-var-targets";

describe("scopesFromChoices", () => {
  const ENV = "env-current";

  it("maps each kind choice to a target_kind scope, in display order", () => {
    expect(scopesFromChoices(["preview", "development"], ENV)).toEqual([
      { targetKind: "development" },
      { targetKind: "preview" },
    ]);
  });

  it("'all' is exclusive — emits a single 'all' row even if kinds are also set", () => {
    expect(scopesFromChoices(["all", "preview", "promoted"], ENV)).toEqual([
      { targetKind: "all" },
    ]);
  });

  it("'env' adds a specific-environment override for the current env", () => {
    expect(scopesFromChoices(["preview", "env"], ENV)).toEqual([
      { targetKind: "preview" },
      { environmentId: ENV },
    ]);
  });

  it("'all' + 'env' yields the all-kinds row plus the specific override", () => {
    expect(scopesFromChoices(["all", "env"], ENV)).toEqual([
      { targetKind: "all" },
      { environmentId: ENV },
    ]);
  });

  it("returns an empty list when nothing is selected", () => {
    expect(scopesFromChoices([], ENV)).toEqual([]);
  });
});

describe("envVarRowTargetLabel", () => {
  it("labels kind rows with the display name (Production for promoted)", () => {
    expect(
      envVarRowTargetLabel({ target_kind: "promoted", environment_id: null }, {}),
    ).toBe("Production");
    expect(
      envVarRowTargetLabel({ target_kind: "all", environment_id: null }, {}),
    ).toBe("All Environments");
  });

  it("labels a specific-env row with the env name from the map", () => {
    expect(
      envVarRowTargetLabel(
        { target_kind: null, environment_id: "e1" },
        { e1: "staging" },
      ),
    ).toBe("staging");
  });

  it("falls back to 'Environment' when the env id is unknown", () => {
    expect(
      envVarRowTargetLabel({ target_kind: null, environment_id: "ghost" }, {}),
    ).toBe("Environment");
  });
});
