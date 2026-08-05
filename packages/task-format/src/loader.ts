// SPDX-License-Identifier: Apache-2.0
// Copyright 2026 Magu Studios, Inc.

/**
 * YAML → EvalTask. Anchors/aliases are allowed (they're how hand-written
 * task sets share environment blocks); schema violations come back as a
 * structured error, never a throw — a broken task file is a *report entry*,
 * not a crashed validate run.
 */

import { readFile, readdir } from "node:fs/promises";
import { join } from "node:path";
import { parse as parseYaml } from "yaml";
import { evalTaskSchema, type EvalTask } from "./schema.js";

export type LoadResult =
  | { ok: true; task: EvalTask; path?: string }
  | { ok: false; error: string; path?: string; taskId?: string };

export function parseTask(source: string, path?: string): LoadResult {
  let raw: unknown;
  try {
    raw = parseYaml(source);
  } catch (error) {
    return {
      ok: false,
      path,
      error: `YAML parse error: ${error instanceof Error ? error.message : String(error)}`,
    };
  }
  const parsed = evalTaskSchema.safeParse(raw);
  if (!parsed.success) {
    const taskId =
      typeof raw === "object" && raw !== null && "id" in raw && typeof raw.id === "string"
        ? raw.id
        : undefined;
    const issues = parsed.error.issues
      .map((issue) => `${issue.path.join(".") || "<root>"}: ${issue.message}`)
      .join("; ");
    return { ok: false, path, taskId, error: issues };
  }
  return { ok: true, path, task: parsed.data };
}

export async function loadTaskFile(path: string): Promise<LoadResult> {
  try {
    return parseTask(await readFile(path, "utf8"), path);
  } catch (error) {
    return {
      ok: false,
      path,
      error: `read failed: ${error instanceof Error ? error.message : String(error)}`,
    };
  }
}

/** Load every `*.yaml`/`*.yml` under a directory (the `.outerlayer/evals/` layout). */
export async function loadTaskDir(dir: string): Promise<LoadResult[]> {
  const entries = await readdir(dir, { withFileTypes: true });
  const files = entries
    .filter((entry) => entry.isFile() && /\.ya?ml$/.test(entry.name))
    .map((entry) => join(dir, entry.name))
    .sort();
  return Promise.all(files.map((file) => loadTaskFile(file)));
}
