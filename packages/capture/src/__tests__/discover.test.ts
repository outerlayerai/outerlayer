// SPDX-License-Identifier: Apache-2.0
// Copyright 2026 Magu Studios, Inc.

/**
 * Transcript discovery identity contract.
 *
 * Every transcript under a `subagents/` ancestor must get its OWN id
 * (filename stem) and a parent link — its JSONL `sessionId` is inherited
 * from the parent, so treating one as a main session collides hundreds of
 * agents onto one id and the server's ReplacingMergeTree collapses them.
 * The regression this pins: Workflow-tool agents nest DEEPER than Task-tool
 * agents (`subagents/workflows/wf_<run>/agent-<hash>.jsonl`) and were missed by an
 * immediate-parent-dir check.
 */

import { mkdtempSync, mkdirSync, writeFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { describe, it, expect, beforeAll, afterAll } from "vitest";
import { findTranscripts } from "../adapters/claude-code/discover.js";

const PARENT_ID = "0af390d8-b5b8-4e30-81df-0b7f003fd206";
let root: string;

beforeAll(() => {
  root = mkdtempSync(join(tmpdir(), "discover-test-"));
  const project = join(root, "-Users-dev-repo");
  const sessionDir = join(project, PARENT_ID);
  mkdirSync(join(sessionDir, "subagents", "workflows", "wf_50d460aa-98f"), { recursive: true });

  // Main session transcript.
  writeFileSync(join(project, `${PARENT_ID}.jsonl`), '{"sessionId":"x"}\n');
  // Task-tool subagent (direct child of subagents/).
  writeFileSync(join(sessionDir, "subagents", "agent-task111111111.jsonl"), '{"sessionId":"x"}\n');
  // Workflow-tool agents (nested under subagents/workflows/wf_*/).
  writeFileSync(
    join(sessionDir, "subagents", "workflows", "wf_50d460aa-98f", "agent-wf2222222222.jsonl"),
    '{"sessionId":"x"}\n',
  );
  writeFileSync(
    join(sessionDir, "subagents", "workflows", "wf_50d460aa-98f", "agent-wf3333333333.jsonl"),
    '{"sessionId":"x"}\n',
  );
});

afterAll(() => {
  rmSync(root, { recursive: true, force: true });
});

describe("findTranscripts subagent identity", () => {
  it("assigns every subagents/-descendant transcript its own id and the parent link", () => {
    const entries = findTranscripts(root);
    const byStem = new Map(entries.map((e) => [e.file.split("/").pop(), e]));

    expect(entries).toHaveLength(4);

    const main = byStem.get(`${PARENT_ID}.jsonl`)!;
    expect(main.isSubagent).toBe(false);
    expect(main.ownId).toBeUndefined();
    expect(main.parentSessionId).toBeUndefined();

    const task = byStem.get("agent-task111111111.jsonl")!;
    expect(task.isSubagent).toBe(true);
    expect(task.ownId).toBe("agent-task111111111");
    expect(task.parentSessionId).toBe(PARENT_ID);

    for (const stem of ["agent-wf2222222222", "agent-wf3333333333"]) {
      const wf = byStem.get(`${stem}.jsonl`)!;
      expect(wf.isSubagent).toBe(true);
      expect(wf.ownId).toBe(stem);
      // Parent is the SESSION above subagents/, not the wf_* run dir.
      expect(wf.parentSessionId).toBe(PARENT_ID);
    }

    // The collision this guards: all four ids must be distinct.
    const ids = entries.map((e) => e.ownId ?? e.file.split("/").pop()!.replace(/\.jsonl$/, ""));
    expect(new Set(ids).size).toBe(4);
  });
});
