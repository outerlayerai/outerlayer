import { describe, it, expect } from "vitest";
import { NoOpAdapter, type ErrorReportingAdapter } from "../adapter";

describe("NoOpAdapter", () => {
  const adapter: ErrorReportingAdapter = new NoOpAdapter();

  it("returns void from every method (no value escapes the no-op)", () => {
    const results = [
      adapter.captureException(new Error("boom"), {
        tags: { component: "test" },
        extra: { detail: 1 },
      }),
      adapter.captureMessage("hi", { tags: { a: 1 } }),
      adapter.setUser({ id: "u1", email: "u@example.com" }),
      adapter.setUser(null),
      adapter.setContext("ctx", { k: "v" }),
      adapter.setContext("ctx", null),
      adapter.setTag("env", "prod"),
    ];
    expect(results).toEqual([
      undefined,
      undefined,
      undefined,
      undefined,
      undefined,
      undefined,
      undefined,
    ]);
  });

  it("swallows a non-Error thrown value, still returning void", () => {
    expect(adapter.captureException("string failure")).toBeUndefined();
    expect(adapter.captureException(undefined)).toBeUndefined();
  });

  it("satisfies the ErrorReportingAdapter contract surface", () => {
    const methods: Array<keyof ErrorReportingAdapter> = [
      "captureException",
      "captureMessage",
      "setUser",
      "setContext",
      "setTag",
    ];
    for (const method of methods) {
      expect(typeof adapter[method]).toBe("function");
    }
  });
});
