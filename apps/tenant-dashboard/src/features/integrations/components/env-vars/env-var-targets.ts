import {
  ENV_TARGET_KINDS,
  ENV_VAR_TARGET_KINDS,
  type EnvVarTargetKind,
} from "@repo/env-kind";
import type { EnvVarScope } from "../../types";

/**
 * A selectable target in the add form: 'all' or one of the three kinds, plus
 * 'env' meaning "this specific environment" (a per-env override of the kinds).
 */
export type EnvVarTargetChoice = "all" | EnvVarTargetKind | "env";

/** Display labels for the kind targets (Production == the 'promoted' kind). */
export const KIND_TARGET_LABELS: Record<"all" | EnvVarTargetKind, string> = {
  all: "All Environments",
  development: "Development",
  preview: "Preview",
  promoted: "Production",
};

/** The kind choices offered in the picker, in display order. Sourced from the
 *  canonical @repo/env-kind list so a new kind can't be silently omitted. */
export const KIND_CHOICES: ReadonlyArray<"all" | EnvVarTargetKind> =
  ENV_VAR_TARGET_KINDS;

/** Label for a stored row's scope (the env-name map resolves specific rows). */
export function envVarRowTargetLabel(
  row: { target_kind: string | null; environment_id: string | null },
  envNames: Record<string, string>,
): string {
  if (row.target_kind) {
    return (
      KIND_TARGET_LABELS[row.target_kind as "all" | EnvVarTargetKind] ??
      row.target_kind
    );
  }
  if (row.environment_id) {
    return envNames[row.environment_id] ?? "Environment";
  }
  return "—";
}

/**
 * Build the EnvVarScope list to write from a picker selection. 'all' is
 * exclusive of the individual kinds (it is a single row that matches every
 * env, so emitting it alongside a kind row would be redundant); 'env' adds a
 * specific-environment override for the current env.
 */
export function scopesFromChoices(
  choices: Iterable<EnvVarTargetChoice>,
  currentEnvId: string,
): EnvVarScope[] {
  const set = new Set(choices);
  const scopes: EnvVarScope[] = [];
  if (set.has("all")) {
    scopes.push({ targetKind: "all" });
  } else {
    for (const k of ENV_TARGET_KINDS) {
      if (set.has(k)) scopes.push({ targetKind: k });
    }
  }
  if (set.has("env")) scopes.push({ environmentId: currentEnvId });
  return scopes;
}
