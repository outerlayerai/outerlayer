/**
 * Behavior locked here:
 *   - NodeLogger emits ONE structured JSON line per entry, merging the
 *     logger's context with the per-call metadata, routed to the right
 *     console stream per level.
 *   - error() carries message + stack.
 *   - flush() resolves (no-op).
 */
import { afterEach, describe, expect, it, vi } from "vitest";
import { NodeLogger } from "./node-logger";

afterEach(() => vi.restoreAllMocks());

describe("NodeLogger", () => {
  it("emits merged context + metadata as JSON on console.log for info", () => {
    const log = vi.spyOn(console, "log").mockImplementation(() => {});
    const logger = new NodeLogger().createLogger({ tenantId: "t1", source: "http" });

    logger.info("hello", { requestId: "r1" });

    expect(log).toHaveBeenCalledTimes(1);
    expect(JSON.parse(log.mock.calls[0]![0] as string)).toEqual({
      level: "info",
      message: "hello",
      tenantId: "t1",
      source: "http",
      requestId: "r1",
    });
  });

  it("routes warn to console.warn", () => {
    const warn = vi.spyOn(console, "warn").mockImplementation(() => {});
    new NodeLogger().createLogger().warn("careful");
    expect(JSON.parse(warn.mock.calls[0]![0] as string)).toMatchObject({
      level: "warn",
      message: "careful",
    });
  });

  it("routes error to console.error with message + stack", () => {
    const err = vi.spyOn(console, "error").mockImplementation(() => {});
    const error = new Error("boom");
    new NodeLogger().createLogger({ tenantId: "t2" }).error(error, { op: "x" });

    const entry = JSON.parse(err.mock.calls[0]![0] as string);
    expect(entry).toMatchObject({ level: "error", message: "boom", tenantId: "t2", op: "x" });
    expect(entry.stack).toContain("boom");
  });

  it("flush resolves without emitting anything", async () => {
    const log = vi.spyOn(console, "log").mockImplementation(() => {});
    await expect(new NodeLogger().createLogger().flush()).resolves.toBeUndefined();
    expect(log).not.toHaveBeenCalled();
  });
});
