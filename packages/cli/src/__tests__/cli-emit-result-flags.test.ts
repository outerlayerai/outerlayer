// SPDX-License-Identifier: Apache-2.0
// Copyright 2026 Magu Studios, Inc.

/**
 * CLI argv surface for `emit <name>` (the check-result path).
 *
 * `emit` is one command with three faces: no operand runs the flat compile
 * action, the `artifact` operand dispatches to the artifact subcommand, and
 * any other operand is an emit NAME. These tests drive the real argv path
 * through commander into the runEmitResult seam — a wiring slip (operand
 * swallowed by compile, a flag not forwarded) would pass every unit test of
 * runEmitResult itself.
 */

import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { describe, expect, it, beforeEach, afterEach, vi } from "vitest";
import { runCli } from "../cli.js";
import { EmitResultError } from "../emit-result-cmd.js";

const runEmitResultMock = vi.hoisted(() => vi.fn());
vi.mock("../emit-result-cmd.js", async (importOriginal) => ({
  ...(await importOriginal<typeof import("../emit-result-cmd.js")>()),
  runEmitResult: runEmitResultMock,
}));

let root: string;

beforeEach(() => {
  root = mkdtempSync(join(tmpdir(), "ol-emitresflags-root-"));
  runEmitResultMock.mockReset();
  runEmitResultMock.mockResolvedValue({ data: {}, output: "", exitCode: 0 });
  process.exitCode = 0;
});
afterEach(() => {
  rmSync(root, { recursive: true, force: true });
  process.exitCode = 0;
  vi.restoreAllMocks();
});

describe("emit <name> argv surface", () => {
  it("dispatches a name operand to runEmitResult with the link flag", async () => {
    await runCli(["node", "outerlayer", "emit", "smoke.pass", "--link", "https://ci.example/run/1"]);

    expect(process.exitCode).toBe(0);
    expect(runEmitResultMock).toHaveBeenCalledTimes(1);
    expect(runEmitResultMock).toHaveBeenCalledWith({
      name: "smoke.pass",
      link: "https://ci.example/run/1",
      result: undefined,
      pr: undefined,
      json: undefined,
      url: undefined,
      apiKey: undefined,
      appId: undefined,
    });
  });

  it("forwards every result-path flag verbatim (pr stays the raw argv string)", async () => {
    await runCli([
      "node", "outerlayer", "emit", "migration.executed",
      "--link", "https://ci.example/run/2",
      "--result", "fail",
      "--pr", "12",
      "--json",
      "--url", "https://gw.example",
      "--api-key", "sk_x",
      "--app-id", "app-x",
    ]);

    expect(runEmitResultMock).toHaveBeenCalledWith({
      name: "migration.executed",
      link: "https://ci.example/run/2",
      result: "fail",
      pr: "12",
      json: true,
      url: "https://gw.example",
      apiKey: "sk_x",
      appId: "app-x",
    });
  });

  it("renders an EmitResultError as ✗ on stderr with exit 1", async () => {
    runEmitResultMock.mockRejectedValue(new EmitResultError("nothing to attach this to — no PR number"));
    const out = vi.spyOn(process.stdout, "write").mockImplementation(() => true);
    const err = vi.spyOn(process.stderr, "write").mockImplementation(() => true);

    await runCli(["node", "outerlayer", "emit", "smoke.pass", "--link", "https://ci.example/run/1"]);

    expect(process.exitCode).toBe(1);
    const stderrText = err.mock.calls.map((c) => String(c[0])).join("");
    expect(stderrText).toContain("nothing to attach this to — no PR number");
    expect(out).not.toHaveBeenCalled();
  });

  it("plain `emit` still runs the flat compile action — no name means no result path", async () => {
    const err = vi.spyOn(process.stderr, "write").mockImplementation(() => true);

    await runCli(["node", "outerlayer", "emit", "--dir", root]);

    expect(process.exitCode).toBe(1);
    const stderrText = err.mock.calls.map((c) => String(c[0])).join("");
    expect(stderrText).toContain("no .outerlayer/config.json");
    expect(runEmitResultMock).not.toHaveBeenCalled();
  });

  it("`emit --check` still runs the compile action in check mode", async () => {
    const err = vi.spyOn(process.stderr, "write").mockImplementation(() => true);

    await runCli(["node", "outerlayer", "emit", "--check", "--dir", root]);

    expect(process.exitCode).toBe(1);
    const stderrText = err.mock.calls.map((c) => String(c[0])).join("");
    expect(stderrText).toContain("no .outerlayer/config.json");
    expect(runEmitResultMock).not.toHaveBeenCalled();
  });

  it("`emit artifact <file>` still dispatches to the artifact subcommand, not the result path", async () => {
    const err = vi.spyOn(process.stderr, "write").mockImplementation(() => true);

    await runCli(["node", "outerlayer", "emit", "artifact", join(root, "missing.png"), "--caption", "x"]);

    expect(process.exitCode).toBe(1);
    const stderrText = err.mock.calls.map((c) => String(c[0])).join("");
    expect(stderrText).toContain("no such file");
    expect(runEmitResultMock).not.toHaveBeenCalled();
  });
});
