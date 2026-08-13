// SPDX-License-Identifier: Apache-2.0
// Copyright 2026 Magu Studios, Inc.

import { describe, expect, it, vi } from "vitest";
import type { DaemonLogEvent } from "@outerlayer/capture";
import { makeWatchLogHandler, type StatuslineNotifier } from "../watch.js";

function counterStatusline(): { notifier: StatuslineNotifier; count: () => number } {
  let n = 0;
  return {
    notifier: {
      notifyChange: () => {
        n += 1;
      },
    },
    count: () => n,
  };
}

describe("makeWatchLogHandler", () => {
  it("mirrored: writes a stdout line AND notifies the aggregator", () => {
    const { notifier, count } = counterStatusline();
    const stdoutLines: string[] = [];
    const stderrLines: string[] = [];
    const handler = makeWatchLogHandler(notifier, (s) => stdoutLines.push(s), (s) => stderrLines.push(s));
    const event: DaemonLogEvent = { type: "mirrored", file: "/raw/session-1.jsonl" };
    handler(event);
    expect(stdoutLines).toEqual(["mirrored /raw/session-1.jsonl\n"]);
    expect(stderrLines).toEqual([]);
    expect(count()).toBe(1);
  });

  it("rescan: notifies the aggregator, writes NOTHING to stdout or stderr", () => {
    const { notifier, count } = counterStatusline();
    const stdoutLines: string[] = [];
    const stderrLines: string[] = [];
    const handler = makeWatchLogHandler(notifier, (s) => stdoutLines.push(s), (s) => stderrLines.push(s));
    handler({ type: "rescan" });
    expect(stdoutLines).toEqual([]);
    expect(stderrLines).toEqual([]);
    expect(count()).toBe(1);
  });

  it("evicted: writes a stdout line, does NOT notify the aggregator", () => {
    const { notifier, count } = counterStatusline();
    const stdoutLines: string[] = [];
    const handler = makeWatchLogHandler(notifier, (s) => stdoutLines.push(s), () => {});
    handler({ type: "evicted", file: "/raw/old-session.jsonl" });
    expect(stdoutLines).toEqual(["evicted /raw/old-session.jsonl\n"]);
    expect(count()).toBe(0);
  });

  it("error: writes to STDERR (not stdout) with file and detail, does NOT notify the aggregator", () => {
    const { notifier, count } = counterStatusline();
    const stdoutLines: string[] = [];
    const stderrLines: string[] = [];
    const handler = makeWatchLogHandler(notifier, (s) => stdoutLines.push(s), (s) => stderrLines.push(s));
    handler({ type: "error", file: "/raw/broken.jsonl", detail: "EACCES" });
    expect(stdoutLines).toEqual([]);
    expect(stderrLines).toEqual(["error /raw/broken.jsonl: EACCES\n"]);
    expect(count()).toBe(0);
  });

  it("started/stopped daemon lifecycle events produce no output and no notification", () => {
    const { notifier, count } = counterStatusline();
    const stdoutLines: string[] = [];
    const stderrLines: string[] = [];
    const handler = makeWatchLogHandler(notifier, (s) => stdoutLines.push(s), (s) => stderrLines.push(s));
    handler({ type: "started" });
    handler({ type: "stopped" });
    expect(stdoutLines).toEqual([]);
    expect(stderrLines).toEqual([]);
    expect(count()).toBe(0);
  });

  it("defaults to the real process.stdout when no stdout sink is injected", () => {
    const { notifier, count } = counterStatusline();
    const outSpy = vi.spyOn(process.stdout, "write").mockImplementation(() => true);
    const errSpy = vi.spyOn(process.stderr, "write").mockImplementation(() => true);
    try {
      const handler = makeWatchLogHandler(notifier);
      handler({ type: "mirrored", file: "/raw/s.jsonl" });
      expect(outSpy).toHaveBeenCalledWith("mirrored /raw/s.jsonl\n");
      expect(errSpy).not.toHaveBeenCalled();
      expect(count()).toBe(1);
    } finally {
      outSpy.mockRestore();
      errSpy.mockRestore();
    }
  });

  it("defaults to the real process.stderr when no stderr sink is injected", () => {
    const { notifier } = counterStatusline();
    const outSpy = vi.spyOn(process.stdout, "write").mockImplementation(() => true);
    const errSpy = vi.spyOn(process.stderr, "write").mockImplementation(() => true);
    try {
      const handler = makeWatchLogHandler(notifier);
      handler({ type: "error", file: "/raw/broken.jsonl", detail: "EACCES" });
      expect(errSpy).toHaveBeenCalledWith("error /raw/broken.jsonl: EACCES\n");
      expect(outSpy).not.toHaveBeenCalled();
    } finally {
      outSpy.mockRestore();
      errSpy.mockRestore();
    }
  });
});
