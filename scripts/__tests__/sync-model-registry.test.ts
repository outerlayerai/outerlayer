import { describe, expect, it } from "vitest";
import type { ModelEntry } from "../../packages/model-registry/src/types";
import {
  generateChangelog,
  generatePRBody,
  handleDeprecation,
} from "../sync-model-registry";

type Entry = Omit<ModelEntry, "id">;

function entry(overrides: Partial<Entry> = {}): Entry {
  return {
    provider: "anthropic",
    displayName: "Test",
    mode: "chat",
    ...overrides,
  };
}

describe("handleDeprecation — ordering", () => {
  it("preserves original models.json order when a model is deprecated", () => {
    const existing: Record<string, Entry> = {
      a: entry({ displayName: "A" }),
      b: entry({ displayName: "B" }),
      c: entry({ displayName: "C" }),
    };
    // Upstream drops 'b'.
    const upstream = new Map<string, Entry>([
      ["a", entry({ displayName: "A" })],
      ["c", entry({ displayName: "C" })],
    ]);

    handleDeprecation(upstream, existing);

    expect([...upstream.keys()]).toEqual(["a", "b", "c"]);
    expect(upstream.get("b")?.deprecationDate).toMatch(/^\d{4}-\d{2}-\d{2}$/);
  });

  it("appends genuinely-new models at the end", () => {
    const existing: Record<string, Entry> = {
      a: entry({ displayName: "A" }),
      b: entry({ displayName: "B" }),
    };
    const upstream = new Map<string, Entry>([
      ["a", entry({ displayName: "A" })],
      ["b", entry({ displayName: "B" })],
      ["new", entry({ displayName: "New" })],
    ]);

    handleDeprecation(upstream, existing);

    expect([...upstream.keys()]).toEqual(["a", "b", "new"]);
  });

  it("does not bump the deprecation date if one is already set", () => {
    const existing: Record<string, Entry> = {
      a: entry({ displayName: "A", deprecationDate: "2025-01-01" }),
    };
    const upstream = new Map<string, Entry>();

    const delta = handleDeprecation(upstream, existing);

    expect(upstream.get("a")?.deprecationDate).toBe("2025-01-01");
    expect(delta.newlyDeprecated).toEqual([]);
  });
});

describe("handleDeprecation — delta tracking", () => {
  it("reports newly-deprecated ids", () => {
    const existing: Record<string, Entry> = {
      a: entry(),
      b: entry(),
    };
    const upstream = new Map<string, Entry>([["a", entry()]]);

    const delta = handleDeprecation(upstream, existing);

    expect(delta.newlyDeprecated).toEqual(["b"]);
    expect(delta.resurrected).toEqual([]);
  });

  it("reports resurrected ids and clears the tombstone", () => {
    const existing: Record<string, Entry> = {
      a: entry({ deprecationDate: "2025-01-01" }),
    };
    const upstream = new Map<string, Entry>([["a", entry()]]);

    const delta = handleDeprecation(upstream, existing);

    expect(delta.resurrected).toEqual(["a"]);
    expect(upstream.get("a")?.deprecationDate).toBeNull();
  });

  it("does not re-deprecate a model that was already deprecated", () => {
    const existing: Record<string, Entry> = {
      a: entry({ deprecationDate: "2025-01-01" }),
    };
    const upstream = new Map<string, Entry>(); // still gone

    const delta = handleDeprecation(upstream, existing);

    expect(delta.newlyDeprecated).toEqual([]);
    expect(upstream.get("a")?.deprecationDate).toBe("2025-01-01");
  });
});

describe("generateChangelog — deprecations", () => {
  it("populates `deprecated` and `resurrected` from the delta", () => {
    const existing: Record<string, Entry> = { a: entry(), b: entry() };
    const upstream = new Map<string, Entry>([
      ["a", entry()],
      ["b", entry()],
    ]);

    const changelog = generateChangelog(upstream, existing, {
      newlyDeprecated: ["b"],
      resurrected: ["a"],
    });

    expect(changelog.deprecated).toEqual(["b"]);
    expect(changelog.resurrected).toEqual(["a"]);
    expect(changelog.removed).toEqual([]); // intentionally empty post-fix
  });

  it("flags pricing drops as anomalies for carried-forward models", () => {
    const existing: Record<string, Entry> = {
      a: entry({
        pricing: { inputCostPerToken: 0.001, outputCostPerToken: 0.002 },
      }),
    };
    const upstream = new Map<string, Entry>([
      [
        "a",
        entry({
          pricing: { inputCostPerToken: 0.0001, outputCostPerToken: 0.002 },
        }),
      ],
    ]);

    const changelog = generateChangelog(upstream, existing);

    expect(
      changelog.anomalies.some((a) => a.type === "pricing_drop")
    ).toBe(true);
  });
});

describe("generatePRBody — deprecation visibility", () => {
  it("renders a deprecation section when the changelog has entries", () => {
    const body = generatePRBody({
      added: [],
      removed: [],
      deprecated: ["claude-3.7-sonnet", "claude-3.7-sonnet:thinking"],
      resurrected: [],
      pricingChanged: [],
      capabilitiesChanged: [],
      anomalies: [],
    });

    expect(body).toContain("### Models Deprecated (2)");
    expect(body).toContain("- claude-3.7-sonnet");
    expect(body).toContain("- claude-3.7-sonnet:thinking");
    expect(body).not.toContain("No significant changes detected.");
  });

  it("renders a resurrection section when models reappear", () => {
    const body = generatePRBody({
      added: [],
      removed: [],
      deprecated: [],
      resurrected: ["claude-3.7-sonnet"],
      pricingChanged: [],
      capabilitiesChanged: [],
      anomalies: [],
    });

    expect(body).toContain("### Models Resurrected (1)");
    expect(body).toContain("- claude-3.7-sonnet");
  });

  it("falls back to the empty notice when nothing changed", () => {
    const body = generatePRBody({
      added: [],
      removed: [],
      deprecated: [],
      resurrected: [],
      pricingChanged: [],
      capabilitiesChanged: [],
      anomalies: [],
    });

    expect(body).toContain("No significant changes detected.");
  });
});
