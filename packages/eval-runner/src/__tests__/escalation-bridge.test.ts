// SPDX-License-Identifier: Apache-2.0
// Copyright 2026 Magu Studios, Inc.

import { describe, expect, test } from "vitest";
import type { EscalationItem } from "@outerlayer/env-prep";
import {
  envEscalationAlert,
  envEscalationRow,
  persistingEscalationSink,
  type EnvEscalationRow,
} from "../escalation-bridge.js";

const ITEM: EscalationItem = {
  repo: "https://github.com/acme/widget.git",
  baseCommit: "abc1234",
  taskIds: ["task-1", "task-2"],
  lastErrors: [
    { stage: "deterministic", excerpt: "pip: no matching distribution", setup: "pip install -e ." },
    { stage: "repair-1", excerpt: "apt: libfoo not found", setup: "apt-get install libfoo && pip install -e ." },
  ],
  attempts: 3,
  costUsd: 1.25,
  suggestedNextSteps: "Pin libfoo in the base image or descope the repo.",
  createdAt: "2026-07-10T18:00:00.000Z",
};

const CTX = { tenantId: "tenant-456", appId: "app-123", evalRunId: "run-789" };

describe("envEscalationRow", () => {
  test("maps the EscalationItem field-for-field onto the snake_case row", () => {
    expect(envEscalationRow(ITEM, CTX)).toEqual({
      tenant_id: "tenant-456",
      app_id: "app-123",
      eval_run_id: "run-789",
      repo: "https://github.com/acme/widget.git",
      base_commit: "abc1234",
      task_ids: ["task-1", "task-2"],
      last_errors: [
        { stage: "deterministic", excerpt: "pip: no matching distribution", setup: "pip install -e ." },
        { stage: "repair-1", excerpt: "apt: libfoo not found", setup: "apt-get install libfoo && pip install -e ." },
      ],
      attempts: 3,
      cost_usd: 1.25,
      suggested_next_steps: "Pin libfoo in the base image or descope the repo.",
    });
  });

  test("no run context ⇒ eval_run_id null (not undefined — the column is nullable)", () => {
    const row = envEscalationRow(ITEM, { tenantId: "t", appId: "a" });
    expect(row.eval_run_id).toBeNull();
  });
});

describe("envEscalationAlert", () => {
  test("carries the exact _alert/_metric fields the log-based alerting matches on", () => {
    expect(envEscalationAlert(ITEM, CTX)).toEqual({
      _alert: true,
      severity: "warning",
      alert_type: "env_escalation",
      _metric: true,
      metric_name: "evals.env_escalation",
      metric_value: 1,
      tenantId: "tenant-456",
      appId: "app-123",
      evalRunId: "run-789",
      repo: "https://github.com/acme/widget.git",
      baseCommit: "abc1234",
      taskCount: 2,
      attempts: 3,
      costUsd: 1.25,
      suggestedNextSteps: "Pin libfoo in the base image or descope the repo.",
    });
  });
});

describe("persistingEscalationSink", () => {
  test("persists the row, then emits the alert line", async () => {
    const rows: EnvEscalationRow[] = [];
    const lines: string[] = [];
    const sink = persistingEscalationSink(CTX, async (row) => {
      rows.push(row);
    }, (line) => lines.push(line));

    await sink.report(ITEM);

    expect(rows).toEqual([envEscalationRow(ITEM, CTX)]);
    expect(lines).toEqual([
      `[escalation] env escalation ${JSON.stringify(envEscalationAlert(ITEM, CTX))}`,
    ]);
  });

  test("a queue-write failure never throws — the alert still fires, the failure is logged", async () => {
    const lines: string[] = [];
    const sink = persistingEscalationSink(
      CTX,
      async () => {
        throw new Error("supabase down");
      },
      (line) => lines.push(line),
    );

    await expect(sink.report(ITEM)).resolves.toBeUndefined();
    expect(lines).toEqual([
      "[escalation] env_escalation insert failed (queue write only — the alert below still fires): supabase down",
      `[escalation] env escalation ${JSON.stringify(envEscalationAlert(ITEM, CTX))}`,
    ]);
  });
});
