// SPDX-License-Identifier: Apache-2.0
// Copyright 2026 Magu Studios, Inc.

/**
 * The eval task schema.
 *
 * Field names deliberately mirror SWE-bench (`problem_statement`,
 * `test_patch`, `gold_patch`, `fail_to_pass`, `pass_to_pass`) — this file is
 * the would-be open standard, and familiarity is a feature.
 *
 * Refinements beyond the original sketch (no shrinks):
 * - `environment.runner` is explicit (`pytest` | `jest` | `vitest`) rather
 *   than inferred from `test_cmd` — test-id addressing differs per runner
 *   and guessing is how graders mis-run suites.
 * - `quarantined` carries evidence, written by the validation gate, and
 *   quarantined ids are excluded from grading everywhere.
 * - provenance/source enums (`statement_source`, `env_source`,
 *   `provenance`) let downstream stages stamp how a task came to be.
 */

import { z } from "zod";
import { parseUnifiedDiff } from "./diff.js";

export const TASK_SCHEMA_VERSION = 1;

export type RunnerId = "pytest" | "jest" | "vitest";

/** Test-id shape per runner: `<file path>::<test name>` (pytest allows
 * further `::` nesting for classes; jest/vitest names may contain spaces). */
const TEST_ID_PATTERNS: Record<RunnerId, RegExp> = {
  pytest: /^[^\s:][^:\n]*(::[^\n:][^\n:]*)+$/,
  jest: /^[^\n:]+\.[cm]?[jt]sx?::.+$/,
  vitest: /^[^\n:]+\.[cm]?[jt]sx?::.+$/,
};

const unifiedDiff = (label: string) =>
  z
    .string()
    .min(1, `${label} must be a non-empty unified diff`)
    .superRefine((value, ctx) => {
      const parsed = parseUnifiedDiff(value);
      if (!parsed.ok) {
        ctx.addIssue({ code: "custom", message: `${label}: ${parsed.error}` });
      }
    });

const environmentSchema = z
  .object({
    /** Provider-pullable image. Pin a tag (`python:3.12-bookworm`), ideally a digest. */
    base_image: z.string().min(1),
    /** Shell run once at env build (inside the sandbox, repo checked out). */
    setup: z.string().default(""),
    /** Base test invocation the runner adapter extends per test id. */
    test_cmd: z.string().min(1),
    runner: z.enum(["pytest", "jest", "vitest"]),
    /** Per-test timeout — a hung test fails the TEST, never the gate run. */
    timeout_s: z.number().int().positive().default(120),
    suite_timeout_s: z.number().int().positive().optional(),
  })
  .strict();

const quarantineEntrySchema = z
  .object({
    id: z.string().min(1),
    reason: z.string().min(1),
    /** e.g. "pass,fail,pass over 3 gate runs @ 2026-07-07" */
    evidence: z.string().default(""),
  })
  .strict();

export const evalTaskSchema = z
  .object({
    schema_version: z.number().int().default(TASK_SCHEMA_VERSION),
    id: z
      .string()
      .regex(/^[a-z0-9][a-z0-9._-]{2,127}$/, "id must be a lowercase slug"),
    /** Clone URL or path — the default env factory `git clone`s it. */
    repo: z.string().min(1),
    base_commit: z.string().min(1),
    problem_statement: z
      .string()
      .min(40, "problem_statement too short to attempt a fix from"),
    test_patch: unifiedDiff("test_patch"),
    gold_patch: unifiedDiff("gold_patch"),
    fail_to_pass: z.array(z.string().min(1)).min(1, "at least one fail_to_pass test id"),
    pass_to_pass: z.array(z.string().min(1)).default([]),
    environment: environmentSchema,
    quarantined: z.array(quarantineEntrySchema).default([]),
    statement_source: z.enum(["original", "rewritten"]).optional(),
    env_source: z.enum(["inferred", "hand-written", "repaired"]).optional(),
    env_confidence: z.enum(["high", "low"]).optional(),
    provenance: z.enum(["mined", "synthetic", "manual"]).optional(),
    /** Recorded by the gate so future runs replay identically. */
    determinism: z
      .object({
        image_digest: z.string().optional(),
        lockfile_hashes: z.record(z.string(), z.string()).optional(),
      })
      .strict()
      .optional(),
  })
  .strict()
  .superRefine((task, ctx) => {
    const pattern = TEST_ID_PATTERNS[task.environment.runner];
    for (const [field, ids] of [
      ["fail_to_pass", task.fail_to_pass],
      ["pass_to_pass", task.pass_to_pass],
    ] as const) {
      for (const id of ids) {
        if (!pattern.test(id)) {
          ctx.addIssue({
            code: "custom",
            message: `${field} id "${id}" is not a valid ${task.environment.runner} test id (expected <file>::<name>)`,
          });
        }
      }
    }
    const dupes = task.fail_to_pass.filter((id) => task.pass_to_pass.includes(id));
    if (dupes.length > 0) {
      ctx.addIssue({
        code: "custom",
        message: `test ids in both fail_to_pass and pass_to_pass: ${dupes.join(", ")}`,
      });
    }
  });

export type EvalTask = z.infer<typeof evalTaskSchema>;
export type TaskEnvironment = EvalTask["environment"];
export type QuarantineEntry = EvalTask["quarantined"][number];
