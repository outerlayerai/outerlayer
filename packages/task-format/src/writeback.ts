// SPDX-License-Identifier: Apache-2.0
// Copyright 2026 Magu Studios, Inc.

/**
 * Write-back of gate-produced facts into the task file.
 * Document-level YAML editing so comments, anchors, and field order survive;
 * a no-op (returns false) when the recorded block already matches — the
 * gate's idempotency acceptance box extends to file churn.
 */

import { readFile, writeFile } from "node:fs/promises";
import { parseDocument } from "yaml";
import type { TaskDeterminism } from "./report.js";

/** Key-order-insensitive structural equality over JSON-shaped values. */
function canonical(value: unknown): string {
  return JSON.stringify(value, (_key, node: unknown) =>
    node && typeof node === "object" && !Array.isArray(node)
      ? Object.fromEntries(Object.entries(node).sort(([a], [b]) => a.localeCompare(b)))
      : node,
  );
}

/** Record the gate's determinism block into a task file. Returns true when
 * the file changed. Callers pass paths of tasks that already loaded — a file
 * that cannot be parsed never gets here. */
export async function recordDeterminism(
  path: string,
  determinism: TaskDeterminism,
): Promise<boolean> {
  const source = await readFile(path, "utf8");
  const doc = parseDocument(source);
  const current = (doc.toJS() as { determinism?: unknown } | null)?.determinism;
  if (canonical(current) === canonical(determinism)) return false;
  doc.set("determinism", determinism);
  await writeFile(path, doc.toString());
  return true;
}
