import { classifyPublishValidation, classifyTree, type ValidationResult } from "@repo/context-core";

function fileStemOf(path: string): string {
  const base = path.split("/").pop() ?? path;
  return base.endsWith(".md") ? base.slice(0, -3) : base;
}

/**
 * Client-side two-tier validation for one draft, mirroring the save service's
 * per-file check (the server stays authoritative) so the commit dialog can tier
 * files before a round-trip. `errors` block the commit; `warnings` publish as-is
 * (empty description, other fixable field lints). An unclassified path is a hard
 * error. Both tiers come from the shared `classifyPublishValidation`, so client
 * and server never drift.
 */
export function validateDraftContent(path: string, content: string): ValidationResult {
  const entry = classifyTree([path]).entries[0];
  if (!entry) {
    return {
      ok: false,
      errors: [
        { path: "(path)", code: "unclassified_path", message: `"${path}" is not a recognized context file path` },
      ],
      warnings: [],
    };
  }

  return classifyPublishValidation(entry.kind, content, {
    dirName: entry.kind === "skill" ? entry.skillName : undefined,
    fileStem: entry.kind === "subagent" ? fileStemOf(path) : undefined,
  });
}
