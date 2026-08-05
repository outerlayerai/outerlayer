// SPDX-License-Identifier: Apache-2.0
// Copyright 2026 Magu Studios, Inc.

/**
 * Minimal unified-diff inspection — enough to (a) reject malformed patches at
 * load time and (b) know which files a patch touches for the overlap lint.
 * Application is always `git apply` inside a sandbox; this parser never
 * mutates anything.
 */

export interface ParsedPatch {
  ok: boolean;
  error?: string;
  /** Paths touched (new-side path for adds/modifies, old-side for deletes). */
  files: string[];
  /** Every `+` content line (without the leading `+`). */
  addedLines: string[];
}

const NULL_PATH = "/dev/null";

function stripPrefix(path: string): string {
  return path.replace(/^[ab]\//, "");
}

export function parseUnifiedDiff(patch: string): ParsedPatch {
  const files = new Set<string>();
  const addedLines: string[] = [];
  let sawHunk = false;
  let oldPath: string | null = null;

  const lines = patch.split("\n");
  for (const line of lines) {
    if (line.startsWith("--- ")) {
      oldPath = line.slice(4).trim();
      continue;
    }
    if (line.startsWith("+++ ")) {
      const newPath = line.slice(4).trim();
      if (newPath !== NULL_PATH) {
        files.add(stripPrefix(newPath));
      } else if (oldPath && oldPath !== NULL_PATH) {
        files.add(stripPrefix(oldPath)); // deletion — attribute to old side
      }
      oldPath = null;
      continue;
    }
    if (line.startsWith("@@")) {
      if (!/^@@ -\d+(,\d+)? \+\d+(,\d+)? @@/.test(line)) {
        return { ok: false, error: `malformed hunk header: ${line.slice(0, 60)}`, files: [], addedLines: [] };
      }
      sawHunk = true;
      continue;
    }
    if (sawHunk && line.startsWith("+")) {
      addedLines.push(line.slice(1));
    }
  }

  if (files.size === 0 || !sawHunk) {
    return {
      ok: false,
      error: "not a unified diff (no file headers or no hunks)",
      files: [],
      addedLines: [],
    };
  }
  return { ok: true, files: [...files].sort(), addedLines };
}
