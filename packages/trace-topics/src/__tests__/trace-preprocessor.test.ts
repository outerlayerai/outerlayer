/**
 * Pins the trace-preprocessor pure function (Topics Stage 1).
 *
 * Each test targets a specific bug class; the smallest production-code change
 * that could still pass all tests would break at least one assertion here.
 *
 * No model calls, no I/O, no storage. Everything is a synchronous unit test.
 */
import { describe, it, expect } from "vitest";
import {
  ELISION_MARKER,
  preprocessTraceToText,
  truncateToCharBudget,
  TRACE_PREPROCESSOR_DEFAULT_TOKEN_LIMIT,
  type TracePreprocessorSpan,
} from "../trace-preprocessor";

// ---------------------------------------------------------------------------
// Fixtures
// ---------------------------------------------------------------------------

const ROOT: TracePreprocessorSpan = {
  id: "root",
  parentId: null,
  name: "my-prompt",
  type: "SPAN",
  timestamp: "2026-06-29T10:00:00.000Z",
  input: "Hello",
  output: "Hi there",
};

const GEN_1: TracePreprocessorSpan = {
  id: "gen-1",
  parentId: "root",
  name: "llm-call",
  type: "GENERATION",
  timestamp: "2026-06-29T10:00:01.000Z",
  input: [{ role: "user", content: "Hello" }],
  output: { role: "assistant", content: "Hi there" },
};

const TOOL: TracePreprocessorSpan = {
  id: "tool-1",
  parentId: "gen-1",
  name: "get_weather",
  type: "TOOL",
  timestamp: "2026-06-29T10:00:02.000Z",
  input: { location: "SF" },
  output: { temp: 72 },
};

const GEN_2: TracePreprocessorSpan = {
  id: "gen-2",
  parentId: "root",
  name: "follow-up",
  type: "GENERATION",
  timestamp: "2026-06-29T10:00:03.000Z",
  input: "What next?",
  output: "Done.",
};

// ---------------------------------------------------------------------------
// 1. Structural / conversational order
// ---------------------------------------------------------------------------

describe("preprocessTraceToText — structural order", () => {
  it("renders root span before its children in depth-first order", () => {
    const text = preprocessTraceToText([ROOT, GEN_1, TOOL]);

    const rootIdx = text.indexOf("[SPAN — my-prompt]");
    const gen1Idx = text.indexOf("[GENERATION — llm-call]");
    const toolIdx = text.indexOf("[TOOL — get_weather]");

    expect(rootIdx).toBeGreaterThanOrEqual(0);
    expect(gen1Idx).toBeGreaterThan(rootIdx);
    expect(toolIdx).toBeGreaterThan(gen1Idx);
  });

  it("renders sibling spans in timestamp order, not array-insertion order", () => {
    // GEN_2 is inserted first in the array but has a later timestamp; GEN_1
    // has an earlier timestamp and should appear first in the output.
    const text = preprocessTraceToText([ROOT, GEN_2, GEN_1]);

    const gen1Idx = text.indexOf("[GENERATION — llm-call]");
    const gen2Idx = text.indexOf("[GENERATION — follow-up]");

    expect(gen1Idx).toBeGreaterThanOrEqual(0);
    expect(gen2Idx).toBeGreaterThan(gen1Idx);
  });

  it("includes input and output content of each span", () => {
    const text = preprocessTraceToText([GEN_1]);

    expect(text).toContain("Input:");
    expect(text).toContain("Output:");
    // Input is an array — rendered as JSON.
    expect(text).toContain('"role":"user"');
    // Output is an object — rendered as JSON.
    expect(text).toContain('"role":"assistant"');
  });

  it("unwraps a string-stored messages envelope to its content (ClickHouse row shape)", () => {
    // otel_traces stores turn I/O as the serialized OTLP messages array; the
    // model must see the words, not the `role`/`content` wire shape.
    const wrapped = {
      ...GEN_1,
      input: '[{"role":"user","content":"use @repo/api not the legacy client"}]',
    };
    const text = preprocessTraceToText([wrapped]);
    expect(text).toContain("use @repo/api not the legacy client");
    expect(text).not.toContain('"role":"user"');
  });

  it("indents child spans deeper than their parent", () => {
    const text = preprocessTraceToText([ROOT, GEN_1]);
    const lines = text.split("\n");

    const rootLine = lines.find((l) => l.includes("[SPAN — my-prompt]"))!;
    const genLine = lines.find((l) => l.includes("[GENERATION — llm-call]"))!;

    // Root is at column 0; child is indented (starts with spaces).
    expect(rootLine.startsWith("[")).toBe(true);
    expect(genLine.startsWith(" ")).toBe(true);
  });
});

// ---------------------------------------------------------------------------
// 2. Determinism
// ---------------------------------------------------------------------------

describe("preprocessTraceToText — determinism", () => {
  it("produces byte-identical output when called twice with the same input", () => {
    const spans = [ROOT, GEN_1, TOOL, GEN_2];
    const first = preprocessTraceToText(spans);
    const second = preprocessTraceToText(spans);
    expect(first).toBe(second);
  });

  it("does not inject timestamps, span ids, or random values into output", () => {
    const text = preprocessTraceToText([ROOT, GEN_1]);
    // These would break determinism if present.
    expect(text).not.toContain("root");        // span id
    expect(text).not.toContain("gen-1");       // span id
    expect(text).not.toContain("2026-06-29");  // timestamp
  });
});

// ---------------------------------------------------------------------------
// 3. Token-cap truncation
// ---------------------------------------------------------------------------

// proves AC-056-03
describe("preprocessTraceToText — truncation", () => {
  it("bounds output at the default cap and keeps head AND tail with the elision marker", () => {
    // Build a span whose content far exceeds the default cap; distinctive
    // beacons at both ends prove which parts survive.
    const bigSpan: TracePreprocessorSpan = {
      id: "big",
      parentId: null,
      type: "SPAN",
      input: "HEAD-BEACON " + "A".repeat(600_000) + " TAIL-BEACON",
    };

    const text = preprocessTraceToText([bigSpan]);

    expect(text.length).toBeLessThanOrEqual(
      TRACE_PREPROCESSOR_DEFAULT_TOKEN_LIMIT * 4,
    );
    expect(text).toContain("[middle of transcript elided]");
    // Head-only truncation blinded the model to how long sessions END —
    // for the issues facet the failure signal usually lives there.
    expect(text).toContain("HEAD-BEACON");
    expect(text).toContain("TAIL-BEACON");
  });

  it("honours a custom tokenLimit and splits the budget ~70/30 head/tail", () => {
    const span: TracePreprocessorSpan = {
      id: "s",
      parentId: null,
      type: "SPAN",
      input: "B".repeat(2_000),
    };

    const limit = 100; // 100 tokens × 4 chars = 400-char budget
    const text = preprocessTraceToText([span], { tokenLimit: limit });

    expect(text.length).toBeLessThanOrEqual(limit * 4);
    const [head, tail] = text.split("[middle of transcript elided]");
    expect(head!.length).toBeGreaterThan(tail!.length); // head keeps the larger share
    expect(tail!.length).toBeGreaterThan(0); // but the tail is never empty
  });

  it("does NOT truncate when content fits within the cap", () => {
    const text = preprocessTraceToText([ROOT], { tokenLimit: 1000 });

    expect(text).not.toContain("elided");
  });

  it("truncation is deterministic — same oversize input produces same truncated output", () => {
    const bigSpan: TracePreprocessorSpan = {
      id: "x",
      parentId: null,
      type: "SPAN",
      input: "C".repeat(300_000),
    };

    const a = preprocessTraceToText([bigSpan], { tokenLimit: 100 });
    const b = preprocessTraceToText([bigSpan], { tokenLimit: 100 });
    expect(a).toBe(b);
  });
});

// ---------------------------------------------------------------------------
// 4. Attachment stripping
// ---------------------------------------------------------------------------

// proves AC-056-03
describe("preprocessTraceToText — attachment stripping", () => {
  it("never renders blobRefs content", () => {
    const span: TracePreprocessorSpan = {
      id: "s",
      parentId: null,
      type: "SPAN",
      input: "normal input",
      blobRefs: ["blob://bucket/key1", "blob://bucket/key2"],
    };

    const text = preprocessTraceToText([span]);

    expect(text).toContain("normal input");
    expect(text).not.toContain("blob://");
    expect(text).not.toContain("blobRefs");
  });

  it("never renders metrics content", () => {
    const span: TracePreprocessorSpan = {
      id: "s",
      parentId: null,
      type: "SPAN",
      output: "normal output",
      metrics: { promptTokens: 100, completionTokens: 50, cost: 0.002 },
    };

    const text = preprocessTraceToText([span]);

    expect(text).toContain("normal output");
    expect(text).not.toContain("promptTokens");
    expect(text).not.toContain("completionTokens");
    expect(text).not.toContain("0.002");
  });
});

// ---------------------------------------------------------------------------
// 5. Robustness — malformed / edge inputs
// ---------------------------------------------------------------------------

describe("preprocessTraceToText — robustness", () => {
  it("returns empty string for an empty span list", () => {
    expect(preprocessTraceToText([])).toBe("");
  });

  it("renders a single root span without throwing", () => {
    const text = preprocessTraceToText([
      { id: "only", parentId: null, type: "SPAN", input: "x" },
    ]);
    expect(text).toContain("Input: x");
  });

  it("falls back to the first span as root when no span has !parentId", () => {
    // All spans have parentIds — none is a true root. The function should
    // still produce output rather than returning an empty string.
    const spans: TracePreprocessorSpan[] = [
      { id: "a", parentId: "orphan-parent", type: "SPAN", input: "fallback" },
    ];
    const text = preprocessTraceToText(spans);
    expect(text).toContain("fallback");
  });

  it("silently skips orphan spans (parentId points to a non-existent id)", () => {
    const spans: TracePreprocessorSpan[] = [
      { id: "root", parentId: null, type: "SPAN", input: "root-in" },
      { id: "orphan", parentId: "does-not-exist", type: "SPAN", input: "never" },
    ];
    const text = preprocessTraceToText(spans);
    expect(text).toContain("root-in");
    expect(text).not.toContain("never");
  });

  it("handles cyclic parentId references without throwing or looping", () => {
    const spans: TracePreprocessorSpan[] = [
      { id: "a", parentId: null, type: "SPAN", input: "root" },
      { id: "b", parentId: "a", type: "SPAN", input: "child" },
      { id: "a", parentId: "b", type: "SPAN", input: "cycle" }, // duplicate id "a"
    ];
    // If the function throws, the assignment itself fails the test — no
    // need for a bare .not.toThrow().
    const text = preprocessTraceToText(spans);
    // First "a" span is visited; second "a" is skipped by the cycle guard.
    expect(text).toContain("[SPAN]");
  });

  it("does not throw when input/output contain values that cannot be JSON-serialised", () => {
    const circular: Record<string, unknown> = {};
    circular["self"] = circular; // circular reference — JSON.stringify throws

    const span: TracePreprocessorSpan = {
      id: "s",
      parentId: null,
      type: "SPAN",
      input: circular,
    };

    // If it throws, the assignment fails the test.  The fallback path calls
    // String(value), which returns "[object Object]" for a plain circular ref.
    const text = preprocessTraceToText([span]);
    expect(text).toContain("Input:");
    expect(text).toContain("[object Object]");
  });

  it("renders spans without a name or type using a fallback label", () => {
    const span: TracePreprocessorSpan = {
      id: "s",
      parentId: null,
      output: "bare",
    };
    const text = preprocessTraceToText([span]);
    expect(text).toContain("[Span]");
    expect(text).toContain("bare");
  });
});

// ---------------------------------------------------------------------------
// truncateToCharBudget — exact boundary arithmetic (direct helper tests).
// ---------------------------------------------------------------------------

describe("truncateToCharBudget — exact split and surrogate boundaries", () => {
  const M = ELISION_MARKER;
  // budget = marker + 10 content chars → head keeps 7, tail keeps 3.
  const BUDGET = ELISION_MARKER.length + 10;
  const FILLER = "m".repeat(50); // pushes every fixture safely over budget

  it("returns the input untouched when length equals the budget exactly", () => {
    const text = "x".repeat(BUDGET);
    expect(truncateToCharBudget(text, BUDGET)).toBe(text);
  });

  it("splits an over-budget string into an exact head, marker, exact tail", () => {
    const text = "ABCDEFG" + FILLER + "XYZ";
    // Exact-string equality pins the 70/30 share arithmetic and both cuts.
    expect(truncateToCharBudget(text, BUDGET)).toBe("ABCDEFG" + M + "XYZ");
  });

  it("backs the HEAD cut up one unit when it would split a surrogate pair", () => {
    // The emoji occupies positions 6–7; the head cut at 7 would split it.
    const text = "ABCDEF\u{1F600}" + FILLER + "xyz";
    expect(truncateToCharBudget(text, BUDGET)).toBe("ABCDEF" + M + "xyz");
  });

  it("advances the TAIL cut one unit when it would start on a lone low surrogate", () => {
    // Tail cut lands on the emoji's LOW half — the orphan is skipped.
    const text = "ABCDEFG" + FILLER + "\u{1F600}YZ";
    expect(truncateToCharBudget(text, BUDGET)).toBe("ABCDEFG" + M + "YZ");
  });

  it("does NOT back up the head cut for a non-surrogate boundary character", () => {
    // \uD7FF sits just BELOW the high-surrogate range; the cut must stand.
    const text = "ABCDEF\uD7FF" + FILLER + "xyz";
    expect(truncateToCharBudget(text, BUDGET)).toBe("ABCDEF\uD7FF" + M + "xyz");
  });

  it("treats both edges of the high-surrogate range as pair starts at the head cut", () => {
    for (const high of ["\uD800", "\uDBFF"]) {
      const text = "ABCDEF" + high + "\uDC00" + FILLER + "xyz";
      expect(truncateToCharBudget(text, BUDGET)).toBe("ABCDEF" + M + "xyz");
    }
  });

  it("does NOT advance a tail cut that starts on a HIGH surrogate (only orphaned LOW halves)", () => {
    // Tail = [\uDBFF, \uDC00, Z] — starts on a high surrogate whose pair
    // follows; advancing here would orphan the pair instead of healing one.
    const text = "ABCDEFG" + FILLER + "\uDBFF\uDC00Z";
    expect(truncateToCharBudget(text, BUDGET)).toBe("ABCDEFG" + M + "\uDBFF\uDC00Z");
  });
});
