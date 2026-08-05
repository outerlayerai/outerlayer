import { resolveAgentModel, getAgentDescriptor } from "./worker-agents";

describe("resolveAgentModel", () => {
  it("returns the requested model when the agent offers it", () => {
    expect(resolveAgentModel("claude-code", "opus")).toBe("opus");
    expect(resolveAgentModel("claude-code", "haiku")).toBe("haiku");
  });

  it("falls back to the agent's default for an unknown/spoofed model", () => {
    // The single validation point: a value the agent doesn't list can never
    // reach the CLI — it collapses to the default instead.
    expect(resolveAgentModel("claude-code", "gpt-4o")).toBe("sonnet");
    expect(resolveAgentModel("claude-code", "")).toBe("sonnet");
    expect(resolveAgentModel("claude-code", null)).toBe("sonnet");
    expect(resolveAgentModel("claude-code", undefined)).toBe("sonnet");
  });

  it("returns undefined for an agent with no model catalog (uses the CLI default)", () => {
    // codex is registered without a `models` block.
    expect(getAgentDescriptor("codex")?.models).toBeUndefined();
    expect(resolveAgentModel("codex", "gpt-5")).toBeUndefined();
  });

  it("returns undefined for an unknown agent", () => {
    expect(resolveAgentModel("nonexistent", "sonnet")).toBeUndefined();
  });

  it("claude-code's default is one of its offered options", () => {
    const models = getAgentDescriptor("claude-code")!.models!;
    expect(models.options.map((o) => o.id)).toContain(models.default);
  });
});
