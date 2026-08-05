import { describe, expect, it } from "vitest";
import {
  classifyEnvKind,
  envKindToTarget,
  envTargetOf,
  envVarEnvVaultName,
  envVarKindVaultName,
  envVarLegacyVaultName,
  envVarTargetMatches,
  envVarTargetRank,
  envVarVaultName,
  resolveEnvVarRows,
  type EnvVarRowLike,
} from "./index";

describe("classifyEnvKind", () => {
  it("classifies the default env (no pin, not ephemeral)", () => {
    expect(classifyEnvKind({ current_version: 0 })).toBe("default");
    expect(classifyEnvKind({ current_version: 0, is_ephemeral: false })).toBe(
      "default",
    );
    expect(classifyEnvKind({ current_version: 0, is_ephemeral: null })).toBe(
      "default",
    );
  });

  it("classifies a pinned non-ephemeral env as promoted", () => {
    expect(classifyEnvKind({ current_version: 3 })).toBe("promoted");
  });

  it("classifies an ephemeral env as preview even once it has a version", () => {
    // preview WINS over the version proxy: a deployed preview has version > 0
    // but is never on the promote ladder.
    expect(
      classifyEnvKind({ current_version: 5, is_ephemeral: true }),
    ).toBe("preview");
    expect(
      classifyEnvKind({ current_version: 0, is_ephemeral: true }),
    ).toBe("preview");
  });
});

describe("envKindToTarget / envTargetOf", () => {
  it("maps each kind to its target bucket", () => {
    expect(envKindToTarget("default")).toBe("development");
    expect(envKindToTarget("preview")).toBe("preview");
    expect(envKindToTarget("promoted")).toBe("promoted");
    expect(envKindToTarget("unknown")).toBeNull();
  });

  it("classifies a row straight to its target bucket", () => {
    expect(envTargetOf({ current_version: 0 })).toBe("development");
    expect(envTargetOf({ current_version: 2 })).toBe("promoted");
    expect(envTargetOf({ current_version: 9, is_ephemeral: true })).toBe(
      "preview",
    );
  });
});

describe("envVarTargetMatches / envVarTargetRank", () => {
  it("`all` matches every env, exact kinds match only themselves", () => {
    expect(envVarTargetMatches("all", "preview")).toBe(true);
    expect(envVarTargetMatches("all", "promoted")).toBe(true);
    expect(envVarTargetMatches("preview", "preview")).toBe(true);
    expect(envVarTargetMatches("preview", "promoted")).toBe(false);
    expect(envVarTargetMatches("development", "preview")).toBe(false);
  });

  it("ranks an exact kind above `all`", () => {
    expect(envVarTargetRank("preview")).toBeGreaterThan(
      envVarTargetRank("all"),
    );
  });
});

describe("resolveEnvVarRows", () => {
  const ENV = "env-preview-1";

  // Helper to build rows tersely.
  const specific = (key: string, env: string): EnvVarRowLike => ({
    key,
    target_kind: null,
    environment_id: env,
  });
  const kind = (
    key: string,
    target: EnvVarRowLike["target_kind"],
  ): EnvVarRowLike => ({ key, target_kind: target, environment_id: null });

  it("picks the most specific row per key: specific > exact kind > all", () => {
    const rows: EnvVarRowLike[] = [
      kind("OPENAI_API_KEY", "all"),
      kind("OPENAI_API_KEY", "preview"),
      specific("OPENAI_API_KEY", ENV),
      kind("LOG_LEVEL", "all"),
      kind("LOG_LEVEL", "preview"),
      kind("REGION", "all"),
    ];
    const winners = resolveEnvVarRows(rows, ENV, "preview");

    // Exactly one winner per key, each the highest-precedence applicable row.
    expect(
      winners.map((w) => [w.key, w.target_kind, w.environment_id]).sort(),
    ).toEqual(
      [
        ["OPENAI_API_KEY", null, ENV], // specific override wins
        ["LOG_LEVEL", "preview", null], // exact kind beats `all`
        ["REGION", "all", null], // only `all` available
      ].sort(),
    );
  });

  it("drops kind rows whose target does not match the env", () => {
    const rows: EnvVarRowLike[] = [
      kind("PROD_ONLY", "promoted"),
      kind("DEV_ONLY", "development"),
      kind("SHARED", "all"),
    ];
    const winners = resolveEnvVarRows(rows, ENV, "preview");
    expect(winners.map((w) => w.key)).toEqual(["SHARED"]);
  });

  it("drops specific rows belonging to a different environment", () => {
    const rows: EnvVarRowLike[] = [
      specific("SECRET", "some-other-env"),
      kind("SECRET", "preview"),
    ];
    const winners = resolveEnvVarRows(rows, ENV, "preview");
    // The other-env specific row must NOT win (or leak); the preview kind row does.
    expect(winners).toEqual([
      { key: "SECRET", target_kind: "preview", environment_id: null },
    ]);
  });

  it("applies no kind rows when the env target is null (unknown env)", () => {
    const rows: EnvVarRowLike[] = [
      kind("K", "all"),
      specific("K", ENV),
    ];
    // Only the specific row survives when we can't classify the env.
    expect(resolveEnvVarRows(rows, ENV, null)).toEqual([specific("K", ENV)]);
  });

  it("returns an empty list when nothing applies", () => {
    expect(
      resolveEnvVarRows([kind("X", "promoted")], ENV, "preview"),
    ).toEqual([]);
  });
});

// These pin the EXACT Vault secret names. The string IS the cross-app contract:
// the dashboard writes under these names and the gateway reads under them, so a
// drift (e.g. `kind_` → `kinds_`) silently breaks deployed-agent credentials.
// Asserting the literal is the point — do not relax to substring matches.
describe("Vault secret naming", () => {
  it("envVarEnvVaultName is env_<app>_<env>_<key>", () => {
    expect(envVarEnvVaultName("app1", "env9", "DATABASE_URL")).toBe(
      "env_app1_env9_DATABASE_URL",
    );
  });

  it("envVarKindVaultName is env_<app>_kind_<kind>_<key>", () => {
    expect(envVarKindVaultName("app1", "preview", "OPENAI_KEY")).toBe(
      "env_app1_kind_preview_OPENAI_KEY",
    );
  });

  it("envVarLegacyVaultName is the pre-055 env_<app>_<key>", () => {
    expect(envVarLegacyVaultName("app1", "OPENAI_KEY")).toBe(
      "env_app1_OPENAI_KEY",
    );
  });

  it("envVarVaultName dispatches to the env-scoped name for an env scope", () => {
    expect(
      envVarVaultName("app1", { environmentId: "env9" }, "OPENAI_KEY"),
    ).toBe(envVarEnvVaultName("app1", "env9", "OPENAI_KEY"));
  });

  it("envVarVaultName dispatches to the kind name for a kind scope", () => {
    expect(envVarVaultName("app1", { targetKind: "all" }, "OPENAI_KEY")).toBe(
      envVarKindVaultName("app1", "all", "OPENAI_KEY"),
    );
  });

  it("env-scoped and kind names differ for the same app+key", () => {
    // Real env ids are UUIDs, so an env-scoped name carries the UUID where a
    // kind name carries `kind_<kind>` — the two scopes never alias.
    const envName = envVarVaultName(
      "app1",
      { environmentId: "11111111-1111-4111-8111-111111111111" },
      "K",
    );
    const kindName = envVarVaultName("app1", { targetKind: "preview" }, "K");
    expect(envName).not.toBe(kindName);
  });
});
